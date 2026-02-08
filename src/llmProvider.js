export class LlmProvider {
  async generatePlan({ prompt, tools }) {
    throw new Error("LLM provider not configured.");
  }

  async generateText({ prompt }) {
    throw new Error("LLM provider not configured.");
  }
}

export class ProxyLlmProvider extends LlmProvider {
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

export class StubLlmProvider extends LlmProvider {
  async generatePlan({ prompt, tools }) {
    return {
      intent: prompt,
      // Demo plan: use scrape_page for Tier 1, otherwise noop.
      steps: tools
        .filter((tool) => tool.name === "scrape_page")
        .map((tool) => ({ tool: tool.name, input: {} })),
    };
  }

  async generateText({ prompt }) {
    return `Stub response for: ${prompt}`;
  }
}
