import { WebAgent } from "./webAgent.js";

const agent = new WebAgent();

async function openSidePanel(tabId) {
  if (!chrome.sidePanel?.open || !tabId) {
    return;
  }

  try {
    await chrome.sidePanel.open({ tabId });
  } catch (error) {
    // Ignore if the browser does not support programmatic side panel opening.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  agent.initialize();
  chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    openSidePanel(tabs[0]?.id);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  openSidePanel(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status === "complete") {
    openSidePanel(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }


  if (message.type === "execute") {
    agent
      .handleUserCommand(message, sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) })
      );
    return true;
  }

  if (message.type === "permission_response") {
    agent.permissionGate.handlePermissionResponse(message);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "agent_request") {
    agent
      .handleAgentRequest(message, sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) })
      );
    return true;
  }

  return false;
});

