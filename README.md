# TS Viewer

A small React + TypeScript app that analyzes MPEG-TS files in the browser and renders stream metadata, headers, and codec details.

## Run locally (Windows + fnm)

```powershell
# Ensure Node is available via fnm
fnm env --use-on-cd | Out-String | Invoke-Expression
fnm use 22.21.1

# Start dev server
npm run dev
```

Open the local URL printed by Vite (typically http://localhost:5173).

## Usage
- Choose a transport stream file and wait for the worker to scan the first packet window.
- Expand the header list, inspect the selected header details, and review the raw probe output when needed.

## Notes
- The analyzer is intentionally client-side and worker-backed.
- The SPS fields shown in the detail pane are pragmatic metadata, not a full codec conformance view.
