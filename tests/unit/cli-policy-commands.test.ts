import test from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerPolicy, runPolicyList, runPolicyUnlock } from "../../bin/cli/commands/policy.mjs";

// `omniroute policy` administers the login lockout behind /api/policies
// (src/app/api/policies/route.ts: GET lists locked identifiers, POST
// {action:"unlock", identifier} force-unlocks one). It used to advertise a
// policy CRUD/evaluate/export/import API that no route implements.

type Captured = { url: string; method: string; body: unknown };

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(t: test.TestContext, reply: Response, captured: Captured[]) {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const rawBody = typeof init?.body === "string" ? init.body : null;
    captured.push({
      url,
      method: init?.method ?? "GET",
      body: rawBody === null ? null : JSON.parse(rawBody),
    });
    return reply;
  });
}

function captureStdout(t: test.TestContext): string[] {
  const chunks: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return chunks;
}

const jsonCmd = { optsWithGlobals: () => ({ output: "json", quiet: true }) };

test("policy list reads the locked login identifiers from GET /api/policies", async (t) => {
  const locked = [
    { identifier: "admin@203.0.113.9", lockedUntil: 1_900_000_000_000, remainingMs: 60_000 },
  ];
  const captured: Captured[] = [];
  mockFetch(t, jsonResponse({ lockedIdentifiers: locked }), captured);
  const out = captureStdout(t);

  await runPolicyList({}, jsonCmd);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, "GET");
  assert.equal(new URL(captured[0].url).pathname, "/api/policies");
  assert.equal(new URL(captured[0].url).search, "", "the lockout endpoint takes no query filters");
  assert.deepEqual(JSON.parse(out.join("")), locked);
});

test("policy list prints an empty list when nothing is locked", async (t) => {
  const captured: Captured[] = [];
  mockFetch(t, jsonResponse({ lockedIdentifiers: [] }), captured);
  const out = captureStdout(t);

  await runPolicyList({}, jsonCmd);

  assert.deepEqual(JSON.parse(out.join("")), []);
});

test("policy unlock posts {action:'unlock', identifier} to /api/policies", async (t) => {
  const captured: Captured[] = [];
  mockFetch(
    t,
    jsonResponse({ success: true, action: "unlocked", identifier: "admin@203.0.113.9" }),
    captured
  );
  const out = captureStdout(t);

  await runPolicyUnlock("admin@203.0.113.9", {}, jsonCmd);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, "POST");
  assert.equal(new URL(captured[0].url).pathname, "/api/policies");
  assert.deepEqual(captured[0].body, { action: "unlock", identifier: "admin@203.0.113.9" });
  assert.equal(JSON.parse(out.join("")).action, "unlocked");
});

test("policy unlock exits 1 when the server rejects the request", async (t) => {
  const captured: Captured[] = [];
  mockFetch(t, jsonResponse({ error: "Unknown action" }, 400), captured);
  t.mock.method(process.stderr, "write", () => true);
  const exitCodes: number[] = [];
  t.mock.method(process, "exit", (code?: number) => {
    exitCodes.push(code ?? 0);
  });

  await runPolicyUnlock("nobody", {}, jsonCmd);

  assert.deepEqual(exitCodes, [1]);
});

test("policy registers only the subcommands backed by a real endpoint", () => {
  const program = new Command();
  registerPolicy(program);
  const policy = program.commands.find((c) => c.name() === "policy");
  assert.ok(policy, "policy command must be registered");
  assert.deepEqual(policy.commands.map((c) => c.name()).sort(), ["list", "unlock"]);
  for (const removed of ["get", "create", "update", "delete", "evaluate", "export", "import"]) {
    assert.equal(
      policy.commands.some((c) => c.name() === removed),
      false,
      `policy ${removed} has no backing endpoint and must not be offered`
    );
  }
});
