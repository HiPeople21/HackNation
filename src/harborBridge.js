const CHANNEL = "harbor-bridge";
const pending = new Map();

function newRequestId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function injectPageScript() {
  if (document.getElementById("harbor-bridge-script")) {
    return;
  }
  const script = document.createElement("script");
  script.id = "harbor-bridge-script";
  script.src = chrome.runtime.getURL("src/harborPage.js");
  script.type = "module";
  (document.head || document.documentElement).appendChild(script);
}

injectPageScript();

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }
  const { data } = event;
  if (!data || data.channel !== CHANNEL || data.direction !== "to-content") {
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "harbor_chat") {
    return false;
  }

  const requestId = newRequestId();
  const payload = {
    channel: CHANNEL,
    direction: "to-page",
    requestId,
    prompt: message.prompt || "",
  };

  window.postMessage(payload, "*");

  const timeoutId = setTimeout(() => {
    if (pending.has(requestId)) {
      pending.delete(requestId);
      sendResponse({ ok: false, error: "Harbor chat timed out." });
    }
  }, 15000);

  pending.set(requestId, {
    resolve: (result) => {
      clearTimeout(timeoutId);
      sendResponse({ ok: true, result });
    },
    reject: (error) => {
      clearTimeout(timeoutId);
      sendResponse({ ok: false, error: error?.message || String(error) });
    },
  });

  return true;
});
