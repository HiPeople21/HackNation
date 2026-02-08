const CHANNEL = "web-agent-api";
const pending = new Map();

function send(action, payload) {
  const requestId = crypto.randomUUID();
  window.postMessage(
    {
      channel: CHANNEL,
      direction: "from-page",
      requestId,
      action,
      payload,
    },
    "*"
  );

  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new Error("Web Agent API request timed out."));
      }
    }, 15000);
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  const { data } = event;
  if (!data || data.channel !== CHANNEL || data.direction !== "to-page") {
    return;
  }

  const handler = pending.get(data.requestId);
  if (!handler) {
    return;
  }
  pending.delete(data.requestId);

  if (data.ok === false) {
    handler.reject(new Error(data.error || "Unknown error"));
  } else {
    handler.resolve(data.result);
  }
});

if (!window.ai) {
  window.ai = {
    async createTextSession() {
      const { sessionId } = await send("create_text_session", {});
      return {
        async prompt(text) {
          const result = await send("text_prompt", { sessionId, text });
          return result?.text || "";
        },
      };
    },
  };
}

if (!window.agent) {
  window.agent = {
    async requestPermissions({ scopes = [], reason = "" } = {}) {
      return send("request_permissions", { scopes, reason });
    },
    tools: {
      async list() {
        return send("list_tools", {});
      },
      async call(name, input) {
        return send("call_tool", { name, input });
      },
    },
    async run({ prompt }) {
      return send("run", { prompt });
    },
    features: {
      async get() {
        return send("get_features", {});
      },
    },
    browser: {
      activeTab: {
        async readability() {
          return send("call_tool", { name: "scrape_page", input: {} });
        },
      },
    },
  };
}
