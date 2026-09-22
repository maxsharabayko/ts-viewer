import { useEffect, useMemo, useState } from 'react'
import './App.css'

type StreamType = 'video' | 'audio' | 'subtitle' | 'data' | 'unknown'

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
  title: string
  packetType: string
}

type SpsInfo = {
  pid: number
  packetIndex: number
  nalType: number
  fields: Array<{ label: string; value: string | number | boolean }>
}

const emptyResult = (fileName = 'No file selected'): ProbeResult => ({
  streams: [],
  chapters: [],
  raw: '',
  fileName,
  fileSize: 0,
  mimeType: '',
})

function App() {
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<ProbeResult>(() => emptyResult())
  const [loading, setLoading] = useState(false)
  const [workerReady, setWorkerReady] = useState(false)
  const [progress, setProgress] = useState({ phase: 'Idle', value: 0, indeterminate: false })
  const [slowHint, setSlowHint] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const [selectedHeaderKey, setSelectedHeaderKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const worker = new Worker(new URL('./workers/tsAnalyzerWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event) => {
      const message = event.data as { type: string; payload?: ProbeResult; error?: string }
      if (cancelled) return
      if (message.type === 'ready') setWorkerReady(true)
      if (message.type === 'progress') {
        setLoading(true)
        const nextPhase = message.phase ?? 'Working'
        const isFinalSteps = nextPhase === 'Reading output' || nextPhase === 'Done'
        setProgress({ phase: nextPhase, value: typeof message.value === 'number' ? message.value : 0, indeterminate: !isFinalSteps })
      }
      if (message.type === 'result' && message.payload) {
        setResult(message.payload)
        setLoading(false)
        setProgress({ phase: 'Complete', value: 1, indeterminate: false })
        setSlowHint(false)
      }
      if (message.type === 'error') {
        setResult((current) => ({ ...current, error: message.error ?? 'Analysis failed' }))
        setLoading(false)
        setProgress({ phase: 'Error', value: 0, indeterminate: false })
        setSlowHint(false)
      }
    }
    worker.postMessage({ type: 'init' })
    return () => {
      cancelled = true
      worker.terminate()
    }
  }, [])

  const handleUpload = (nextFile: File | null) => {
    setFile(nextFile)
    if (!nextFile) {
      setResult(emptyResult())
      setLoading(false)
      setProgress({ phase: 'Idle', value: 0, indeterminate: false })
      setRawOpen(false)
      return
    }
    setLoading(true)
    setProgress({ phase: 'Starting', value: 0.08, indeterminate: true })
    setSlowHint(false)
    setResult((current) => ({ ...current, error: undefined }))
    const worker = new Worker(new URL('./workers/tsAnalyzerWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event) => {
      const message = event.data as { type: string; payload?: ProbeResult; error?: string }
      if (message.type === 'result' && message.payload) {
        setResult(message.payload)
        setLoading(false)
        setProgress({ phase: 'Complete', value: 1, indeterminate: false })
      }
      if (message.type === 'error') {
        setResult((current) => ({ ...current, error: message.error ?? 'Analysis failed' }))
        setLoading(false)
        setProgress({ phase: 'Error', value: 0, indeterminate: false })
      }
      worker.terminate()
    }
    worker.postMessage({ type: 'analyze', file: nextFile })
  }

  useEffect(() => {
    if (!loading) return
    const timer = window.setTimeout(() => setSlowHint(true), 2500)
    return () => window.clearTimeout(timer)
  }, [loading])

  const summary = useMemo(() => {
    if (result.error) return result.error
    if (loading) return 'Analyzing file in a worker...'
    if (!file) return 'Upload an MPEG-TS file to inspect its stream metadata and codec headers.'
    if (!result.streams.length) return 'No streams were detected.'
    return `${result.streams.length} stream${result.streams.length === 1 ? '' : 's'} detected`
  }, [file, loading, result.error, result.streams.length])

  const stats = useMemo(() => {
    const counts = { video: 0, audio: 0, subtitle: 0, data: 0, unknown: 0 }
    for (const stream of result.streams) {
      const key = normalizeStreamType(stream.codec_type)
      counts[key] += 1
    }
    return counts
  }, [result.streams])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">CLIENT-SIDE MPEG-TS ANALYZER</p>
          <h1>TS Viewer</h1>
          <p className="subtitle">Upload a transport stream and inspect client-side stream metadata, tables, and codec hints.</p>
        </div>
      </header>

      <section className="card input-panel">
        <label className="file-drop">
          <input
            type="file"
            accept=".ts,.mts,.m2ts,video/MP2T,video/mp2t"
            onChange={(event) => handleUpload(event.target.files?.[0] ?? null)}
          />
          <span>
            <strong>Choose a TS file</strong>
            <em>{workerReady ? 'Worker ready' : 'Preparing worker...'}</em>
          </span>
        </label>
        {loading && (
          <div className="progress-wrap" aria-live="polite">
            <div className="progress-meta">
              <span>{slowHint ? `${progress.phase} — still working` : progress.phase}</span>
              <strong>{Math.round(progress.value * 100)}%</strong>
            </div>
            <div className="progress-track" aria-hidden="true">
              <div
                className={`progress-fill${progress.indeterminate ? ' progress-fill-indeterminate' : ''}`}
                style={{ width: progress.indeterminate ? '42%' : `${Math.max(4, Math.min(100, progress.value * 100))}%` }}
              />
            </div>
          </div>
        )}
        <div className="actions">
          <button className="secondary" onClick={() => handleUpload(null)} disabled={!file && !result.streams.length && !result.error}>
            Clear
          </button>
        </div>
      </section>

      <section className="card summary-grid">
        <Metric label="File" value={result.fileName} />
        <Metric label="Size" value={formatBytes(result.fileSize)} />
        <Metric label="Streams" value={String(result.streams.length)} />
        <Metric label="Probe" value={summary} />
      </section>

      <section className="card visualization-panel">
        <div className="panel-head">
          <h2>Headers</h2>
          <span>{renderCodecMix(stats)}</span>
        </div>
        <div className="header-layout">
          <div className="header-list">
            {result.streams.flatMap((stream) =>
              (stream.headers ?? []).map((header, idx) => (
                <HeaderTree
                  key={`${stream.index}-${idx}`}
                  streamIndex={stream.index}
                  codec={stream.codec_name ?? stream.codec_type}
                  header={header}
                  selected={selectedHeaderKey === `${stream.index}-${idx}`}
                  onSelect={() => setSelectedHeaderKey(`${stream.index}-${idx}`)}
                />
              )),
            )}
          </div>
          <div className="header-detail-pane">
            {renderSelectedHeaderDetail(result.streams, selectedHeaderKey)}
            {renderSelectedSpsDetail(result.streams, selectedHeaderKey)}
          </div>
        </div>
      </section>

      <section className="card table-panel">
        <div className="panel-head">
          <h2>Streams</h2>
          <span>{result.format?.format_name ?? 'Unknown container'}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>Codec</th>
              <th>Profile / Level</th>
              <th>Dimensions / Rate</th>
              <th>Headers</th>
            </tr>
          </thead>
          <tbody>
            {result.streams.map((stream) => (
              <tr key={stream.index}>
                <td>{stream.index}</td>
                <td>{stream.codec_type}</td>
                <td>{stream.codec_name ?? 'unknown'}</td>
                <td>{[stream.profile, stream.level !== undefined ? `L${stream.level}` : ''].filter(Boolean).join(' ') || '—'}</td>
                <td>{formatStreamDetails(stream)}</td>
                <td>{stream.headerSummary ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card raw-panel">
        <div className="panel-head">
          <h2 onClick={() => setRawOpen((value) => !value)} className="collapsible-title">
            <span className="toggle">{rawOpen ? '▾' : '▸'}</span>
            Raw probe output
          </h2>
          <span>Client-side parsed output</span>
        </div>
        {rawOpen && <pre className="raw-scroll">{result.raw || 'No analysis output yet.'}</pre>}
      </section>

      <section className="card raw-panel">
        <div className="panel-head">
          <h2>Parsed metadata</h2>
          <span>{result.chapters.length} chapters</span>
        </div>
        <pre>{formatParsedMetadata(result)}</pre>
      </section>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function normalizeStreamType(type: string): StreamType {
  if (type === 'video' || type === 'audio' || type === 'subtitle' || type === 'data') return type
  return 'unknown'
}

function formatBytes(size: number) {
  if (!size) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1)
  return `${(size / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatStreamDetails(stream: ProbeStream) {
  if (stream.codec_type === 'video') return [stream.width && `${stream.width}x${stream.height}`, stream.time_base].filter(Boolean).join(' • ') || '—'
  if (stream.codec_type === 'audio') return [stream.sample_rate && `${stream.sample_rate} Hz`, stream.channels && `${stream.channels} ch`].filter(Boolean).join(' • ') || '—'
  return stream.time_base ?? '—'
}

function renderCodecMix(counts: Record<StreamType, number>) {
  return ['video', 'audio', 'subtitle', 'data', 'unknown']
    .map((kind) => `${kind}:${counts[kind as StreamType]}`)
    .join(' • ')
}

function formatParsedMetadata(result: ProbeResult) {
  const payload = result.parsedJson ?? result.format ?? {}
  const text = JSON.stringify(payload, null, 2)
  return text && text !== '{}' ? text : 'No parsed metadata.'
}

function SpsTree({ streamIndex, codec, sps }: { streamIndex: number; codec: string; sps: SpsInfo }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="sps-tree">
      <div className="sps-tree-head" onClick={() => setOpen((value) => !value)}>
        <span className="toggle">{open ? '▾' : '▸'}</span>
        <div className="sps-tree-title">
          <strong>{codec.toUpperCase()} SPS</strong>
          <span>Stream {streamIndex} · pkt {sps.packetIndex}</span>
        </div>
      </div>
      {open && (
        <div className="sps-tree-body">
          <div className="sps-tree-table">
            <div className="sps-row sps-row-head">
              <span>Property</span>
              <span>Value</span>
            </div>
            {sps.fields.map((field) => (
              <div className="sps-row" key={field.label}>
                <span className="key">{field.label}</span>
                <span className="value">{String(field.value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function HeaderTree({
  streamIndex,
  codec,
  header,
  selected,
  onSelect,
}: {
  streamIndex: number
  codec: string
  header: HeaderEvent
  selected: boolean
  onSelect: () => void
}) {
return (
  <div className={`header-tree${selected ? ' header-tree-selected' : ''}`}>
    <div className="header-tree-head" onClick={onSelect}>
      <span className="toggle">▸</span>
      <span className={`chip chip-${header.kind}`}>{header.packetType}</span>
      <span className="header-tree-meta">Stream {streamIndex} · PID {header.pid} · pkt {header.packetIndex}</span>
      <span className="header-tree-codec">{codec.toUpperCase()}</span>
    </div>
  </div>
)
}

function renderSelectedHeaderDetail(streams: ProbeStream[], selectedKey: string | null) {
  if (!selectedKey) {
    return <div className="header-detail-empty">Select a header to inspect it here.</div>
  }
  const [streamIndexText, headerIndexText] = selectedKey.split('-')
  const streamIndex = Number(streamIndexText)
  const headerIndex = Number(headerIndexText)
  const stream = streams.find((item) => item.index === streamIndex)
  const header = stream?.headers?.[headerIndex]
  if (!stream || !header) {
    return <div className="header-detail-empty">Header not found.</div>
  }
  return (
    <div className="header-detail">
      <div className="header-detail-head">
        <strong>{header.packetType}</strong>
        <span>{stream.codec_name ?? stream.codec_type}</span>
      </div>
      <div className="sps-tree-table">
        <div className="sps-row sps-row-head">
          <span>Property</span>
          <span>Value</span>
        </div>
        <div className="sps-row"><span className="key">kind</span><span className="value">{header.kind}</span></div>
        <div className="sps-row"><span className="key">nal_type</span><span className="value">{header.nalType}</span></div>
        <div className="sps-row"><span className="key">offset</span><span className="value">{header.offset}</span></div>
        <div className="sps-row"><span className="key">label</span><span className="value">{header.label}</span></div>
        <div className="sps-row"><span className="key">pid</span><span className="value">{header.pid}</span></div>
        <div className="sps-row"><span className="key">packet</span><span className="value">{header.packetIndex}</span></div>
      </div>
    </div>
  )
}

function renderSelectedSpsDetail(streams: ProbeStream[], selectedKey: string | null) {
  if (!selectedKey) return null
  const [streamIndexText, headerIndexText] = selectedKey.split('-')
  const streamIndex = Number(streamIndexText)
  const headerIndex = Number(headerIndexText)
  const stream = streams.find((item) => item.index === streamIndex)
  const header = stream?.headers?.[headerIndex]
  const sps = stream?.spsInfo?.find((item) => item.packetIndex === header?.packetIndex)
  if (!sps) return null
  return (
    <div className="header-detail header-detail-sps">
      <div className="header-detail-head">
        <strong>SPS tree</strong>
        <span>{stream.codec_name ?? stream.codec_type}</span>
      </div>
      <div className="sps-tree-table">
        <div className="sps-row sps-row-head">
          <span>Property</span>
          <span>Value</span>
        </div>
        {sps.fields.map((field) => (
          <div className="sps-row" key={field.label}>
            <span className="key">{field.label}</span>
            <span className="value">{String(field.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default App
