import { createServer } from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { server } from "./index.js";

const HOST = process.env.MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.MCP_PORT || "8787");

let activeTransport: SSEServerTransport | null = null;
let activeSessionId: string | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let activeSseResponse: import("node:http").ServerResponse | null = null;

/** Tear down the current session so a new one can be created. */
async function teardownSession() {
  const t = activeTransport;
  activeTransport = null;
  activeSessionId = null;
  activeSseResponse = null;
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (t) {
    try { await t.close(); } catch { /* already closed */ }
  }
}

/** Send SSE keepalive comment to prevent socket timeout. */
function startKeepalive(res: import("node:http").ServerResponse) {
  // Stop any existing keepalive
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
  }
  activeSseResponse = res;
  // Send a comment every 15 seconds to keep the connection alive.
  // SSE comments (lines starting with ':') are ignored by clients but
  // prevent TCP idle timeout from killing the connection.
  keepaliveTimer = setInterval(() => {
    try {
      if (!res.destroyed && !res.writableEnded) {
        res.write(":keepalive\n\n");
      } else {
        // Response is gone — clean up
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      }
    } catch {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    }
  }, 5_000);
}

function setCors(res: import("node:http").ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "web-search-mcp-remote",
      activeSessionId,
      hasActiveTransport: Boolean(activeTransport),
      sseConnectionAlive: activeSseResponse ? !activeSseResponse.destroyed : false,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/mcp") {
    // If a session already exists, tear it down so the new connection can take over.
    // This handles Harbor reconnecting after a network hiccup or page reload.
    if (activeTransport) {
      console.log(`[web-search-mcp] Replacing stale session ${activeSessionId} with new connection`);
      await teardownSession();
    }

    try {
      // Disable socket timeouts on the SSE connection so it stays open indefinitely.
      req.socket.setTimeout(0);
      req.socket.setKeepAlive(true, 30_000);
      res.setTimeout(0);

      const hostHeader = req.headers.host || `${HOST}:${PORT}`;
      const endpointUrl = `http://${hostHeader}/messages`;
      const transport = new SSEServerTransport(endpointUrl, res);
      activeTransport = transport;
      activeSessionId = transport.sessionId;
      console.log(`[web-search-mcp] New SSE session: ${activeSessionId}`);

      // Start keepalive pings to prevent idle timeout
      startKeepalive(res);

      // Detect when the SSE response socket closes unexpectedly
      res.on("close", () => {
        if (activeTransport === transport) {
          console.log(`[web-search-mcp] SSE response closed for session ${transport.sessionId}`);
          activeTransport = null;
          activeSessionId = null;
          activeSseResponse = null;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
        }
      });

      transport.onclose = async () => {
        // Only clear if this is still the active transport (not already replaced)
        if (activeTransport === transport) {
          activeTransport = null;
          activeSessionId = null;
          activeSseResponse = null;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          console.log(`[web-search-mcp] Session ${transport.sessionId} closed`);
        }
      };

      await server.connect(transport);
      return;
    } catch (err) {
      activeTransport = null;
      activeSessionId = null;
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: `Failed to establish SSE MCP session: ${message}`,
        });
      }
      return;
    }
  }

  if (req.method === "POST" && pathname === "/messages") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      sendJson(res, 400, { error: "Missing sessionId query parameter" });
      return;
    }
    // If no active transport, wait briefly for Harbor to reconnect the SSE
    // connection before giving up. This handles the race where the SSE drops
    // mid-workflow and Harbor is in the process of re-establishing it.
    if (!activeTransport) {
      const MAX_WAIT_MS = 5000;
      const POLL_MS = 500;
      let waited = 0;
      console.log(`[web-search-mcp] No active transport for POST /messages, waiting up to ${MAX_WAIT_MS}ms for reconnect...`);
      while (!activeTransport && waited < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        waited += POLL_MS;
      }
      if (!activeTransport) {
        console.log(`[web-search-mcp] Gave up waiting for reconnect after ${waited}ms`);
        sendJson(res, 404, {
          error: "No active session. Please reconnect to GET /mcp.",
        });
        return;
      }
      console.log(`[web-search-mcp] Transport reconnected after ${waited}ms, routing message`);
    }
    // Be lenient about session ID — Harbor reconnects frequently, creating
    // new sessions. Route to the active transport regardless of which
    // session ID the client sends.
    if (sessionId !== activeSessionId) {
      console.log(
        `[web-search-mcp] Session mismatch (routing anyway): requested=${sessionId}, active=${activeSessionId}`,
      );
    }

    try {
      const parsedBody = await readJsonBody(req);
      await activeTransport.handlePostMessage(req, res, parsedBody);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: `Failed handling MCP message: ${message}` });
      }
      return;
    }
  }

  if (req.method === "DELETE" && pathname === "/mcp") {
    if (!activeTransport) {
      sendJson(res, 404, { error: "No active session" });
      return;
    }
    try {
      await teardownSession();
      sendJson(res, 200, { ok: true, message: "Session closed" });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: `Failed closing session: ${message}` });
      return;
    }
  }

  sendJson(res, 404, {
    error: "Not found",
    path: pathname,
    method: req.method,
  });
});

// Disable the server-level timeout so long-lived SSE connections aren't killed.
httpServer.timeout = 0;
httpServer.keepAliveTimeout = 0;

httpServer.listen(PORT, HOST, () => {
  console.log(`[web-search-mcp] Remote SSE server listening at http://${HOST}:${PORT}/mcp`);
});

process.on("SIGINT", async () => {
  try {
    await teardownSession();
    httpServer.close();
  } catch {
    // ignore
  } finally {
    process.exit(0);
  }
});
