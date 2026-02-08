import { CapabilityManager, CapabilityTier } from "./capabilityManager.js";
import { PermissionGate } from "./permissionGate.js";
import { createMcpTools } from "./mcpTools.js";
import { ProxyLlmProvider, StubLlmProvider } from "./llmProvider.js";

export class WebAgent {
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
    chrome.runtime.sendMessage({ type: "thought", text });
  }

  emitChat(role, text) {
    if (!text) {
      return;
    }
    chrome.runtime.sendMessage({ type: "chat_message", role, text });
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
      });
    } catch (error) {
      this.emitThought(
        `LLM proxy failed: ${error?.message || String(error)}. Using stub plan.`
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

    return this.executePlan({ plan, tier: requiredTier, tabId });
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
      this.emitChat("agent", this.formatResult(result));
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
    this.emitChat("agent", this.formatResult(result));
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

  async promptText({ sessionId, text }) {
    if (sessionId && !this.sessions.has(sessionId)) {
      throw new Error("Invalid session.");
    }

    try {
      const responseText = await this.llm.generateText({ prompt: text });
      this.emitChat("agent", responseText);
      return { text: responseText };
    } catch (error) {
      this.emitThought(
        `LLM proxy failed: ${error?.message || String(error)}. Using stub text.`
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
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id;
  }

  async buildFallbackPlan({ prompt, tabId }) {
    const tab = await chrome.tabs.get(tabId);
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

    return null;
  }

  async adjustPlanForContext({ plan, prompt, tabId }) {
    if (!plan || !Array.isArray(plan.steps)) {
      return plan;
    }

    const tab = await chrome.tabs.get(tabId);
    const url = tab?.url || "";
    const lowerPrompt = prompt.toLowerCase();

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

    return plan;
  }
}
