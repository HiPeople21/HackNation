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

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const timeoutId = setTimeout(() => {
      if (!completed) {
        cleanup();
        reject(new Error("Timed out waiting for tab to load."));
      }
    }, timeoutMs);

    const cleanup = () => {
      completed = true;
      clearTimeout(timeoutId);
      if (api.tabs.onUpdated.hasListener(onUpdated)) {
        api.tabs.onUpdated.removeListener(onUpdated);
      }
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    };

    api.tabs.get(tabId, (tab) => {
      if (api.runtime.lastError) {
        cleanup();
        reject(new Error(api.runtime.lastError.message));
        return;
      }
      if (tab?.status === "complete") {
        cleanup();
        resolve();
        return;
      }
      api.tabs.onUpdated.addListener(onUpdated);
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
    name: "type_selector",
    description: "Type text into an input or textarea by CSS selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["selector", "text"],
    },
    tier: CapabilityTier.NAVIGATOR,
    handler: async ({ tabId, selector, text, submit }) => {
      const [result] = await executeScript({
        tabId,
        args: [selector, text, Boolean(submit)],
        func: (sel, value, shouldSubmit) => {
          const selectors = [sel];
          if (location.hostname.includes("amazon.")) {
            selectors.push("input#twotabsearchtextbox");
            selectors.push("input[name='field-keywords']");
          }

          let input = null;
          for (const candidate of selectors) {
            input = document.querySelector(candidate);
            if (input) {
              break;
            }
          }

          if (!input) {
            return { ok: false, message: "Selector not found." };
          }

          input.focus();
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          if (shouldSubmit) {
            const form = input.closest("form");
            if (form) {
              form.requestSubmit();
            } else {
              input.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "Enter",
                  code: "Enter",
                  bubbles: true,
                })
              );
            }
          }
          return { ok: true, message: "Typed." };
        },
      });
      emitThought(`Typed into selector: ${selector}.`);
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
  async generatePlan({ prompt, tools, tabId }) {
    throw new Error("LLM provider not configured.");
  }

  async generateText({ prompt, tabId }) {
    throw new Error("LLM provider not configured.");
  }
}

class HarborLlmProvider extends LlmProvider {
  constructor({ timeoutMs } = {}) {
    super();
    this.timeoutMs = timeoutMs || 30000;
    this.maxRetries = 3;
    this.retryDelayMs = 300;
  }

  async request({ tabId, type, prompt, tools }) {
    if (!tabId) {
      throw new Error("No active tab available.");
    }

    let lastError;
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        return await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error("Harbor request timed out."));
          }, this.timeoutMs);

          api.tabs.sendMessage(
            tabId,
            { type, prompt, tools },
            (response) => {
              clearTimeout(timeoutId);
              if (api.runtime.lastError) {
                reject(new Error(api.runtime.lastError.message));
                return;
              }
              if (!response?.ok) {
                reject(new Error(response?.error || "Harbor request failed."));
                return;
              }
              resolve(response.result);
            }
          );
        });
      } catch (error) {
        lastError = error;
        const message = (error?.message || String(error)).toLowerCase();
        if (!message.includes("receiving end does not exist")) {
          break;
        }
        try {
          await waitForTabComplete(tabId, this.timeoutMs);
        } catch (_error) {
          // Ignore and retry anyway.
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }

    throw lastError || new Error("Harbor request failed.");
  }

  async generatePlan({ prompt, tools, tabId }) {
    const result = await this.request({
      tabId,
      type: "harbor_plan",
      prompt,
      tools,
    });

    const text = extractJsonText(result?.text || "{}") || "{}";
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("Harbor returned non-JSON plan text.");
    }
  }

  async generateText({ prompt, tabId }) {
    const result = await this.request({
      tabId,
      type: "harbor_text",
      prompt,
    });
    return result?.text || "";
  }
}

function extractJsonText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  const candidate = value.slice(firstBrace, lastBrace + 1).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch (_error) {
    return null;
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
    this.llm = new HarborLlmProvider();
    this.fallbackLlm = new StubLlmProvider();
    this.sessions = new Map();
  }

  initialize() {
    this.emitThought("WebAgent initialized.");
  }

  emitThought(text) {
    api.runtime.sendMessage({ type: "thought", text }, () => {
      if (api.runtime.lastError) {
        // Side panel is not open; ignore.
      }
    });
  }

  emitChat(role, text) {
    if (!text) {
      return;
    }
    api.runtime.sendMessage({ type: "chat_message", role, text }, () => {
      if (api.runtime.lastError) {
        // Side panel is not open; ignore.
      }
    });
  }

  async handleUserCommand(message, sender) {
    const requestedTier = Number(message.tier) || null;
    const prompt = message.prompt || "";
    const tabId = sender.tab?.id || (await this.getActiveTabId());
    const source = message.source || "unknown";

    if (!tabId) {
      throw new Error("No active tab available.");
    }

    this.emitThought("Received prompt. Evaluating required permissions.");

    if (prompt && source !== "sidepanel") {
      this.emitChat("user", prompt);
    }

    let plan;
    try {
      plan = await this.llm.generatePlan({
        prompt,
        tools: this.getToolDescriptors(),
        tabId,
      });
    } catch (error) {
      this.emitThought(
        `LLM provider failed: ${error?.message || String(error)}. Using stub plan.`
      );
      plan = await this.fallbackLlm.generatePlan({
        prompt,
        tools: this.getToolDescriptors(),
      });
    }

      if (!plan?.steps?.length) {
        const fallback = await this.buildFallbackPlan({ prompt, tabId });
        if (fallback) {
          plan = fallback;
        } else {
          const response = await this.promptText({ text: prompt, tabId });
          return [{ ok: true, result: response }];
        }
      }

    plan = await this.adjustPlanForContext({ plan, prompt, tabId });

    const requiredTier = requestedTier || this.requiredTierFromPlan(plan);
    const requiredScopes = this.scopesForPlan(plan);
    const approved = await this.ensureOrRequestScopes({
      tabId,
      scopes: requiredScopes,
      reason: this.buildScopeReason({ scopes: requiredScopes, plan }),
    });

    if (!approved) {
      const messageText = "User denied required scopes for this plan.";
      this.emitThought(messageText);
      this.emitChat("system", messageText);
      return [{ ok: false, error: messageText }];
    }

    this.emitThought(
      `Executing plan at ${this.capabilityManager.getTierName(requiredTier)} tier.`
    );

      const results = await this.executePlan({ plan, tier: requiredTier, tabId });
      await this.emitFinalResponse({ prompt, results, tabId });
      return results;
  }

  async handleAgentRequest(message, sender) {
    const action = message.action;
    const payload = message.payload || {};
    const tabId = sender.tab?.id || (await this.getActiveTabId());
    const source = message.source || "unknown";

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
        return this.callTool({ tabId, ...payload, source });
      case "run":
        await this.ensureScopes(tabId, ["model:prompt", "mcp:tools.call"]);
        if (payload.prompt && source !== "sidepanel") {
          this.emitChat("user", payload.prompt);
        }
        return this.handleUserCommand(
          { tier: CapabilityTier.ACTOR, prompt: payload.prompt, source },
          sender
        );
      case "create_text_session":
        await this.ensureScopes(tabId, ["model:prompt"]);
        return this.createTextSession();
      case "text_prompt":
        await this.ensureScopes(tabId, ["model:prompt"]);
        if (payload.text && source !== "sidepanel") {
          this.emitChat("user", payload.text);
        }
        return this.promptText({ ...payload, tabId });
      case "get_features":
        return this.getFeatures(tabId);
      default:
        throw new Error(`Unknown agent action: ${action}`);
    }
  }

  async executePlan({ plan, tier, tabId }) {
    const results = [];
    let previousTool = null;
    for (const step of plan.steps || []) {
      const tool = this.tools.getTool(step.tool);
      if (!tool) {
        const errorText = `Unknown tool: ${step.tool}`;
        this.emitChat("system", errorText);
        results.push({ ok: false, error: errorText });
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
        const errorText = `User denied action: ${actionLabel}.`;
        this.emitThought(errorText);
        this.emitChat("system", errorText);
        results.push({ ok: false, error: "User denied action." });
        continue;
      }

      if (previousTool === "navigate_to") {
        try {
          await waitForTabComplete(tabId);
        } catch (_error) {
          this.emitThought("Navigation did not complete before tool execution.");
        }
      }

      this.emitThought(`Executing ${tool.name}.`);
      const validationError = this.validateToolInput(tool, step.input);
      if (validationError) {
        this.emitThought(validationError);
        this.emitChat("system", validationError);
        results.push({ ok: false, error: validationError });
        continue;
      }

      const result = await tool.handler({
        tabId,
        ...step.input,
      });
      this.emitChat("agent", `${tool.name}: ${this.formatResult(result)}`);
      results.push({ ok: true, tool: tool.name, result });
      previousTool = tool.name;
    }

    return results;
  }

  async emitFinalResponse({ prompt, results, tabId }) {
    if (!Array.isArray(results) || results.length === 0) {
      return;
    }

    const toolSummary = results
      .map((entry) => {
        const tool = entry.tool || "tool";
        return `- ${tool}: ${this.formatResult(entry.result)}`;
      })
      .join("\n");

    const summaryPrompt =
      `User request: ${prompt}\n\n` +
      `Tool results:\n${toolSummary}\n\n` +
      "Provide a helpful, concise answer based on the tool results.";

    try {
      const responseText = await this.llm.generateText({ prompt: summaryPrompt, tabId });
      this.emitChat("agent", responseText);
    } catch (error) {
      this.emitThought(
        `LLM provider failed: ${error?.message || String(error)}. Using stub text.`
      );
      const responseText = await this.fallbackLlm.generateText({ prompt: summaryPrompt });
      this.emitChat("agent", responseText);
    }
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

  async ensureOrRequestScopes({ tabId, scopes, reason }) {
    if (!scopes.length) {
      return true;
    }

    const alreadyGranted = await this.permissionGate.hasScopeAccess(tabId, scopes);
    if (alreadyGranted) {
      return true;
    }

    const { approved } = await this.permissionGate.requestScopes({
      tabId,
      scopes,
      reason,
    });
    return approved;
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
    const validationError = this.validateToolInput(tool, input);
    if (validationError) {
      this.emitThought(validationError);
      this.emitChat("system", validationError);
      throw new Error(validationError);
    }

    const approved = await this.permissionGate.confirmAction({
      tier: tool.tier,
      action: actionLabel,
      tabId,
    });

    if (!approved) {
      const errorText = `User denied action: ${actionLabel}.`;
      this.emitChat("system", errorText);
      throw new Error("User denied action.");
    }

    const result = await tool.handler({ tabId, ...input });
    this.emitChat("agent", `${tool.name}: ${this.formatResult(result)}`);
    return result;
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

  scopesForPlan(plan) {
    const scopes = new Set(["model:prompt", "mcp:tools.call"]);
    for (const step of plan.steps || []) {
      const tool = this.tools.getTool(step.tool);
      if (!tool) {
        continue;
      }
      const scope = this.scopeForTier(tool.tier);
      if (scope) {
        scopes.add(scope);
      }
    }
    return Array.from(scopes);
  }

  buildScopeReason({ scopes, plan }) {
    const reasons = {
      "model:prompt": "Generate plan and responses",
      "mcp:tools.call": "Execute approved tools",
      "browser:interact": "Interact with the page (click/scroll)",
      "browser:control": "Control tabs and navigation",
    };

    const toolNames = (plan.steps || [])
      .map((step) => step.tool)
      .filter(Boolean);
    const uniqueTools = Array.from(new Set(toolNames));
    const toolText = uniqueTools.length
      ? `Tools: ${uniqueTools.join(", ")}`
      : "Tools: (none)";

    const scopeLines = scopes
      .map((scope) => `- ${scope}: ${reasons[scope] || "Required by plan"}`)
      .join("\n");

    return `Requested scopes for this plan:\n${scopeLines}\n${toolText}`;
  }

  requiredTierFromPlan(plan) {
    let tier = CapabilityTier.ORACLE;
    for (const step of plan.steps || []) {
      const tool = this.tools.getTool(step.tool);
      if (tool && tool.tier > tier) {
        tier = tool.tier;
      }
    }
    return tier;
  }

  createTextSession() {
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { createdAt: Date.now() });
    return { sessionId };
  }

  async promptText({ sessionId, text, tabId }) {
    if (sessionId && !this.sessions.has(sessionId)) {
      throw new Error("Invalid session.");
    }

    try {
      const responseText = await this.llm.generateText({ prompt: text, tabId });
      this.emitChat("agent", responseText);
      return { text: responseText };
    } catch (error) {
      this.emitThought(
        `LLM provider failed: ${error?.message || String(error)}. Using stub text.`
      );
      const responseText = await this.fallbackLlm.generateText({ prompt: text });
      this.emitChat("agent", responseText);
      return { text: responseText };
    }
  }

  formatResult(result) {
    if (typeof result === "string") {
      return this.truncate(result);
    }
    if (result == null) {
      return "(no result)";
    }
    try {
      return this.truncate(JSON.stringify(result, null, 2));
    } catch (_error) {
      return String(result);
    }
  }

  validateToolInput(tool, input = {}) {
    const required = tool?.inputSchema?.required || [];
    if (!required.length) {
      return null;
    }

    const missing = required.filter(
      (key) => input?.[key] === undefined || input?.[key] === null || input?.[key] === ""
    );
    if (!missing.length) {
      return null;
    }

    return `Missing required input for ${tool.name}: ${missing.join(", ")}.`;
  }

  getToolDescriptors() {
    return this.tools.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      tier: tool.tier,
    }));
  }

  truncate(value, maxLength = 1200) {
    if (typeof value !== "string") {
      return String(value);
    }
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}...`;
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

  async buildFallbackPlan({ prompt, tabId }) {
    const tab = await new Promise((resolve) => api.tabs.get(tabId, resolve));
    const url = tab?.url || "";
    const lowerPrompt = prompt.toLowerCase();

    if (url.includes("amazon.") && /(find|best|buy)/.test(lowerPrompt)) {
      const query = lowerPrompt.includes("mice") || lowerPrompt.includes("mouse")
        ? "best mice"
        : prompt;
      return {
        intent: prompt,
        steps: [
          {
            tool: "type_selector",
            input: {
              selector: "input#twotabsearchtextbox",
              text: query,
              submit: true,
            },
          },
        ],
      };
    }

    if (!url.includes("amazon.") && /(find|best|buy)/.test(lowerPrompt)) {
      const query = lowerPrompt.includes("mice") || lowerPrompt.includes("mouse")
        ? "gaming mouse"
        : prompt;
      return {
        intent: prompt,
        steps: [
          {
            tool: "navigate_to",
            input: { url: `https://www.amazon.com/s?k=${encodeURIComponent(query)}` },
          },
          {
            tool: "scrape_page",
            input: {},
          },
        ],
      };
    }

    return null;
  }

  async adjustPlanForContext({ plan, prompt, tabId }) {
    if (!plan || !Array.isArray(plan.steps)) {
      return plan;
    }

    const tab = await new Promise((resolve) => api.tabs.get(tabId, resolve));
    const url = tab?.url || "";
    const lowerPrompt = prompt.toLowerCase();
    const searchyPrompt = /(find|best|buy)/.test(lowerPrompt);
    const hasNavigate = plan.steps.some((step) => step.tool === "navigate_to");

    if (searchyPrompt && url.includes("google.") && !hasNavigate) {
      const fallback = await this.buildFallbackPlan({ prompt, tabId });
      if (fallback) {
        this.emitThought("Replacing plan to avoid scraping Google settings.");
        return fallback;
      }
    }

    if (url.includes("amazon.") && !/(google|bing|duckduckgo)/.test(lowerPrompt)) {
      const hasExternalNav = plan.steps.some((step) => {
        if (step.tool !== "navigate_to") {
          return false;
        }
        const target = step.input?.url || "";
        return target && !target.includes("amazon.");
      });

      if (hasExternalNav) {
        const fallback = await this.buildFallbackPlan({ prompt, tabId });
        if (fallback) {
          this.emitThought("Replacing plan to stay on current site.");
          return fallback;
        }
      }
    }

    const onlyScrape = plan.steps.length === 1 && plan.steps[0].tool === "scrape_page";
    if (onlyScrape && searchyPrompt) {
      const fallback = await this.buildFallbackPlan({ prompt, tabId });
      if (fallback) {
        this.emitThought("Replacing plan to perform a targeted search.");
        return fallback;
      }
    }

    return plan;
  }
}

const agent = new WebAgent();

api.runtime.onInstalled.addListener(() => {
  agent.initialize();
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

