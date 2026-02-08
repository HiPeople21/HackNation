const api = typeof browser !== "undefined" ? browser : chrome;

const thoughts = document.getElementById("thoughts");
const chat = document.getElementById("chat");
const promptInput = document.getElementById("prompt");
const clearButton = document.getElementById("clear");
const runButton = document.getElementById("run");

const overlay = document.getElementById("permission-overlay");
const permissionText = document.getElementById("permission-text");
const approveOnce = document.getElementById("approve-once");
const approveFive = document.getElementById("approve-5m");
const deny = document.getElementById("deny");

let pendingRequest = null;

function addThought(text) {
  const item = document.createElement("div");
  item.className = "thought";
  item.textContent = text;
  thoughts.prepend(item);
}

function addChatMessage({ role, text }) {
  const item = document.createElement("div");
  item.className = `chat-message ${role || "agent"}`;
  item.textContent = text;
  chat.appendChild(item);
  chat.scrollTop = chat.scrollHeight;
}

function showPermission({ requestId, action, tier, tabId, scopes, reason, requestKind }) {
  pendingRequest = { requestId, tabId };
  if (requestKind === "scopes") {
    const scopeText = Array.isArray(scopes) ? scopes.join(", ") : "";
    const reasonText = reason ? `Reason: ${reason}` : "";
    permissionText.textContent = `Approve scopes: ${scopeText}. ${reasonText}`.trim();
  } else {
    permissionText.textContent = `Tier ${tier} wants to: ${action}`;
  }
  overlay.classList.remove("hidden");
}

function hidePermission() {
  overlay.classList.add("hidden");
}

function respond(approved, ttlMs) {
  if (!pendingRequest) {
    return;
  }
  api.runtime.sendMessage({
    type: "permission_response",
    requestId: pendingRequest.requestId,
    tabId: pendingRequest.tabId,
    approved,
    ttlMs,
  });
  pendingRequest = null;
  hidePermission();
}

api.runtime.onMessage.addListener((message) => {
  if (message.type === "thought") {
    addThought(message.text);
  }
  if (message.type === "chat_message") {
    addChatMessage({ role: message.role, text: message.text });
  }
  if (message.type === "permission_request") {
    showPermission(message);
  }
});

runButton.addEventListener("click", async () => {
  const prompt = promptInput.value.trim();
  addThought("Submitting request.");
  if (prompt) {
    addChatMessage({ role: "user", text: prompt });
  }
  const tabs = await new Promise((resolve) =>
    api.tabs.query({ active: true, currentWindow: true }, resolve)
  );
  const activeTab = tabs[0];
  if (!activeTab?.id) {
    addChatMessage({ role: "system", text: "No active tab available." });
    return;
  }
  if (activeTab.url && activeTab.url.startsWith("about:")) {
    addChatMessage({
      role: "system",
      text: "This page does not allow extensions. Open a normal website tab and try again.",
    });
    return;
  }

  const response = await new Promise((resolve, reject) => {
    api.runtime.sendMessage(
      {
        type: "execute",
        prompt,
        tier: null,
        source: "sidepanel",
      },
      (res) => {
        if (api.runtime.lastError) {
          reject(new Error(api.runtime.lastError.message));
          return;
        }
        resolve(res);
      }
    );
  });
  if (!response?.ok) {
    addChatMessage({
      role: "system",
      text: `Error: ${response?.error || "Unknown error"}`,
    });
    return;
  }

  if (response?.result?.text) {
    addChatMessage({ role: "agent", text: response.result.text });
  }
});

clearButton.addEventListener("click", () => {
  thoughts.replaceChildren();
  chat.replaceChildren();
  promptInput.value = "";
});

approveOnce.addEventListener("click", () => respond(true, 0));
approveFive.addEventListener("click", () => respond(true, 5 * 60 * 1000));
deny.addEventListener("click", () => respond(false, 0));
