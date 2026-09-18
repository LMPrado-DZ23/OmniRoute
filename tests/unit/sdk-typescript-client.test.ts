/**
 * Behaviour of the TypeScript SDK that the shared JSON fixtures cannot express: network
 * failures, timeouts, aborts, mid-stream failures, redaction and SSE framing.
 * Every call goes through an in-process fake fetch — no network, no provider calls.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import {
  CLIENT_ERROR_CODES,
  OmniRouteClient,
  OmniRouteError,
  extractEventData,
  parseRetryAfterMs,
  parseSseData,
  type FetchLike,
  type RequestDebugInfo,
} from "../../sdk/typescript/src/index.ts";

const encoder = new TextEncoder();
const CHAT = { model: "auto", messages: [{ role: "user", content: "Hi" }] };
const CHUNK = 'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function captureError(promise: Promise<unknown>): Promise<OmniRouteError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OmniRouteError, `expected OmniRouteError, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected the call to reject");
}

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const queue = [...parts];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
  });
}

describe("OmniRouteClient retries", () => {
  it("retries network errors with exponential backoff and keeps the request id", async () => {
    const ids: Array<string | null> = [];
    const delays: number[] = [];
    const fetch: FetchLike = async (_url, init) => {
      ids.push(new Headers(init.headers).get("x-request-id"));
      if (ids.length < 3) throw new TypeError("fetch failed");
      return jsonResponse({ object: "list", data: [] });
    };
    const client = new OmniRouteClient({
      fetch,
      retry: { maxRetries: 2, baseDelayMs: 100 },
      requestIdFactory: () => "req-fixed",
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0,
    });
    const response = await client.models.list();
    assert.equal(response.status, 200);
    assert.deepEqual(ids, ["req-fixed", "req-fixed", "req-fixed"]);
    assert.deepEqual(delays, [100, 200]);
  });

  it("raises network_error with status 0 once retries are exhausted", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      throw new TypeError("fetch failed");
    };
    const client = new OmniRouteClient({
      fetch,
      retry: { maxRetries: 1, baseDelayMs: 0 },
      sleep: async () => {},
    });
    const error = await captureError(client.models.list());
    assert.equal(calls, 2);
    assert.equal(error.status, 0);
    assert.equal(error.code, CLIENT_ERROR_CODES.network);
    assert.ok(error.cause instanceof TypeError);
  });

  it("caps Retry-After by maxDelayMs", async () => {
    const delays: number[] = [];
    const responses = [
      jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "120" }),
      jsonResponse({ status: "ok", timestamp: "t" }),
    ];
    const client = new OmniRouteClient({
      fetch: async () => responses.shift() ?? jsonResponse({}, 500),
      retry: { maxRetries: 1, maxDelayMs: 1_000 },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await client.health();
    assert.deepEqual(delays, [1_000]);
  });

  it("does not retry statuses outside retryOn, and retry:false disables network retries", async () => {
    let calls = 0;
    const statusClient = new OmniRouteClient({
      fetch: async () => {
        calls++;
        return jsonResponse({ error: { message: "down" } }, 503);
      },
      retry: { maxRetries: 3, retryOn: [] },
      sleep: async () => {},
    });
    assert.equal((await captureError(statusClient.health())).status, 503);
    assert.equal(calls, 1);

    let networkCalls = 0;
    const noRetryClient = new OmniRouteClient({
      fetch: async () => {
        networkCalls++;
        throw new TypeError("fetch failed");
      },
      retry: false,
    });
    assert.equal((await captureError(noRetryClient.health())).code, CLIENT_ERROR_CODES.network);
    assert.equal(networkCalls, 1);
  });

  it("aborts a pending backoff when the caller signal fires", async () => {
    const controller = new AbortController();
    const client = new OmniRouteClient({
      fetch: async () => jsonResponse({ error: { message: "down" } }, 503),
      retry: { maxRetries: 3, baseDelayMs: 60_000 },
    });
    setTimeout(() => controller.abort(), 10);
    const started = Date.now();
    const error = await captureError(client.health({ signal: controller.signal }));
    assert.equal(error.code, CLIENT_ERROR_CODES.aborted);
    assert.ok(Date.now() - started < 5_000, "backoff sleep must be interrupted");
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Closes a loopback server and lets fetch's pooled sockets finish closing: with --test-force-exit
 * on Windows, exiting while they close trips a libuv assertion (src/win/async.c).
 */
function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => setTimeout(resolve, 50)));
}

/** Two loopback servers on different ports: `origin` answers 302 to `target`. */
async function withRedirect(
  run: (originUrl: string, targetHeaders: IncomingHttpHeaders[]) => Promise<void>
): Promise<void> {
  const targetHeaders: IncomingHttpHeaders[] = [];
  const target = createServer((req, res) => {
    targetHeaders.push(req.headers);
    res.setHeader("connection", "close");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ object: "list", data: [] }));
  });
  const targetUrl = await listen(target);
  const origin = createServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader("connection", "close");
    res.setHeader("location", `${targetUrl}/elsewhere`);
    res.end();
  });
  const originUrl = await listen(origin);
  try {
    await run(originUrl, targetHeaders);
  } finally {
    await Promise.all([close(origin), close(target)]);
  }
}

describe("OmniRouteClient redirects (loopback servers only)", () => {
  it("never forwards a credential to a cross-origin redirect target", async () => {
    await withRedirect(async (originUrl, targetHeaders) => {
      const bearerOnly = new OmniRouteClient({
        baseUrl: originUrl,
        apiKey: "sk-redirect",
        retry: false,
      });
      assert.equal((await bearerOnly.models.list()).status, 200);
      assert.equal(targetHeaders.length, 1);
      assert.equal(targetHeaders[0]?.authorization, undefined, "fetch strips Authorization");

      const customCredential = new OmniRouteClient({
        baseUrl: originUrl,
        apiKey: "sk-redirect",
        headers: { "x-goog-api-key": "sk-goog", "x-api-key": "sk-anthropic-style" },
        retry: false,
      });
      const error = await captureError(customCredential.models.list());
      assert.equal(error.status, 302, "the redirect surfaces instead of being followed");
      assert.equal(targetHeaders.length, 1, "the redirect target must not be contacted again");
    });
  });
});

function refused(): TypeError {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
    code: "ECONNREFUSED",
  });
  return new TypeError("fetch failed", { cause });
}

describe("OmniRouteClient retries of non-idempotent POST requests", () => {
  const hangUntilAborted: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")), {
        once: true,
      });
    });

  it("never retries a chat completion after a timeout (the upstream may be generating)", async () => {
    let calls = 0;
    const client = new OmniRouteClient({
      fetch: (url, init) => {
        calls++;
        return hangUntilAborted(url, init);
      },
      timeoutMs: 20,
      retry: { maxRetries: 2, baseDelayMs: 0 },
      sleep: async () => {},
    });
    const error = await captureError(client.chat.completions.create(CHAT));
    assert.equal(error.code, CLIENT_ERROR_CODES.timeout);
    assert.equal(calls, 1);
  });

  it("does not retry a POST after a network error once the request may have been sent", async () => {
    let calls = 0;
    const client = new OmniRouteClient({
      fetch: async () => {
        calls++;
        throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
      },
      retry: { maxRetries: 2, baseDelayMs: 0 },
      sleep: async () => {},
    });
    assert.equal(
      (await captureError(client.chat.completions.create(CHAT))).code,
      CLIENT_ERROR_CODES.network
    );
    assert.equal(calls, 1);
  });

  it("retries a POST whose connection was refused (nothing reached the server)", async () => {
    let calls = 0;
    const client = new OmniRouteClient({
      fetch: async () => {
        calls++;
        if (calls === 1) throw refused();
        return jsonResponse({ id: "chatcmpl-1", object: "chat.completion", choices: [] });
      },
      retry: { maxRetries: 2, baseDelayMs: 0 },
      sleep: async () => {},
    });
    assert.equal((await client.chat.completions.create(CHAT)).status, 200);
    assert.equal(calls, 2);
  });

  it("recognises a real refused connection from fetch as not sent", async () => {
    const server = createServer();
    const baseUrl = await listen(server);
    await close(server);
    const attempts: number[] = [];
    const client = new OmniRouteClient({
      baseUrl,
      retry: { maxRetries: 1, baseDelayMs: 0 },
      onRequest: (info) => attempts.push(info.attempt),
      sleep: async () => {},
    });
    const error = await captureError(client.chat.completions.create(CHAT));
    assert.equal(error.code, CLIENT_ERROR_CODES.network);
    assert.deepEqual(attempts, [0, 1]);
  });

  it("retryNonIdempotent restores retries after a POST timeout", async () => {
    let calls = 0;
    const client = new OmniRouteClient({
      fetch: (url, init) => {
        calls++;
        return hangUntilAborted(url, init);
      },
      timeoutMs: 20,
      retry: { maxRetries: 1, baseDelayMs: 0, retryNonIdempotent: true },
      sleep: async () => {},
    });
    await captureError(client.chat.completions.create(CHAT));
    assert.equal(calls, 2);
  });

  it("jitters exponential backoff within (delay/2, delay] and never above maxDelayMs", async () => {
    const delays: number[] = [];
    const client = new OmniRouteClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      retry: { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 1_500 },
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.999,
    });
    await captureError(client.models.list());
    assert.deepEqual(delays, [501, 751, 751]);
    const low = new OmniRouteClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      retry: { maxRetries: 1, baseDelayMs: 1_000 },
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0,
    });
    await captureError(low.models.list());
    assert.equal(delays.at(-1), 1_000);
  });
});

describe("OmniRouteClient timeouts and aborts", () => {
  it("maps an elapsed timeout to code timeout", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted by signal")), {
          once: true,
        });
      });
    const client = new OmniRouteClient({ fetch, timeoutMs: 20, retry: false });
    const error = await captureError(client.health());
    assert.equal(error.code, CLIENT_ERROR_CODES.timeout);
    assert.equal(error.status, 0);
  });

  it("does not send anything when the caller signal is already aborted", async () => {
    let calls = 0;
    const client = new OmniRouteClient({
      fetch: async () => {
        calls++;
        return jsonResponse({});
      },
    });
    const controller = new AbortController();
    controller.abort();
    const error = await captureError(client.health({ signal: controller.signal }));
    assert.equal(error.code, CLIENT_ERROR_CODES.aborted);
    assert.equal(calls, 0);
  });
});

describe("ChatCompletionStream", () => {
  it("never retries once the stream has started, even with retries configured", async () => {
    let calls = 0;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode(CHUNK));
        else controller.error(new Error("connection reset"));
      },
    });
    const client = new OmniRouteClient({
      fetch: async () => {
        calls++;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
      retry: { maxRetries: 3, baseDelayMs: 0 },
      sleep: async () => {},
    });
    const stream = await client.chat.completions.stream(CHAT);
    const chunks: unknown[] = [];
    const error = await captureError(
      (async () => {
        for await (const chunk of stream) chunks.push(chunk);
      })()
    );
    assert.equal(error.code, CLIENT_ERROR_CODES.streamError);
    assert.equal(chunks.length, 1);
    assert.equal(calls, 1);
  });

  it("stream.abort() stops a pending read and raises aborted", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(CHUNK));
      },
    });
    const client = new OmniRouteClient({
      fetch: async () => new Response(body, { status: 200 }),
      retry: false,
    });
    const stream = await client.chat.completions.stream(CHAT);
    const chunks: unknown[] = [];
    const error = await captureError(
      (async () => {
        for await (const chunk of stream) {
          chunks.push(chunk);
          stream.abort();
        }
      })()
    );
    assert.equal(error.code, CLIENT_ERROR_CODES.aborted);
    assert.equal(chunks.length, 1);
  });

  it("the caller signal aborts an established stream", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encoder.encode(CHUNK));
      },
    });
    const client = new OmniRouteClient({ fetch: async () => new Response(body), retry: false });
    const stream = await client.chat.completions.stream(CHAT, { signal: controller.signal });
    const error = await captureError(
      (async () => {
        for await (const _chunk of stream) controller.abort();
      })()
    );
    assert.equal(error.code, CLIENT_ERROR_CODES.aborted);
  });

  it("can only be iterated once", async () => {
    const client = new OmniRouteClient({
      fetch: async () => new Response(streamOf([CHUNK, "data: [DONE]\n\n"])),
      retry: false,
    });
    const stream = await client.chat.completions.stream(CHAT);
    for await (const _chunk of stream) {
      // drain
    }
    const error = await captureError(
      (async () => {
        for await (const _chunk of stream) {
          // second pass must fail
        }
      })()
    );
    assert.equal(error.code, CLIENT_ERROR_CODES.streamConsumed);
  });
});

describe("OmniRouteClient request shaping", () => {
  it("rejects a 200 whose body is not a JSON object", async () => {
    const client = new OmniRouteClient({
      fetch: async () => new Response("<html>proxy page</html>", { status: 200 }),
      retry: false,
    });
    const error = await captureError(client.models.list());
    assert.equal(error.code, CLIENT_ERROR_CODES.invalidResponse);
    assert.equal(error.status, 200);
  });

  it("redacts credentials in debug output and keeps keys out of inspection", async () => {
    const seen: RequestDebugInfo[] = [];
    const client = new OmniRouteClient({
      apiKey: "sk-super-secret",
      managementKey: "mgmt-super-secret",
      fetch: async () => jsonResponse({ object: "list", data: [] }),
      onRequest: (info) => seen.push(info),
      retry: false,
    });
    await client.models.list();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.headers.authorization, "[REDACTED]");
    const dump = `${inspect(client, { depth: 5 })} ${JSON.stringify(client)} ${JSON.stringify(seen)}`;
    assert.ok(!dump.includes("sk-super-secret"), "API key leaked");
    assert.ok(!dump.includes("mgmt-super-secret"), "management key leaked");
  });

  it("redacts every credential header variant in the debug hook", async () => {
    const credentialHeaders: Record<string, string> = {
      authorization: "Bearer sk-a",
      "proxy-authorization": "Basic sk-b",
      cookie: "session=sk-c",
      "x-api-key": "sk-d",
      "x-goog-api-key": "sk-e",
      "x-omniroute-cli-token": "sk-f",
      "x-custom-secret": "sk-g",
    };
    const seen: RequestDebugInfo[] = [];
    const client = new OmniRouteClient({
      apiKey: "sk-h",
      headers: { ...credentialHeaders, "x-trace": "visible" },
      fetch: async () => jsonResponse({ object: "list", data: [] }),
      onRequest: (info) => seen.push(info),
      retry: false,
    });
    await client.models.list();
    const snapshot = seen[0]?.headers ?? {};
    for (const name of Object.keys(credentialHeaders)) {
      assert.equal(snapshot[name], "[REDACTED]", name);
    }
    assert.equal(snapshot["x-trace"], "visible");
    assert.equal(snapshot["x-request-id"], seen[0]?.clientRequestId);
    assert.ok(!JSON.stringify(seen).includes("sk-"), "a credential leaked into the debug hook");
  });

  it("normalizes the base URL, honours a per-call request id and generates UUIDs by default", async () => {
    const urls: string[] = [];
    const ids: Array<string | null> = [];
    const client = new OmniRouteClient({
      baseUrl: "http://gateway.test:8080/omniroute///",
      fetch: async (url, init) => {
        urls.push(url);
        ids.push(new Headers(init.headers).get("x-request-id"));
        return jsonResponse({ status: "ok", timestamp: "t" });
      },
      retry: false,
    });
    await client.health({ requestId: "caller-id" });
    await client.health();
    assert.deepEqual(urls, [
      "http://gateway.test:8080/omniroute/api/health",
      "http://gateway.test:8080/omniroute/api/health",
    ]);
    assert.equal(ids[0], "caller-id");
    assert.match(ids[1] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.throws(() => new OmniRouteClient({ baseUrl: "not a url" }), TypeError);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds, HTTP dates and rejects garbage", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    assert.equal(parseRetryAfterMs("2", now), 2_000);
    assert.equal(parseRetryAfterMs("1.5", now), 1_500);
    assert.equal(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:03 GMT", now), 3_000);
    assert.equal(parseRetryAfterMs("Wed, 21 Oct 2015 07:27:00 GMT", now), 0);
    assert.equal(parseRetryAfterMs("soon", now), undefined);
    assert.equal(parseRetryAfterMs("", now), undefined);
    assert.equal(parseRetryAfterMs(null, now), undefined);
  });
});

describe("parseSseData", () => {
  it("handles split reads, CRLF framing, multi-line data, comments and stops at [DONE]", async () => {
    const body = streamOf([
      'data: {"a"',
      ":1}\r\n\r\n: ping\n\nda",
      "ta: line1\ndata: line2\n\ndata: [DONE]\n\ndata: after-done\n\n",
    ]);
    const events: string[] = [];
    for await (const data of parseSseData(body)) events.push(data);
    assert.deepEqual(events, ['{"a":1}', "line1\nline2"]);
  });

  it("yields a trailing event without a final blank line", async () => {
    const events: string[] = [];
    for await (const data of parseSseData(streamOf(["data: tail"]))) events.push(data);
    assert.deepEqual(events, ["tail"]);
  });

  it("extractEventData ignores comment-only events", () => {
    assert.equal(extractEventData(": keep-alive"), null);
    assert.equal(extractEventData("event: message\ndata:x"), "x");
  });
});
