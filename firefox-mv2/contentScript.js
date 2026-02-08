const INJECTED_ID = "universal-web-agent-api";

if (!document.getElementById(INJECTED_ID)) {
  const script = document.createElement("script");
  script.id = INJECTED_ID;
  script.src = (typeof browser !== "undefined" ? browser : chrome).runtime.getURL(
    "injectedApi.js"
  );
  script.type = "module";
  (document.head || document.documentElement).appendChild(script);
}

window.addEventListener("message", async (event) => {
  if (event.source !== window) {
    return;
  }

  const { data } = event;
  if (!data || data.channel !== "web-agent-api" || data.direction !== "from-page") {
    return;
  }

  const { requestId, action, payload } = data;
  try {
    const response = await (typeof browser !== "undefined" ? browser : chrome).runtime.sendMessage({
      type: "agent_request",
      source: "page",
      requestId,
      action,
      payload,
    });

    window.postMessage(
      {
        channel: "web-agent-api",
        direction: "to-page",
        requestId,
        ok: response?.ok !== false,
        result: response?.result,
        error: response?.error,
      },
      "*"
    );
  } catch (error) {
    window.postMessage(
      {
        channel: "web-agent-api",
        direction: "to-page",
        requestId,
        ok: false,
        error: error?.message || String(error),
      },
      "*"
    );
  }
});
