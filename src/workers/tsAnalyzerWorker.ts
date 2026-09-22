type WorkerMessage =
  | { type: 'init' }
  | { type: 'analyze'; file: File }

type ProbeStream = {
  index: number
  codec_type: string
  codec_name?: string
  codec_long_name?: string
  profile?: string
  level?: number | string
  width?: number
  height?: number
  sample_rate?: string
  channels?: number
  time_base?: string
  start_time?: string
  duration?: string
  bit_rate?: string
  tags?: Record<string, string>
  extradata?: string
  extradata_size?: number
  sps?: string[]
  pps?: string[]
  vps?: string[]
  headerSummary?: string
  headers?: HeaderEvent[]
  spsInfo?: SpsInfo[]
}

type HeaderEvent = {
  kind: 'sps' | 'pps' | 'vps' | 'slice'
  pid: number
  packetIndex: number
  nalType: number
  offset: number
  label: string
  packetType: string
}

type SpsInfo = {
  pid: number
  packetIndex: number
  nalType: number
  fields: Array<{ label: string; value: string | number | boolean }>
}

type ProbeResult = {
  format?: Record<string, string>
  streams: ProbeStream[]
  chapters: Array<Record<string, string>>
  raw: string
  parsedJson?: unknown
  fileName: string
  fileSize: number
  mimeType: string
  error?: string
}

const TS_PACKET_SIZE = 188
const PREVIEW_LIMIT = 512 * 1024

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data
  if (msg.type === 'init') {
    self.postMessage({ type: 'ready' })
    return
  }
  try {
    const result = await analyzeFile(msg.file)
    self.postMessage({ type: 'result', payload: result })
  } catch (error) {
    self.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'Analysis failed' })
  }
}

async function analyzeFile(file: File): Promise<ProbeResult> {
  const buffer = await file.arrayBuffer()
  const data = new Uint8Array(buffer)
  const parsed = scanTransportStream(data)
  const raw = JSON.stringify(parsed, null, 2)
  return {
    ...parsed,
    raw,
    parsedJson: parsed,
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type,
  }
}

function scanTransportStream(data: Uint8Array): Omit<ProbeResult, 'raw' | 'parsedJson' | 'fileName' | 'fileSize' | 'mimeType'> {
  const packetCount = Math.floor(data.length / TS_PACKET_SIZE)
  const streamsByPid = new Map<number, ProbeStream & { pid: number }>()
  const patPrograms = new Map<number, number>()
  const pmtPids = new Set<number>()
  let packetsSeen = 0

  const limit = Math.min(packetCount, Math.floor(PREVIEW_LIMIT / TS_PACKET_SIZE))
  for (let packetIndex = 0; packetIndex < limit; packetIndex++) {
    const offset = packetIndex * TS_PACKET_SIZE
    if (data[offset] !== 0x47) continue
    packetsSeen += 1

    const payloadStart = (data[offset + 1] & 0x40) !== 0
    const pid = ((data[offset + 1] & 0x1f) << 8) | data[offset + 2]
    const adaptationControl = (data[offset + 3] >> 4) & 0x3
    let cursor = offset + 4
    if (adaptationControl === 2 || adaptationControl === 3) {
      const adaptationLength = data[cursor]
      cursor += 1 + adaptationLength
    }
    if (cursor >= offset + TS_PACKET_SIZE) continue

    if (pid === 0) {
      if (!payloadStart) continue
      const pointerField = data[cursor]
      const sectionStart = cursor + 1 + pointerField
      parsePatSection(data.subarray(sectionStart, offset + TS_PACKET_SIZE), patPrograms)
      for (const pmtPid of patPrograms.values()) pmtPids.add(pmtPid)
      continue
    }

    if (pmtPids.has(pid) && payloadStart) {
      const pointerField = data[cursor]
      const sectionStart = cursor + 1 + pointerField
      parsePmtSection(data.subarray(sectionStart, offset + TS_PACKET_SIZE), streamsByPid)
      continue
    }

    const stream = streamsByPid.get(pid)
    if (stream) {
      const payload = data.subarray(cursor, offset + TS_PACKET_SIZE)
      extractNalHeaders(payload, stream, pid, packetIndex)
    }
  }

  const streams = [...streamsByPid.values()]
    .map((stream, index) => ({
      ...stream,
      index,
      headerSummary: summarizeHeaders(stream),
    }))
    .sort((a, b) => a.index - b.index)

  const format = {
    format_name: 'MPEG-TS',
    nb_streams: String(streams.length),
    packet_count: String(packetsSeen),
    preview_packets: String(limit),
    pmt_count: String(pmtPids.size),
  }

  const chapters: Array<Record<string, string>> = []
  return { format, streams, chapters }
}

function parsePatSection(section: Uint8Array, patPrograms: Map<number, number>) {
  if (section.length < 8 || section[0] !== 0x00) return
  const sectionLength = ((section[1] & 0x0f) << 8) | section[2]
  const end = Math.min(section.length, sectionLength + 3)
  for (let i = 8; i + 4 <= end - 4; i += 4) {
    const programNumber = (section[i] << 8) | section[i + 1]
    const pid = ((section[i + 2] & 0x1f) << 8) | section[i + 3]
    if (programNumber !== 0) patPrograms.set(programNumber, pid)
  }
}

function parsePmtSection(section: Uint8Array, streamsByPid: Map<number, ProbeStream & { pid: number }>) {
  if (section.length < 12 || section[0] !== 0x02) return
  const sectionLength = ((section[1] & 0x0f) << 8) | section[2]
  const programInfoLength = ((section[10] & 0x0f) << 8) | section[11]
  let i = 12 + programInfoLength
  const end = Math.min(section.length, sectionLength + 3 - 4)
  while (i + 5 < end) {
    const streamType = section[i]
    const elementaryPid = ((section[i + 1] & 0x1f) << 8) | section[i + 2]
    const esInfoLength = ((section[i + 3] & 0x0f) << 8) | section[i + 4]
    const stream = streamsByPid.get(elementaryPid) ?? ({ pid: elementaryPid, index: elementaryPid, codec_type: 'unknown' } as ProbeStream & { pid: number })
    stream.codec_type = streamTypeToName(streamType)
    stream.codec_name = streamTypeToCodec(streamType)
    stream.codec_long_name = stream.codec_name
    stream.headers ??= []
    if (stream.codec_type === 'video') {
      stream.width ??= undefined
      stream.height ??= undefined
    }
    streamsByPid.set(elementaryPid, stream)
    i += 5 + esInfoLength
  }
}

function streamTypeToName(streamType: number): string {
  if (streamType === 0x1b || streamType === 0x24 || streamType === 0x02 || streamType === 0x10) return 'video'
  if (streamType === 0x0f || streamType === 0x03 || streamType === 0x04 || streamType === 0x11) return 'audio'
  if (streamType === 0x06) return 'data'
  return 'unknown'
}

function streamTypeToCodec(streamType: number): string {
  switch (streamType) {
    case 0x1b:
      return 'h264'
    case 0x24:
      return 'hevc'
    case 0x0f:
      return 'aac'
    case 0x03:
    case 0x04:
      return 'mp2'
    default:
      return `stream_type_0x${streamType.toString(16)}`
  }
}

function summarizeHeaders(stream: ProbeStream) {
  if (stream.codec_type === 'video') {
    const counts = {
      sps: stream.headers?.filter((h) => h.kind === 'sps').length ?? 0,
      pps: stream.headers?.filter((h) => h.kind === 'pps').length ?? 0,
      vps: stream.headers?.filter((h) => h.kind === 'vps').length ?? 0,
      slice: stream.headers?.filter((h) => h.kind === 'slice').length ?? 0,
    }
    return `SPS:${counts.sps} PPS:${counts.pps} VPS:${counts.vps} slices:${counts.slice}`
  }
  return 'N/A'
}

function extractNalHeaders(payload: Uint8Array, stream: ProbeStream & { pid: number }, pid: number, packetIndex: number) {
  for (const nal of findNalUnits(payload)) {
    const nalType = nal.nalType
    const kind = classifyNal(stream.codec_name, nalType)
    if (!kind) continue
    stream.headers ??= []
    stream.headers.push({
      kind,
      pid,
      packetIndex,
      nalType,
      offset: nal.offset,
      label: nalLabel(stream.codec_name, nalType),
      packetType: headerPacketType(stream.codec_name, kind, nalType),
    })
    if (kind === 'sps') {
      stream.sps ??= [toHex(nal.payload)]
      stream.spsInfo ??= []
      const parsed = parseH264Sps(nal.payload)
      if (parsed) {
        stream.spsInfo.push({
          pid,
          packetIndex,
          nalType,
          fields: parsed,
        })
      }
    }
    if (kind === 'pps' && !stream.pps) stream.pps = [toHex(nal.payload)]
    if (kind === 'vps' && !stream.vps) stream.vps = [toHex(nal.payload)]
  }
}

function findNalUnits(payload: Uint8Array): Array<{ offset: number; nalType: number; payload: Uint8Array }> {
  const units: Array<{ offset: number; nalType: number; payload: Uint8Array }> = []
  let i = 0
  while (i + 4 < payload.length) {
    const start = findStartCode(payload, i)
    if (start === -1) break
    const next = findStartCode(payload, start + 3)
    const nalStart = start + (payload[start + 2] === 1 ? 3 : 4)
    const nalEnd = next === -1 ? payload.length : next
    if (nalStart < nalEnd) {
      const nalType = payload[nalStart] & 0x1f
      units.push({ offset: nalStart, nalType, payload: payload.subarray(nalStart, nalEnd) })
    }
    i = next === -1 ? payload.length : next
  }
  return units
}

function findStartCode(payload: Uint8Array, from: number): number {
  for (let i = from; i + 3 <= payload.length; i++) {
    if (payload[i] === 0x00 && payload[i + 1] === 0x00 && payload[i + 2] === 0x01) return i
    if (i + 4 <= payload.length && payload[i] === 0x00 && payload[i + 1] === 0x00 && payload[i + 2] === 0x00 && payload[i + 3] === 0x01) return i
  }
  return -1
}

function classifyNal(codecName: string | undefined, nalType: number): HeaderEvent['kind'] | null {
  const codec = codecName?.toLowerCase() ?? ''
  if (codec.includes('h264') || codec.includes('avc') || codec.includes('h.264')) {
    if (nalType === 7) return 'sps'
    if (nalType === 8) return 'pps'
    if (nalType === 5 || nalType === 1) return 'slice'
    return null
  }
  if (codec.includes('hevc') || codec.includes('h265') || codec.includes('h.265') || codec.includes('hvc')) {
    const hevcNalType = (nalType >> 1) & 0x3f
    if (hevcNalType === 33) return 'sps'
    if (hevcNalType === 34) return 'pps'
    if (hevcNalType >= 0 && hevcNalType <= 31) return 'slice'
    if (hevcNalType === 32) return 'vps'
    return null
  }
  return null
}

function nalLabel(codecName: string | undefined, nalType: number): string {
  const codec = codecName?.toLowerCase() ?? ''
  if (codec.includes('hevc') || codec.includes('h265') || codec.includes('hvc')) {
    const hevcNalType = (nalType >> 1) & 0x3f
    return `NAL ${hevcNalType}`
  }
  return `NAL ${nalType}`
}

function headerPacketType(codecName: string | undefined, kind: HeaderEvent['kind'], nalType: number): string {
  const codec = codecName?.toLowerCase() ?? ''
  if (codec.includes('hevc') || codec.includes('h265') || codec.includes('hvc')) {
    if (kind === 'sps') return 'HEVC SPS'
    if (kind === 'pps') return 'HEVC PPS'
    if (kind === 'vps') return 'HEVC VPS'
    if (kind === 'slice') return nalType === 19 ? 'HEVC IDR Slice' : 'HEVC Slice Header'
  }
  if (codec.includes('h264') || codec.includes('avc') || codec.includes('h.264')) {
    if (kind === 'sps') return 'H.264 SPS'
    if (kind === 'pps') return 'H.264 PPS'
    if (kind === 'slice') return nalType === 5 ? 'H.264 IDR Slice' : 'H.264 Slice Header'
  }
  if (codec.includes('aac')) return 'AAC raw_data_block'
  return `${kind.toUpperCase()} packet`
}

function toHex(bytes: Uint8Array): string {
  return [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

function parseH264Sps(nal: Uint8Array): Array<{ label: string; value: string | number | boolean }> | null {
  const rbsp = removeEmulationPreventionBytes(nal.subarray(1))
  const bits = new BitReader(rbsp)
  try {
    const profileIdc = bits.readBits(8)
    bits.readBits(8) // constraint flags + reserved
    const levelIdc = bits.readBits(8)
    const seqParameterSetId = bits.readUE()
    const fields: Array<{ label: string; value: string | number | boolean }> = [
      { label: 'profile_idc', value: profileIdc },
      { label: 'level_idc', value: levelIdc },
      { label: 'seq_parameter_set_id', value: seqParameterSetId },
    ]
    const highProfiles = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134])
    if (highProfiles.has(profileIdc)) {
      const chromaFormatIdc = bits.readUE()
      fields.push({ label: 'chroma_format_idc', value: chromaFormatIdc })
      if (chromaFormatIdc === 3) fields.push({ label: 'separate_colour_plane_flag', value: bits.readBits(1) === 1 })
      fields.push({ label: 'bit_depth_luma_minus8', value: bits.readUE() })
      fields.push({ label: 'bit_depth_chroma_minus8', value: bits.readUE() })
      fields.push({ label: 'qpprime_y_zero_transform_bypass_flag', value: bits.readBits(1) === 1 })
      if (bits.readBits(1) === 1) {
        const scalingMatrixCount = chromaFormatIdc !== 3 ? 8 : 12
        for (let i = 0; i < scalingMatrixCount; i++) {
          if (bits.readBits(1) === 1) skipScalingList(bits, i < 6 ? 16 : 64)
        }
      }
    }
    fields.push({ label: 'log2_max_frame_num_minus4', value: bits.readUE() })
    const picOrderCntType = bits.readUE()
    fields.push({ label: 'pic_order_cnt_type', value: picOrderCntType })
    if (picOrderCntType === 0) {
      fields.push({ label: 'log2_max_pic_order_cnt_lsb_minus4', value: bits.readUE() })
    } else if (picOrderCntType === 1) {
      fields.push({ label: 'delta_pic_order_always_zero_flag', value: bits.readBits(1) === 1 })
      fields.push({ label: 'offset_for_non_ref_pic', value: bits.readSE() })
      fields.push({ label: 'offset_for_top_to_bottom_field', value: bits.readSE() })
      const numRefFramesInPicOrderCntCycle = bits.readUE()
      fields.push({ label: 'num_ref_frames_in_pic_order_cnt_cycle', value: numRefFramesInPicOrderCntCycle })
      for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) bits.readSE()
    }
    fields.push({ label: 'max_num_ref_frames', value: bits.readUE() })
    fields.push({ label: 'gaps_in_frame_num_value_allowed_flag', value: bits.readBits(1) === 1 })
    fields.push({ label: 'pic_width_in_mbs_minus1', value: bits.readUE() })
    fields.push({ label: 'pic_height_in_map_units_minus1', value: bits.readUE() })
    const frameMbsOnlyFlag = bits.readBits(1) === 1
    fields.push({ label: 'frame_mbs_only_flag', value: frameMbsOnlyFlag })
    if (!frameMbsOnlyFlag) fields.push({ label: 'mb_adaptive_frame_field_flag', value: bits.readBits(1) === 1 })
    fields.push({ label: 'direct_8x8_inference_flag', value: bits.readBits(1) === 1 })
    const frameCroppingFlag = bits.readBits(1) === 1
    fields.push({ label: 'frame_cropping_flag', value: frameCroppingFlag })
    if (frameCroppingFlag) {
      fields.push({ label: 'frame_crop_left_offset', value: bits.readUE() })
      fields.push({ label: 'frame_crop_right_offset', value: bits.readUE() })
      fields.push({ label: 'frame_crop_top_offset', value: bits.readUE() })
      fields.push({ label: 'frame_crop_bottom_offset', value: bits.readUE() })
    }
    const width = (bitsValue(fields, 'pic_width_in_mbs_minus1') + 1) * 16
    const heightInMapUnits = bitsValue(fields, 'pic_height_in_map_units_minus1') + 1
    const height = heightInMapUnits * 16 * (frameMbsOnlyFlag ? 1 : 2)
    fields.push({ label: 'calculated_width', value: width })
    fields.push({ label: 'calculated_height', value: height })
    return fields
  } catch {
    return null
  }
}

function bitsValue(fields: Array<{ label: string; value: string | number | boolean }>, label: string): number {
  const found = fields.find((field) => field.label === label)
  return typeof found?.value === 'number' ? found.value : 0
}

function skipScalingList(bits: BitReader, size: number) {
  let lastScale = 8
  let nextScale = 8
  for (let i = 0; i < size; i++) {
    if (nextScale !== 0) {
      const deltaScale = bits.readSE()
      nextScale = (lastScale + deltaScale + 256) % 256
    }
    lastScale = nextScale === 0 ? lastScale : nextScale
  }
}

function removeEmulationPreventionBytes(data: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < data.length; i++) {
    if (i + 2 < data.length && data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x03) {
      out.push(0x00, 0x00)
      i += 2
      continue
    }
    out.push(data[i])
  }
  return new Uint8Array(out)
}

class BitReader {
  private readonly data: Uint8Array
  private bitOffset: number

  constructor(data: Uint8Array, bitOffset = 0) {
    this.data = data
    this.bitOffset = bitOffset
  }

  readBits(count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) {
      const byteIndex = this.bitOffset >> 3
      const bitIndex = 7 - (this.bitOffset & 7)
      const bit = (this.data[byteIndex] >> bitIndex) & 1
      value = (value << 1) | bit
      this.bitOffset++
    }
    return value
  }

  readUE(): number {
    let zeros = 0
    while (this.readBits(1) === 0) zeros++
    const suffix = zeros > 0 ? this.readBits(zeros) : 0
    return (1 << zeros) - 1 + suffix
  }

  readSE(): number {
    const value = this.readUE()
    const signed = Math.ceil(value / 2)
    return value % 2 === 0 ? -signed : signed
  }
}
