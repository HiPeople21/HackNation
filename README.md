# HackNation

Universal Web Agent extension with a Firefox MV2 fallback, Harbor Web Agents API integration, and an optional Gemini proxy server.

## Requirements
- Firefox (WSL Debian/Ubuntu build recommended for native messaging)
- Rust + Cargo (for Harbor bridge)
- Ollama running locally (default model: `llama3.2:latest`)

## Repository Layout
- `firefox-mv2/`: Firefox MV2 extension (side panel UI + tools)
- `harbor/`: Harbor repo (native bridge + Web Agents API)
- `server/`: Optional Gemini proxy (not required for Harbor mode)

## Harbor Setup (Required)
1) Start Ollama and pull a model (example):
```bash
ollama pull llama3.2:latest
```

2) Build and install the Harbor native bridge:
```bash
cd /home/yubow/HackNation/harbor/bridge-rs
cargo build --release
./install.sh
```

3) Load Harbor extensions in Firefox:
- Harbor extension: `harbor/extension/dist-firefox/manifest.json`
- Web Agents API: `harbor/web-agents-api/dist-firefox/manifest.json`

Open: `about:debugging#/runtime/this-firefox` -> Load Temporary Add-on.

## HackNation MV2 Extension
1) Load the MV2 extension:
- Manifest: `firefox-mv2/manifest.json`

2) Open a normal web page (not `about:` pages).

3) Open the sidebar (toolbar icon) and run a prompt.

## Common Issues
- If you see "Receiving end does not exist", reload the extension and make sure the target page is a normal website tab.
- Harbor requires native messaging; Snap Firefox does not support it in WSL.

## Optional: Gemini Proxy (Not Used in Harbor Mode)
If you want to run the old proxy-based planner:
```bash
cd /home/yubow/HackNation/server
npm install
export LLM_API_KEY="YOUR_GEMINI_API_KEY"
npm start
```

## Notes
- The MV2 flow uses Harbor for planning and text.
- Tool actions (click/type/navigate/scrape) are executed by the MV2 background script.