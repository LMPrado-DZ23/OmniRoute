import test from "node:test";
import assert from "node:assert/strict";

// The eval routes are: GET /api/evals (suites + recent runs + scorecard),
// POST /api/evals (run a suite, synchronously, body = evalRunSuiteSchema),
// POST /api/evals/suites (create) and GET/PUT/DELETE /api/evals/suites/{id}.
// These fixtures pin the request/response shapes the CLI relies on; the
// commands are also run against the real handlers in
// tests/unit/cli/cli-eval-routes.test.ts.

const SUITE = {
  id: "suite-001",
  name: "Chat quality",
  samples: 50,
  rubric: "accuracy",
  updatedAt: "2026-05-14T10:00:00Z",
};

const RUN = {
  id: "run-001",
  suiteId: "suite-001",
  status: "completed",
  model: "gpt-4o",
  score: 0.87,
  duration: 42000,
  startedAt: "2026-05-14T10:00:00Z",
};

const OVERVIEW = {
  suites: [SUITE],
  recentRuns: [RUN, { ...RUN, id: "run-002", suiteId: "suite-002" }],
  scorecard: { score: 0.87, passed: 43, total: 50, metrics: { accuracy: 0.87 } },
  targets: [],
  apiKeys: [],
};

type Captured = { url: string; method: string; body: unknown };

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

function mockFetch(t: test.TestContext, payload: unknown, captured: Captured[]) {
  t.mock.method(globalThis, "fetch", (url: string | URL, init?: RequestInit) => {
    captured.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return Promise.resolve(makeResp(payload));
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

function makeCmd(output = "json") {
  return { optsWithGlobals: () => ({ output, quiet: output !== "table" }) };
}

test("runEvalSuitesList prints the suites from the overview route", async (t) => {
  const captured: Captured[] = [];
  mockFetch(t, OVERVIEW, captured);
  const out = captureStdout(t);

  const { runEvalSuitesList } = await import("../../bin/cli/commands/eval.mjs");
  await runEvalSuitesList({}, makeCmd());

  assert.equal(new URL(captured[0].url).pathname, "/api/evals");
  assert.equal(captured[0].method, "GET");
  const parsed: unknown = JSON.parse(out.join(""));
  assert.deepEqual(parsed, [SUITE]);
});

test("runEvalRun sends evalRunSuiteSchema's target shape", async (t) => {
  const captured: Captured[] = [];
  mockFetch(t, { suiteId: "suite-001", runs: [RUN], scorecard: null }, captured);
  captureStdout(t);

  const { runEvalRun } = await import("../../bin/cli/commands/eval.mjs");
  await runEvalRun("suite-001", { model: "gpt-4o" }, makeCmd());

  assert.equal(captured[0].method, "POST");
  assert.deepEqual(captured[0].body, {
    suiteId: "suite-001",
    target: { type: "model", id: "gpt-4o" },
  });
});

test("runEvalRun maps --combo and --compare-model onto targets", async (t) => {
  const captured: Captured[] = [];
  mockFetch(t, { runs: [RUN] }, captured);
  captureStdout(t);

  const { runEvalRun } = await import("../../bin/cli/commands/eval.mjs");
  await runEvalRun("suite-001", { combo: "fast", compareModel: "gpt-4o-mini" }, makeCmd());

  assert.deepEqual(captured[0].body, {
    suiteId: "suite-001",
    target: { type: "combo", id: "fast" },
    compareTarget: { type: "model", id: "gpt-4o-mini" },
  });
});

test("runEvalRun prints the runs the server returned", async (t) => {
  const captured: Captured[] = [];
  mockFetch(t, { runs: [RUN], scorecard: null }, captured);
  const out = captureStdout(t);

  const { runEvalRun } = await import("../../bin/cli/commands/eval.mjs");
  await runEvalRun("suite-001", {}, makeCmd());

  assert.deepEqual(JSON.parse(out.join("")), [RUN]);
});

test("runEvalList reads recentRuns and filters by suite locally", async (t) => {
  const captured: Captured[] = [];
  mockFetch(t, OVERVIEW, captured);
  const out = captureStdout(t);

  const { runEvalList } = await import("../../bin/cli/commands/eval.mjs");
  await runEvalList({ suite: "suite-002" }, makeCmd());

  assert.equal(new URL(captured[0].url).pathname, "/api/evals");
  assert.equal(new URL(captured[0].url).search, "", "the route takes no filters");
  const rows: unknown = JSON.parse(out.join(""));
  assert.ok(Array.isArray(rows) && rows.length === 1);
  assert.equal(rows[0].id, "run-002");
});

test("runEvalScorecard renders the scorecard history in table mode", async (t) => {
  const captured: Captured[] = [];
  mockFetch(t, OVERVIEW, captured);
  const out = captureStdout(t);

  const { runEvalScorecard } = await import("../../bin/cli/commands/eval.mjs");
  await runEvalScorecard({}, makeCmd("table"));

  assert.equal(new URL(captured[0].url).pathname, "/api/evals");
  const text = out.join("");
  assert.match(text, /Scorecard/);
  assert.match(text, /Overall score: 87\.0%/);
});

test("runEvalSuitesCreate posts the suite file to /api/evals/suites", async (t) => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "eval-cli-")), "suite.json");
  writeFileSync(file, JSON.stringify({ name: "New suite", cases: [] }));

  const captured: Captured[] = [];
  mockFetch(t, { suite: SUITE }, captured);
  captureStdout(t);

  const { runEvalSuitesCreate } = await import("../../bin/cli/commands/eval.mjs");
  await runEvalSuitesCreate({ file }, makeCmd());

  assert.equal(new URL(captured[0].url).pathname, "/api/evals/suites");
  assert.equal(captured[0].method, "POST");
  assert.deepEqual(captured[0].body, { name: "New suite", cases: [] });
});
