import test from "node:test";
import assert from "node:assert/strict";

const MEMORY_ITEMS = [
  {
    id: "mem_001",
    type: "user",
    content: "User prefers dark mode",
    score: 0.95,
    createdAt: "2026-05-10T10:00:00Z",
  },
  {
    id: "mem_002",
    type: "project",
    content: "Project uses Next.js 16",
    score: 0.88,
    createdAt: "2026-05-09T12:00:00Z",
  },
];

function makeResp(data: unknown, status = 200) {
  const obj = {
    ok: status < 400,
    status,
    exitCode: status < 400 ? 0 : 1,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  };
  obj.json = obj.json.bind(obj);
  obj.text = obj.text.bind(obj);
  return obj;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c: string | Uint8Array) => {
    if (typeof c === "string") chunks.push(c);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

function makeCmd(output = "json") {
  return { optsWithGlobals: () => ({ output, quiet: output !== "table" }) };
}

test("runMemorySearch retorna items como array JSON", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(makeResp({ items: MEMORY_ITEMS }))) as any;

  const { runMemorySearch } = await import("../../bin/cli/commands/memory.mjs");
  const out = await captureStdout(() =>
    runMemorySearch("dark mode", { limit: 20 }, makeCmd() as any)
  );

  globalThis.fetch = origFetch;
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed[0].id, "mem_001");
  assert.equal(parsed[0].type, "user");
});

test("runMemorySearch envia q e type na query", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp({ items: MEMORY_ITEMS }));
  }) as any;

  const { runMemorySearch } = await import("../../bin/cli/commands/memory.mjs");
  await captureStdout(() =>
    runMemorySearch("react hooks", { limit: 10, type: "project" }, makeCmd() as any)
  );

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("q=react") && capturedUrl.includes("hooks"));
  // Plan 21 / D17: legacy 'project' is remapped to canonical 'factual' by
  // applyLegacyTypeMap in the CLI before reaching the backend.
  assert.ok(capturedUrl.includes("type=factual"));
  assert.ok(!capturedUrl.includes("type=project"));
  assert.ok(capturedUrl.includes("limit=10"));
});

test("runMemoryAdd envia POST com content, key e type", async () => {
  // Plan 21 / D17: legacy 'user' type is mapped to canonical 'factual'.
  let capturedUrl = "";
  let capturedInit: any = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init: any) => {
    capturedUrl = url;
    capturedInit = init;
    return Promise.resolve(makeResp({ id: "mem_new", type: "factual", content: "test content" }));
  }) as any;

  const { runMemoryAdd } = await import("../../bin/cli/commands/memory.mjs");
  await captureStdout(() =>
    runMemoryAdd({ content: "test content", key: "test-key", type: "user" }, makeCmd() as any)
  );

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/memory"));
  assert.equal(capturedInit?.method, "POST");
  const body = JSON.parse(capturedInit?.body);
  assert.equal(body.content, "test content");
  assert.equal(body.key, "test-key", "the route requires a key");
  // Legacy 'user' is remapped to canonical 'factual' by CLI (plan 21 / D17).
  assert.equal(body.type, "factual");
});

test("runMemoryList retorna items sem q", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp({ items: MEMORY_ITEMS }));
  }) as any;

  const { runMemoryList } = await import("../../bin/cli/commands/memory.mjs");
  const out = await captureStdout(() => runMemoryList({ limit: 100 }, makeCmd() as any));

  globalThis.fetch = origFetch;
  assert.ok(!capturedUrl.includes("q="));
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
});

test("runMemoryGet busca /api/memory/:id", async () => {
  let capturedUrl = "";
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => {
    capturedUrl = url;
    return Promise.resolve(makeResp(MEMORY_ITEMS[0]));
  }) as any;

  const { runMemoryGet } = await import("../../bin/cli/commands/memory.mjs");
  const out = await captureStdout(() => runMemoryGet("mem_001", {}, makeCmd() as any));

  globalThis.fetch = origFetch;
  assert.ok(capturedUrl.includes("/api/memory/mem_001"));
  const parsed = JSON.parse(out);
  assert.equal(parsed.id, "mem_001");
});

test("runMemoryHealth retorna status do subsistema", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(makeResp({ status: "healthy", fts5: true, qdrant: true }))) as any;

  const { runMemoryHealth } = await import("../../bin/cli/commands/memory.mjs");
  const out = await captureStdout(() => runMemoryHealth({}, makeCmd() as any));

  globalThis.fetch = origFetch;
  const parsed = JSON.parse(out);
  assert.equal(parsed.status, "healthy");
});

test("runMemoryClear --yes lista com filtro de type e apaga por id", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init: any) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if ((init?.method ?? "GET") === "GET") {
      return Promise.resolve(
        makeResp({ data: [{ id: "mem_1", createdAt: "2026-01-01T00:00:00Z" }], totalPages: 1 })
      );
    }
    return Promise.resolve(makeResp({ success: true }));
  }) as any;

  const { runMemoryClear } = await import("../../bin/cli/commands/memory.mjs");
  await captureStdout(() => runMemoryClear({ yes: true, type: "project" }, makeCmd() as any));

  globalThis.fetch = origFetch;
  const list = calls.find((c) => c.method === "GET");
  assert.ok(list, "clear lista as memórias antes de apagar");
  // Plan 21 / D17: legacy 'project' is remapped to canonical 'factual' by
  // applyLegacyTypeMap in the CLI before reaching the backend.
  assert.ok(list.url.includes("type=factual"));
  assert.ok(!list.url.includes("type=project"));
  const remove = calls.find((c) => c.method === "DELETE");
  assert.ok(remove, "cada entrada é apagada em /api/memory/{id}");
  assert.ok(remove.url.includes("/api/memory/mem_1"));
});
