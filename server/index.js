import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
const port = Number(process.env.PORT) || 8787;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";

if (!apiKey) {
  console.warn("LLM_API_KEY is not set; proxy will not work.");
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/models", async (_req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ error: "LLM_API_KEY not configured." });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(502).json({ error: errorText });
    }

    const data = await response.json();
    const models = (data.models || []).map((model) => ({
      name: model.name,
      supportedMethods: model.supportedGenerationMethods || [],
    }));
    res.json({ models });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.post("/plan", async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ error: "LLM_API_KEY not configured." });
    }

    const { prompt, tools } = req.body || {};
    if (!prompt || !Array.isArray(tools)) {
      return res.status(400).json({ error: "Invalid payload." });
    }

    const system =
      "You are a planning engine. Return ONLY JSON with keys: intent (string), steps (array of {tool, input}). Use tools exactly as provided.";
    const toolList = tools
      .map((tool) => {
        const schema = tool.inputSchema
          ? JSON.stringify(tool.inputSchema)
          : "{}";
        return `- ${tool.name}: ${tool.description}\n  inputSchema: ${schema}`;
      })
      .join("\n");

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `${system}\n\nAvailable tools:\n${toolList}\n\nUser request:\n${prompt}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512,
        response_mime_type: "application/json",
      },
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(502).json({ error: errorText });
    }

    const data = await response.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "{\"intent\":\"\",\"steps\":[]}";

    const cleanedText = extractJson(text) || text;

    res.json({ text: cleanedText });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

function extractJson(value) {
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

app.post("/text", async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ error: "LLM_API_KEY not configured." });
    }

    const { prompt } = req.body || {};
    if (!prompt) {
      return res.status(400).json({ error: "Invalid payload." });
    }

    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 512,
      },
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(502).json({ error: errorText });
    }

    const data = await response.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    res.json({ text });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

app.listen(port, () => {
  console.log(`LLM proxy listening on http://localhost:${port}`);
});
