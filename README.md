# AutoShop (Extension Run Guide)

This guide is only for running the project as a Firefox extension.

## 1) Prerequisites

- Node.js 18+
- Firefox
- Ollama installed locally
- MCP server running locally on `http://127.0.0.1:8787`

## 2) Start local services

### Ollama
```bash
ollama serve
ollama list
```

### MCP server (example from this repo)
```bash
npm --prefix ../web-search-mcp run build
npm --prefix ../web-search-mcp run start:remote
```

Expected health endpoint:
- `http://127.0.0.1:8787/health`

## 3) Build extension

From `universal-web-agent-ui/`:
```bash
npm install
npm run build
```

## 4) Load extension in Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select `universal-web-agent-ui/manifest.json`

## 5) Use extension

- Click extension icon to open sidebar panel.
- Model list should show local Ollama models (via background bridge).
- Chat/tool workflow uses:
  - Ollama: `http://127.0.0.1:11434`
  - MCP: `http://127.0.0.1:8787`

## 6) Runtime config (if ports differ)

Edit `src/background.ts`:
- `MCP_BASE`
- `OLLAMA_BASE`

Then rebuild:
```bash
npm run build
```

## Troubleshooting

- Install error mentions service worker disabled:
  - Keep manifest using `background.scripts` (already configured).

- Extension loads but tools fail:
  - Check MCP server is up at `127.0.0.1:8787`.
  - Check extension background logs in `about:debugging`.

- Model dropdown missing Ollama models:
  - Check `ollama serve` is running.
  - Test `http://127.0.0.1:11434/api/tags`.

- Requests time out:
  - Verify both local endpoints are reachable:
    - `http://127.0.0.1:8787/health`
    - `http://127.0.0.1:11434/api/tags`
