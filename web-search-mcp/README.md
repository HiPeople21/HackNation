# web-search-mcp

This server now supports:
- stdio mode (`npm run start`)
- remote Harbor-compatible SSE mode (`npm run start:remote`)

## 1) Install deps

```bash
npm --prefix web-search-mcp install
npx --prefix web-search-mcp playwright install chromium
```

## 2) Build

```bash
npm --prefix web-search-mcp run build
```

## 3) Run remote MCP endpoint for Harbor

```bash
npm --prefix web-search-mcp run start:remote
```

Default endpoint:
- `http://127.0.0.1:8787/mcp`
- health check: `http://127.0.0.1:8787/health`

Optional env vars:
- `MCP_HOST` (default `127.0.0.1`)
- `MCP_PORT` (default `8787`)

## 4) Add to Harbor

Import this manifest in Harbor:

`harbor/mcp-servers/examples/web-search-remote/manifest.json`

If your host/port is different, edit `remoteUrl` in that manifest first.

## 5) Verify tools

In Harbor Tool Tester, select `Web Search MCP (Remote)` and run:
- `web_search`
- `browser_start`
- `browser_open`
- `browser_click`
- `browser_type`
- `browser_select`
- `browser_scroll`
- `browser_snapshot`
- `browser_close`

