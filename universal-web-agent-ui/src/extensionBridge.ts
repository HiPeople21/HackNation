/**
 * Extension bridge: polyfills window.ai and window.agent so the existing
 * React app works unchanged inside the Chrome extension side panel.
 *
 * Tool calls are forwarded to the background service worker which manages
 * the SSE connection to the MCP server.
 *
 * LLM calls are proxied to local Ollama via the background script.
 */

function sendMessage(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response ?? {});
    });
  });
}

// ---------- window.agent polyfill ----------

const agentPolyfill = {
  requestPermissions: async (_opts: { scopes: string[]; reason?: string }) => {
    // No-op in extension context — we always have permission to talk to our own background.
    return { granted: true };
  },
  permissions: {
    list: async () => [],
  },
  tools: {
    list: async (): Promise<{ name: string }[]> => {
      const res = await sendMessage({ type: 'mcp:tools.list' });
      return (res.tools as { name: string }[]) ?? [];
    },
    call: async (opts: { tool: string; args?: Record<string, unknown> }): Promise<unknown> => {
      const res = await sendMessage({
        type: 'mcp:tools.call',
        tool: opts.tool,
        args: opts.args ?? {},
      });
      return res.result;
    },
  },
};

// ---------- window.ai polyfill (stub) ----------

let activeModel: string | null = null;

const aiPolyfill = {
  createTextSession: async (opts?: { model?: string }) => {
    const model = String(opts?.model || activeModel || '').trim();
    if (!model) {
      throw new Error('No model selected. Choose an Ollama model first.');
    }
    activeModel = model;
    return {
      prompt: async (input: string): Promise<string> => {
        const res = await sendMessage({
          type: 'ollama:chat',
          model,
          prompt: input,
        });
        const text = String(res.text || '').trim();
        if (!text) {
          throw new Error('Ollama returned an empty response');
        }
        return text;
      },
      destroy: () => {},
    };
  },
  providers: {
    list: async () => {
      const res = await sendMessage({ type: 'ollama:list' });
      const models = Array.isArray(res.models)
        ? res.models.map((m) => String(m)).filter(Boolean)
        : [];
      const fallback = models.length > 0 ? models : ['llama3.2:latest'];
      if (!activeModel && fallback.length > 0) activeModel = fallback[0];
      return [
        {
          id: 'ollama',
          name: 'Ollama (Local)',
          models: fallback,
          available: models.length > 0,
        },
      ];
    },
    getActive: async () => ({ model: activeModel }),
  },
};

// ---------- Install polyfills ----------

export function installExtensionBridge() {
  // Only install when running inside a Chrome extension context
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return false;
  }

  // Don't overwrite if Harbor already injected real APIs
  if (!window.agent) {
    (window as unknown as Record<string, unknown>).agent = agentPolyfill;
  }
  if (!window.ai) {
    (window as unknown as Record<string, unknown>).ai = aiPolyfill;
  }

  console.log('[extensionBridge] Polyfills installed (extension mode)');
  return true;
}
