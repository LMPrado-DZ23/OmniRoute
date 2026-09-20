/**
 * Shared MCP JSON-RPC client for CLI commands.
 *
 * The server exposes MCP through /api/mcp/stream (Streamable HTTP transport).
 * Calling a tool requires:
 *   1. POST initialize → get Mcp-Session-Id response header
 *   2. POST tools/call with that session header
 *
 * Older CLI paths POSTed { name, arguments } to /api/mcp/tools/call, which is
 * not a registered route, so every MCP-backed command was broken.
 *
 * Streamable HTTP requires every POST to accept BOTH application/json and
 * text/event-stream (the server answers 406 otherwise), requires the
 * Mcp-Session-Id from initialize on every later request, and may answer a
 * request with an SSE stream instead of a JSON body.
 *
 * These functions route through apiFetch so CLI auth, remote contexts and
 * timeouts are handled the same way as every other management API call.
 */
import { apiFetch } from "./api.mjs";

function mcpError(message, status) {
  const err = new Error(message);
  if (status) err.status = status;
  return err;
}

const MCP_ACCEPT = "application/json, text/event-stream";

async function callMcpEndpoint(payload, { timeout, sessionId, extraHeaders = {} }) {
  const res = await apiFetch("/api/mcp/stream", {
    method: "POST",
    body: payload,
    timeout,
    acceptNotOk: true,
    headers: {
      ...extraHeaders,
      Accept: MCP_ACCEPT,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw mcpError(
      `${payload.method} ${payload.id}: HTTP ${res.status}${text ? ` — ${text}` : ""}`,
      res.status
    );
  }
  return res;
}

/**
 * Call an MCP tool over /api/mcp/stream.
 *
 * Non-stream: returns the JSON-RPC result payload.
 * Stream: writes SSE `data:` chunks to stdout and returns null on success.
 */
export async function mcpCallTool(name, args = {}, options = {}) {
  const { timeout, scope } = options;
  const scopeHeader = scope?.length ? { "X-MCP-Scopes": scope.join(",") } : {};

  const initRes = await callMcpEndpoint(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omniroute-cli", version: "1.0" },
      },
    },
    { timeout, extraHeaders: scopeHeader }
  );

  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) {
    throw mcpError("MCP initialize failed: no Mcp-Session-Id in response", 500);
  }
  // Drain the initialize answer (JSON or a one-shot SSE stream) so the
  // connection is released before the next request.
  await readJsonRpc(initRes, 1).catch(() => null);

  const callRes = await callMcpEndpoint(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    },
    { timeout, sessionId, extraHeaders: scopeHeader }
  );

  try {
    if (options.stream) {
      return await consumeSse(callRes.body, options.onChunk);
    }
    return unwrapToolResult(await readJsonRpc(callRes, 2));
  } finally {
    await closeSession(sessionId, timeout);
  }
}

function unwrapToolResult(data) {
  if (data.error) {
    const err = mcpError(`MCP error: ${data.error.message || JSON.stringify(data.error)}`);
    err.code = data.error.code;
    throw err;
  }
  if (data.result?.isError) {
    const msg = data.result?.content?.[0]?.text || "unknown tool error";
    throw mcpError(`MCP error: ${msg}`, 500);
  }
  return toolPayload(data.result);
}

/**
 * MCP tools answer `{ content: [{ type: "text", text }], structuredContent? }`.
 * Callers want the tool's own payload: prefer structuredContent, else a single
 * JSON text block, else the raw result.
 */
function toolPayload(result) {
  if (!result || typeof result !== "object") return result;
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const blocks = Array.isArray(result.content) ? result.content : null;
  if (blocks && blocks.length === 1 && blocks[0]?.type === "text") {
    try {
      return JSON.parse(blocks[0].text);
    } catch {
      return result;
    }
  }
  return result;
}

/** A JSON-RPC response arrives either as a JSON body or as SSE `data:` events. */
async function readJsonRpc(res, id) {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) return res.json();
  const text = await res.text();
  let match = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw) continue;
    try {
      const message = JSON.parse(raw);
      if (message && message.id === id) match = message;
    } catch {
      // not a JSON-RPC frame — ignore
    }
  }
  if (!match) throw mcpError(`MCP response for request ${id} not found in event stream`, 502);
  return match;
}

/** Best-effort: release the server-side session (DELETE with the session id). */
async function closeSession(sessionId, timeout) {
  try {
    await apiFetch("/api/mcp/stream", {
      method: "DELETE",
      timeout,
      retry: false,
      acceptNotOk: true,
      headers: { "Mcp-Session-Id": sessionId },
    });
  } catch {
    // the session expires server-side anyway
  }
}

async function consumeSse(body, onChunk) {
  if (!body) throw mcpError("MCP stream returned no body", 500);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const flushLines = () => {
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        if (raw && raw !== "[DONE]") (onChunk ?? writeStdout)(raw);
      }
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    flushLines();
  }
  buf += decoder.decode();
  flushLines();
  return null;
}

function writeStdout(raw) {
  process.stdout.write(raw + "\n");
}
