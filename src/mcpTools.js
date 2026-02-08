import { CapabilityTier } from "./capabilityManager.js";

export class ToolRegistry {
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

export function createMcpTools({ emitThought }) {
  const registry = new ToolRegistry();

  registry.defineTool({
    name: "scrape_page",
    description: "Extract visible text from the current page.",
    inputSchema: { type: "object", properties: {} },
    tier: CapabilityTier.ORACLE,
    handler: async ({ tabId }) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
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
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
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
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
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
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
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
      await chrome.tabs.update(tabId, { url });
      emitThought(`Navigating tab ${tabId} to ${url}.`);
      return { ok: true };
    },
  });

  return registry;
}
