/**
 * Background service worker for the Universal Web Agent Chrome extension.
 *
 * Manages an SSE connection to the MCP server at localhost:8787 and exposes
 * tool listing / tool calling via chrome.runtime messaging.
 *
 * Message protocol (from popup / side panel):
 *   { type: 'mcp:tools.list' }            → { tools: ToolDescriptor[] }
 *   { type: 'mcp:tools.call', tool, args } → { result: unknown }
 *   { type: 'mcp:status' }                → { connected, sessionId }
 *   { type: 'mcp:reconnect' }             → { ok: true }
 */

const MCP_BASE = 'http://127.0.0.1:8787';
const OLLAMA_BASE = 'http://127.0.0.1:11434';

let sessionId: string | null = null;
let sseAbort: AbortController | null = null;
let connected = false;
let nextJsonRpcId = 1;

// ---------- SSE connection ----------

async function connectSSE(): Promise<void> {
  // Tear down any existing connection.
  if (sseAbort) {
    sseAbort.abort();
    sseAbort = null;
  }
  sessionId = null;
  connected = false;

  const abort = new AbortController();
  sseAbort = abort;

  try {
    const res = await fetch(`${MCP_BASE}/mcp`, { signal: abort.signal });
    if (!res.ok || !res.body) {
      console.error('[bg] SSE connect failed:', res.status);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const read = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data) continue;
            try {
              const msg = JSON.parse(data);
              handleSSEMessage(msg);
            } catch {
              // Non-JSON data line, ignore
            }
          }
          // Extract endpoint from SSE event
          if (line.startsWith('event: endpoint')) {
            // Next data line has the endpoint URL containing sessionId
          }
        }
      }
    };

    // The SSE endpoint sends an initial event with the endpoint URL.
    // We need to parse the sessionId from it. The SSEServerTransport sends:
    //   event: endpoint
    //   data: /messages?sessionId=xxx
    // We handle this in the read loop above, but also extract it from the raw stream.

    // Read raw bytes to find the initial endpoint event
    const initialRead = async () => {
      let initBuf = '';
      while (!sessionId && !abort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        initBuf += decoder.decode(value, { stream: true });

        const match = initBuf.match(/data:\s*\/messages\?sessionId=([^\s\n]+)/);
        if (match) {
          sessionId = match[1].trim();
          connected = true;
          console.log('[bg] SSE connected, sessionId:', sessionId);
          // Continue reading remaining SSE events
          buffer = initBuf.substring(initBuf.indexOf(match[0]) + match[0].length);
          break;
        }
      }
    };

    await initialRead();

    // Keep reading SSE stream in background (keepalives, notifications)
    read().catch((err) => {
      if (!abort.signal.aborted) {
        console.error('[bg] SSE read error:', err);
        connected = false;
        // Auto-reconnect after 3s
        setTimeout(connectSSE, 3000);
      }
    });
  } catch (err: unknown) {
    if (sseAbort?.signal.aborted) return; // intentional disconnect
    console.error('[bg] SSE connect error:', err);
    connected = false;
    // Auto-reconnect after 5s
    setTimeout(connectSSE, 5000);
  }
}

function handleSSEMessage(msg: Record<string, unknown>) {
  // JSON-RPC responses from the server are delivered here.
  // We store pending promise resolvers keyed by request id.
  const id = msg.id as number | string | undefined;
  if (id !== undefined && pendingRequests.has(String(id))) {
    const { resolve, reject } = pendingRequests.get(String(id))!;
    pendingRequests.delete(String(id));
    if (msg.error) {
      reject(new Error(String((msg.error as Record<string, unknown>).message || msg.error)));
    } else {
      resolve(msg.result);
    }
  }
}

// ---------- JSON-RPC over POST /messages ----------

const pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

async function sendJsonRpc(method: string, params?: unknown): Promise<unknown> {
  if (!sessionId) {
    throw new Error('No active MCP session');
  }

  const id = nextJsonRpcId++;
  const body = { jsonrpc: '2.0', id, method, params: params ?? {} };

  return new Promise((resolve, reject) => {
    pendingRequests.set(String(id), { resolve, reject });

    // Timeout after 60s
    const timer = setTimeout(() => {
      if (pendingRequests.has(String(id))) {
        pendingRequests.delete(String(id));
        reject(new Error(`MCP request timed out: ${method}`));
      }
    }, 60000);

    fetch(`${MCP_BASE}/messages?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (!res.ok) {
          clearTimeout(timer);
          pendingRequests.delete(String(id));
          reject(new Error(`MCP POST failed: ${res.status}`));
        }
        // Response comes via SSE, not the POST response body
      })
      .catch((err) => {
        clearTimeout(timer);
        pendingRequests.delete(String(id));
        reject(err);
      });
  });
}

// ---------- MCP operations ----------

async function listTools(): Promise<unknown[]> {
  const result = (await sendJsonRpc('tools/list')) as { tools?: unknown[] };
  return result?.tools ?? [];
}

async function callTool(tool: string, args?: Record<string, unknown>): Promise<unknown> {
  return await sendJsonRpc('tools/call', { name: tool, arguments: args ?? {} });
}

// ---------- Ollama operations ----------

async function ollamaListModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Ollama /api/tags failed: ${res.status}`);
  }
  const data = (await res.json()) as { models?: Array<{ name?: string }> };
  const names = (data.models || [])
    .map((m) => String(m?.name || '').trim())
    .filter(Boolean);
  return Array.from(new Set(names));
}

async function ollamaPrompt(model: string, input: string): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: input }],
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama /api/chat failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    message?: { content?: string };
    response?: string;
  };
  const text = String(data?.message?.content || data?.response || '').trim();
  if (!text) {
    throw new Error('Ollama returned an empty response');
  }
  return text;
}

// ---------- Chrome runtime message handler ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handle = async () => {
    try {
      switch (message.type) {
        case 'mcp:status':
          return { connected, sessionId };

        case 'mcp:reconnect':
          await connectSSE();
          return { ok: true, connected, sessionId };

        case 'mcp:tools.list': {
          if (!connected) await connectSSE();
          const tools = await listTools();
          return { tools };
        }

        case 'mcp:tools.call': {
          if (!connected) await connectSSE();
          const result = await callTool(message.tool, message.args);
          return { result };
        }

        case 'ollama:list': {
          const models = await ollamaListModels();
          return { models };
        }

        case 'ollama:chat': {
          const model = String(message.model || '').trim();
          const prompt = String(message.prompt || '').trim();
          if (!model) return { error: 'model is required' };
          if (!prompt) return { error: 'prompt is required' };
          const text = await ollamaPrompt(model, prompt);
          return { text };
        }

        default:
          return { error: `Unknown message type: ${message.type}` };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  };

  handle().then(sendResponse);
  return true; // async response
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  const browserApi = (globalThis as unknown as { browser?: { sidebarAction?: { open?: () => Promise<void> } } }).browser;
  if (tab.id && chrome.sidePanel?.open) {
    chrome.sidePanel.open({ tabId: tab.id });
    return;
  }
  if (browserApi?.sidebarAction?.open) {
    browserApi.sidebarAction.open().catch(() => {
      // ignore
    });
  }
});

// Connect on startup
connectSSE();

console.log('[bg] Universal Web Agent background worker started');
