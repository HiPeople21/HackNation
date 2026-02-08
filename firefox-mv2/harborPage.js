const CHANNEL = "harbor-bridge";

window.addEventListener("message", async (event) => {
  if (event.source !== window) {
    return;
  }

  const { data } = event;
  if (!data || data.channel !== CHANNEL || data.direction !== "to-page") {
    return;
  }

  const { requestId, prompt, tools, mode } = data;
  try {
    const ai = window.ai;
    const agent = window.agent;

    if (!ai || !agent) {
      throw new Error("Harbor Web Agents API not available on this page.");
    }

    await agent.requestPermissions({
      scopes: ["model:prompt"],
      reason: "Run chat prompt",
    });

    const response = await runPrompt(ai, prompt || "", {
      mode: mode || "chat",
      tools,
    });

    window.postMessage(
      {
        channel: CHANNEL,
        direction: "to-content",
        requestId,
        ok: true,
        result: { text: response },
      },
      "*"
    );
  } catch (error) {
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "to-content",
        requestId,
        ok: false,
        error: error?.message || String(error),
      },
      "*"
    );
  }
});

async function runPrompt(ai, text, options) {
  const attempts = 3;
  let lastError;
  const modelOptions = await resolveModelOptions(ai);
  const mode = options?.mode || "chat";
  const tools = Array.isArray(options?.tools) ? options.tools : [];
  const systemPrompt =
    mode === "plan"
      ? "You are a planning engine. Return ONLY JSON with keys: intent (string), steps (array of {tool, input}). Use tools exactly as provided."
      : "You are a helpful assistant.";
  const temperature = mode === "plan" ? 0.2 : 0.7;
  const promptText = mode === "plan" ? buildPlanPrompt(text, tools) : text;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const session = await createLanguageModelSession(ai, {
        ...modelOptions,
        systemPrompt,
        temperature,
      });
      return await session.prompt(promptText);
    } catch (error) {
      const message = (error?.message || String(error)).toLowerCase();
      lastError = error;
      if (
        message.includes("session not found") ||
        message.includes("no model specified") ||
        message.includes("provider")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("Failed to create Harbor session.");
}

async function createLanguageModelSession(ai, modelOptions) {
  if (!ai.languageModel?.create) {
    const session = await ai.createTextSession(modelOptions);
    if (!session || typeof session.prompt !== "function") {
      throw new Error("Harbor session did not initialize correctly.");
    }
    return session;
  }

  const session = await ai.languageModel.create({
    systemPrompt: modelOptions.systemPrompt,
    temperature: modelOptions.temperature,
    provider: modelOptions.provider,
    model: modelOptions.model,
  });

  if (!session || typeof session.prompt !== "function") {
    throw new Error("Harbor language model session did not initialize correctly.");
  }

  return session;
}


async function resolveModelOptions(ai) {
  try {
    const active = await ai.providers.getActive();
    const provider = active?.provider || "ollama";
    let model = active?.model || "llama3.2:latest";
    if (model.startsWith("ollama:")) {
      model = model.replace("ollama:", "");
    }
    return { provider, model };
  } catch (_error) {
    return { provider: "ollama", model: "llama3.2:latest" };
  }
}

function buildPlanPrompt(prompt, tools) {
  const toolList = tools
    .map((tool) => {
      const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : "{}";
      return `- ${tool.name}: ${tool.description || ""}\n  inputSchema: ${schema}`;
    })
    .join("\n");

  return `Available tools:\n${toolList}\n\nUser request:\n${prompt}`;
}
