const api = typeof browser !== "undefined" ? browser : chrome;

function queryTabs(queryInfo) {
  return new Promise((resolve) => api.tabs.query(queryInfo, resolve));
}

function updateTab(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    api.tabs.update(tabId, updateProperties, (tab) => {
      if (api.runtime.lastError) {
        reject(new Error(api.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function getStorage(key) {
  return new Promise((resolve) => api.storage.local.get(key, resolve));
}

function setStorage(value) {
  return new Promise((resolve, reject) => {
    api.storage.local.set(value, () => {
      if (api.runtime.lastError) {
        reject(new Error(api.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function executeScript({ tabId, func, args = [] }) {
  if (api.scripting && api.scripting.executeScript) {
    return api.scripting.executeScript({ target: { tabId }, func, args });
  }

  const serializedArgs = args.map((value) => JSON.stringify(value)).join(",");
  const code = `(${func.toString()})(${serializedArgs})`;

  return new Promise((resolve, reject) => {
    api.tabs.executeScript(tabId, { code }, (results) => {
      if (api.runtime.lastError) {
        reject(new Error(api.runtime.lastError.message));
        return;
      }
      resolve([{ result: results ? results[0] : undefined }]);
    });
  });
}

const CapabilityTier = Object.freeze({
  ORACLE: 1,
  NAVIGATOR: 2,
  ACTOR: 3,
});

class CapabilityManager {
  constructor() {
    this.tierNames = new Map([
      [CapabilityTier.ORACLE, "Oracle"],
      [CapabilityTier.NAVIGATOR, "Navigator"],
      [CapabilityTier.ACTOR, "Actor"],
    ]);
  }

  getTierName(tier) {
    return this.tierNames.get(tier) || "Unknown";
  }

  canUseTool(requestedTier, toolTier) {
    return requestedTier >= toolTier;
  }

  assertTierAllowed(requestedTier, toolTier) {
    if (!this.canUseTool(requestedTier, toolTier)) {
      const requestedName = this.getTierName(requestedTier);
      const toolName = this.getTierName(toolTier);
      throw new Error(
        `Capability tier ${requestedName} cannot access ${toolName} tools.`
      );
    }
  }
}

const STORAGE_PREFIX = "tabAccess:";
const SCOPE_PREFIX = "scopeAccess:";

class PermissionGate {
  constructor({ emitThought }) {
    this.emitThought = emitThought;
    this.pending = new Map();
  }

  async hasTimeBoundAccess(tabId) {
    const key = `${STORAGE_PREFIX}${tabId}`;
    const result = await getStorage(key);
    const entry = result[key];
    if (!entry || !entry.expiresAt) {
      return false;
    }
    return Date.now() < entry.expiresAt;
  }

  async grantTimeBoundAccess(tabId, ttlMs) {
    const key = `${STORAGE_PREFIX}${tabId}`;
    const expiresAt = Date.now() + ttlMs;
    await setStorage({
      [key]: { expiresAt },
    });
  }

  async hasScopeAccess(tabId, scopes = []) {
    if (!scopes.length) {
      return true;
    }

    const key = `${SCOPE_PREFIX}${tabId}`;
    const result = await getStorage(key);
    const entry = result[key];
    if (!entry || !entry.expiresAt || Date.now() >= entry.expiresAt) {
      return false;
    }

    const granted = new Set(entry.scopes || []);
    return scopes.every((scope) => granted.has(scope));
  }

  async grantScopeAccess(tabId, scopes, ttlMs) {
    if (!ttlMs) {
      return;
    }
    const key = `${SCOPE_PREFIX}${tabId}`;
    const expiresAt = Date.now() + ttlMs;
    await setStorage({
      [key]: { scopes, expiresAt },
    });
  }

  async requestScopes({ tabId, scopes, reason }) {
    if (await this.hasScopeAccess(tabId, scopes)) {
      this.emitThought(`Scopes already granted for tab ${tabId}.`);
      return { approved: true, ttlMs: 0 };
    }

    this.emitThought(`Requesting scopes: ${scopes.join(", ")}.`);

    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      this.pending.set(requestId, {
        resolve,
        kind: "scopes",
        tabId,
        scopes,
      });
      api.runtime.sendMessage({
        type: "permission_request",
        requestId,
        tabId,
        scopes,
        reason,
        requestKind: "scopes",
      });
    });
  }

  async confirmAction({ tier, action, tabId }) {
    if (tier === CapabilityTier.ORACLE) {
      return true;
    }

    if (await this.hasTimeBoundAccess(tabId)) {
      this.emitThought(
        `Using existing time-bounded access for tab ${tabId}.`
      );
      return true;
    }

    this.emitThought(
      `Requesting explicit approval for ${action} (Tier ${tier}).`
    );

    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      this.pending.set(requestId, {
        resolve,
        kind: "action",
      });
      api.runtime.sendMessage({
        type: "permission_request",
        requestId,
        tier,
        action,
        tabId,
        requestKind: "action",
      });
    });
  }

  handlePermissionResponse(message) {
    const { requestId, approved, ttlMs, tabId } = message;
    const entry = this.pending.get(requestId);
    if (!entry) {
      return;
    }

    this.pending.delete(requestId);

    if (approved && entry.kind === "scopes" && tabId != null) {
      this.grantScopeAccess(tabId, entry.scopes, ttlMs).catch(() => {
        // Storage failures should not block user-approved actions.
      });
    }

    if (approved && ttlMs && tabId != null) {
      this.grantTimeBoundAccess(tabId, ttlMs).catch(() => {
        // Storage failures should not block user-approved actions.
      });
    }

    if (entry.kind === "scopes") {
      entry.resolve({ approved: Boolean(approved), ttlMs: ttlMs || 0 });
    } else {
      entry.resolve(Boolean(approved));
    }
  }
}

class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  defineTool({ name, description, inputSchema, tier, handler }) {
    if (this.tools.has(name)) {
      throw new Error(`Tool already defined: ${name}`);
    }
    this.tools.set(name, { name, description, inputSchema, tier, handler });
  }

  getTool(name) {
    return this.tools.get(name);
  }

  listTools() {
    return Array.from(this.tools.values());
  }
}

function createMcpTools({ emitThought }) {
  const registry = new ToolRegistry();

  registry.defineTool({
    name: "scrape_page",
    description: "Extract visible text from the current page.",
    inputSchema: { type: "object", properties: {} },
    tier: CapabilityTier.ORACLE,
    handler: async ({ tabId }) => {
      const [result] = await executeScript({
        tabId,
        func: () => document.body?.innerText?.slice(0, 4000) || "",
      });
      emitThought("Scraped page text for analysis.");
      return result?.result || "";
    },
  });

  registry.defineTool({
    name: "click_selector",
    description: "Click a DOM element by CSS selector.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
    tier: CapabilityTier.NAVIGATOR,
    handler: async ({ tabId, selector }) => {
      const [result] = await executeScript({
        tabId,
        args: [selector],
        func: (sel) => {
          const target = document.querySelector(sel);
          if (!target) {
            return { ok: false, message: "Selector not found." };
          }
          target.click();
          return { ok: true, message: "Clicked." };
        },
      });
      emitThought(`Attempted click on selector: ${selector}.`);
      return result?.result;
    },
  });

  registry.defineTool({
    name: "scroll_page",
    description: "Scroll the page by a number of pixels.",
    inputSchema: {
      type: "object",
      properties: { deltaY: { type: "number" } },
      required: ["deltaY"],
    },
    tier: CapabilityTier.NAVIGATOR,
    handler: async ({ tabId, deltaY }) => {
      const [result] = await executeScript({
        tabId,
        args: [deltaY],
        func: (value) => {
          window.scrollBy({ top: value, behavior: "smooth" });
          return { ok: true, message: `Scrolled by ${value}px.` };
        },
      });
      emitThought(`Scrolled page by ${deltaY}px.`);
      return result?.result;
    },
  });

  registry.defineTool({
    name: "navigate_to",
    description: "Navigate the current tab to a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    tier: CapabilityTier.ACTOR,
    handler: async ({ tabId, url }) => {
      await updateTab(tabId, { url });
      emitThought(`Navigating tab ${tabId} to ${url}.`);
      return { ok: true };
    },
  });

  return registry;
}

class LlmProvider {
  async generatePlan({ prompt, tools }) {
    throw new Error("LLM provider not configured.");
  }

  async generateText({ prompt }) {
    throw new Error("LLM provider not configured.");
  }
}

class ProxyLlmProvider extends LlmProvider {
  constructor({ endpoint } = {}) {
    super();
    this.endpoint = endpoint || "http://localhost:8787/plan";
  }

  async generatePlan({ prompt, tools }) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, tools }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Proxy error: ${errorText}`);
    }

    const data = await response.json();
    const text = data?.text || "{}";
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("Proxy returned non-JSON plan text.");
    }
  }

  async generateText({ prompt }) {
    const response = await fetch(this.endpoint.replace("/plan", "/text"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Proxy error: ${errorText}`);
    }

    const data = await response.json();
    return data?.text || "";
  }
}

class StubLlmProvider extends LlmProvider {
  async generatePlan({ prompt, tools }) {
    return {
      intent: prompt,
      steps: tools
        .filter((tool) => tool.name === "scrape_page")
        .map((tool) => ({ tool: tool.name, input: {} })),
    };
  }

  async generateText({ prompt }) {
    return `Stub response for: ${prompt}`;
  }
}

class WebAgent {
  constructor() {
    this.capabilityManager = new CapabilityManager();
    this.emitThought = this.emitThought.bind(this);
    this.permissionGate = new PermissionGate({ emitThought: this.emitThought });
    this.tools = createMcpTools({ emitThought: this.emitThought });
    this.llm = new ProxyLlmProvider();
    this.fallbackLlm = new StubLlmProvider();
    this.sessions = new Map();
  }

  initialize() {
    this.emitThought("WebAgent initialized.");
  }

  emitThought(text) {
    api.runtime.sendMessage({ type: "thought", text });
  }

  async handleUserCommand(message, sender) {
    const tier = Number(message.tier) || CapabilityTier.ORACLE;
    const prompt = message.prompt || "";
    const tabId = sender.tab?.id || (await this.getActiveTabId());

    if (!tabId) {
      throw new Error("No active tab available.");
    }

    this.emitThought(
      `Received prompt for ${this.capabilityManager.getTierName(tier)} tier.`
    );

    let plan;
    try {
      plan = await this.llm.generatePlan({
        prompt,
        tools: this.tools.listTools(),
      });
    } catch (error) {
      this.emitThought("LLM proxy failed, using stub plan.");
      plan = await this.fallbackLlm.generatePlan({
        prompt,
        tools: this.tools.listTools(),
      });
    }

    return this.executePlan({ plan, tier, tabId });
  }

  async handleAgentRequest(message, sender) {
    const action = message.action;
    const payload = message.payload || {};
    const tabId = sender.tab?.id || (await this.getActiveTabId());

    if (!tabId) {
      throw new Error("No active tab available.");
    }

    switch (action) {
      case "request_permissions":
        return this.requestPermissions({ tabId, ...payload });
      case "list_tools":
        await this.ensureScopes(tabId, ["mcp:tools.list"]);
        return this.tools.listTools();
      case "call_tool":
        return this.callTool({ tabId, ...payload });
      case "run":
        await this.ensureScopes(tabId, ["model:prompt", "mcp:tools.call"]);
        return this.handleUserCommand(
          { tier: CapabilityTier.ACTOR, prompt: payload.prompt },
          sender
        );
      case "create_text_session":
        await this.ensureScopes(tabId, ["model:prompt"]);
        return this.createTextSession();
      case "text_prompt":
        await this.ensureScopes(tabId, ["model:prompt"]);
        return this.promptText(payload);
      case "get_features":
        return this.getFeatures(tabId);
      default:
        throw new Error(`Unknown agent action: ${action}`);
    }
  }

  async executePlan({ plan, tier, tabId }) {
    const results = [];
    for (const step of plan.steps || []) {
      const tool = this.tools.getTool(step.tool);
      if (!tool) {
        results.push({ ok: false, error: `Unknown tool: ${step.tool}` });
        continue;
      }

      this.capabilityManager.assertTierAllowed(tier, tool.tier);

      const actionLabel = `${tool.name} on tab ${tabId}`;
      const approved = await this.permissionGate.confirmAction({
        tier: tool.tier,
        action: actionLabel,
        tabId,
      });

      if (!approved) {
        this.emitThought(`User denied action: ${actionLabel}.`);
        results.push({ ok: false, error: "User denied action." });
        continue;
      }

      this.emitThought(`Executing ${tool.name}.`);
      const result = await tool.handler({
        tabId,
        ...step.input,
      });
      results.push({ ok: true, result });
    }

    return results;
  }

  async requestPermissions({ tabId, scopes = [], reason = "" }) {
    const { approved, ttlMs } = await this.permissionGate.requestScopes({
      tabId,
      scopes,
      reason,
    });
    return {
      approved,
      grantedScopes: approved ? scopes : [],
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    };
  }

  async ensureScopes(tabId, scopes) {
    const ok = await this.permissionGate.hasScopeAccess(tabId, scopes);
    if (!ok) {
      throw new Error(`Missing required scopes: ${scopes.join(", ")}`);
    }
  }

  async callTool({ tabId, name, input = {} }) {
    await this.ensureScopes(tabId, ["mcp:tools.call"]);

    const tool = this.tools.getTool(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    const requiredScope = this.scopeForTier(tool.tier);
    if (requiredScope) {
      await this.ensureScopes(tabId, [requiredScope]);
    }

    const actionLabel = `${tool.name} on tab ${tabId}`;
    const approved = await this.permissionGate.confirmAction({
      tier: tool.tier,
      action: actionLabel,
      tabId,
    });

    if (!approved) {
      throw new Error("User denied action.");
    }

    return tool.handler({ tabId, ...input });
  }

  scopeForTier(tier) {
    if (tier === CapabilityTier.NAVIGATOR) {
      return "browser:interact";
    }
    if (tier === CapabilityTier.ACTOR) {
      return "browser:control";
    }
    return null;
  }

  createTextSession() {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { createdAt: Date.now() });
    return { sessionId };
  }

  async promptText({ sessionId, text }) {
    if (sessionId && !this.sessions.has(sessionId)) {
      throw new Error("Invalid session.");
    }

    try {
      const responseText = await this.llm.generateText({ prompt: text });
      return { text: responseText };
    } catch (error) {
      this.emitThought("LLM proxy failed, using stub text.");
      const responseText = await this.fallbackLlm.generateText({ prompt: text });
      return { text: responseText };
    }
  }

  async getFeatures(tabId) {
    const canInteract = await this.permissionGate.hasScopeAccess(tabId, [
      "browser:interact",
    ]);
    const canControl = await this.permissionGate.hasScopeAccess(tabId, [
      "browser:control",
    ]);
    const toolCalling = await this.permissionGate.hasScopeAccess(tabId, [
      "mcp:tools.call",
    ]);

    return {
      toolCalling,
      browserInteraction: canInteract,
      browserControl: canControl,
    };
  }

  async getActiveTabId() {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    return tabs[0]?.id;
  }
}

const agent = new WebAgent();

function openSidebar() {
  if (api.sidebarAction && api.sidebarAction.open) {
    try {
      api.sidebarAction.open();
    } catch (error) {
      // Ignore if the browser does not allow programmatic open.
    }
  }
}

api.runtime.onInstalled.addListener(() => {
  agent.initialize();
  openSidebar();
});

api.tabs.onActivated.addListener(() => {
  openSidebar();
});

api.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.status === "complete") {
    openSidebar();
  }
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
