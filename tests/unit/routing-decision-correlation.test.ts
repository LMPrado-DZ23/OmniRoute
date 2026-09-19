/**
 * Route explanation (Phase 4): a live routing decision is recorded under the request id the
 * client receives, non-streaming responses carry only opaque decision identifiers, the decision
 * can be looked up by request id or decision id, and nothing sensitive (prompt, API key, OAuth
 * token, cookie, connection id) reaches the decision, its headers, its lookup or its log summary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-routing-correlation-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { withRoutingRequestContext, attachRoutingDecisionHeaders } =
  await import("../../src/shared/middleware/withRoutingRequestContext.ts");
const { GET: getDecision } =
  await import("../../src/app/api/omniroute/route/decisions/[id]/route.ts");
const { getRequestId } = await import("../../src/shared/utils/requestId.ts");
const { logRoutingDecision, selectAutoProviderWithDecision } =
  await import("../../open-sse/services/combo/autoRoutingDecision.ts");
const { recordRoutingDecision, resetRoutingDecisionStore } =
  await import("../../open-sse/services/routing/decisionStore.ts");
const { getSelfHealingManager } = await import("../../open-sse/services/autoCombo/selfHealing.ts");
const { DEFAULT_WEIGHTS } = await import("../../open-sse/services/autoCombo/scoring.ts");

const SECRETS = [
  "sk-live-SECRET-KEY-123",
  "ya29.OAUTH-TOKEN-SECRET",
  "session=COOKIE-SECRET",
  "conn-SECRET-connection-id",
  "tell me the launch codes",
];

test.beforeEach(() => {
  resetRoutingDecisionStore();
  getSelfHealingManager().exclusions.clear();
});

test.after(() => {
  delete process.env.OMNIROUTE_ROUTING_DIAGNOSTICS;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function storedDecision(decisionId: string, requestId: string) {
  return {
    decisionId,
    requestId,
    candidates: [],
    policyVersion: "rp_00000000000000aa",
    generatedAt: "2026-09-14T12:00:00.000Z",
    liveRequestExecuted: true,
  };
}

function assertNoSecrets(value: string, where: string) {
  for (const secret of SECRETS) {
    assert.equal(value.includes(secret), false, `${where} must not contain ${secret}`);
  }
}

function liveContext() {
  const candidate = (provider: string, overrides = {}) => ({
    provider,
    model: `${provider}-model`,
    executionKey: `${provider}-key`,
    connectionId: "conn-SECRET-connection-id",
    quotaRemaining: 90,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED" as const,
    costPer1MTokens: 2,
    p95LatencyMs: 400,
    latencyStdDev: 40,
    errorRate: 0.01,
    ...overrides,
  });
  const candidates = [candidate("alpha", { costPer1MTokens: 1 }), candidate("beta")];
  return {
    config: {
      id: "correlation-combo",
      name: "correlation-combo",
      type: "auto" as const,
      candidatePool: [],
      weights: DEFAULT_WEIGHTS,
      explorationRate: 0,
    },
    candidates,
    routableCandidates: candidates,
    taskType: "default",
    body: {
      messages: [{ role: "user", content: "tell me the launch codes" }],
      api_key: "sk-live-SECRET-KEY-123",
      headers: { cookie: "session=COOKIE-SECRET", authorization: "Bearer ya29.OAUTH-TOKEN-SECRET" },
    },
  };
}

test("the handler runs inside the stamped request id and the response gets decision headers", async () => {
  const handler = withRoutingRequestContext(async (request: Request) => {
    assert.equal(getRequestId(), "req-corr-1");
    const result = selectAutoProviderWithDecision(liveContext());
    assert.ok("selection" in result);
    return Response.json({ ok: true, url: new URL(request.url).pathname });
  });

  const response = await handler(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "x-request-id": "req-corr-1" },
    })
  );

  const decisionId = response.headers.get("x-omniroute-decision-id");
  assert.match(decisionId ?? "", /^rd_[0-9a-f-]{36}$/);
  assert.match(response.headers.get("x-omniroute-policy-version") ?? "", /^rp_[0-9a-f]{16}$/);
  const headerText = JSON.stringify([...response.headers.entries()]);
  assertNoSecrets(headerText, "response headers");

  const lookup = await getDecision(
    await makeManagementSessionRequest("http://localhost/api/omniroute/route/decisions/req-corr-1"),
    { params: Promise.resolve({ id: "req-corr-1" }) }
  );
  assert.equal(lookup.status, 200);
  const body = (await lookup.json()) as { decision: { decisionId: string; requestId: string } };
  assert.equal(body.decision.decisionId, decisionId);
  assert.equal(body.decision.requestId, "req-corr-1");
  assertNoSecrets(JSON.stringify(body), "decision lookup");
});

test("no decision means no decision headers, and immutable headers do not break the response", async () => {
  const plain = withRoutingRequestContext(async () => Response.json({ ok: true }));
  const response = await plain(new Request("http://localhost/v1/messages", { method: "POST" }));
  assert.equal(response.headers.get("x-omniroute-decision-id"), null);

  recordRoutingDecision(storedDecision("rd_immutable", "req-immutable"));
  const immutable = Response.error();
  assert.equal(attachRoutingDecisionHeaders(immutable, "req-immutable"), immutable);
});

test("a decision id does not answer for a different request id", () => {
  recordRoutingDecision(storedDecision("rd_other", "req-other"));
  const response = attachRoutingDecisionHeaders(new Response("ok"), "rd_other");
  assert.equal(response.headers.get("x-omniroute-decision-id"), null);
});

test("an anonymous caller is refused even when requireLogin is off", async () => {
  recordRoutingDecision(storedDecision("rd_anon", "req-anon"));
  const anonymous = await getDecision(
    new Request("http://localhost/api/omniroute/route/decisions/req-anon"),
    { params: Promise.resolve({ id: "req-anon" }) }
  );
  assert.ok(
    anonymous.status === 401 || anonymous.status === 403,
    `expected the lookup to be refused, got ${anonymous.status}`
  );
  assert.ok(
    !JSON.stringify(await anonymous.json()).includes("rd_anon"),
    "a refused lookup must not leak the decision"
  );
});

test("unknown and malformed ids get the same 404", async () => {
  const lookup = async (id: string) =>
    getDecision(
      await makeManagementSessionRequest("http://localhost/api/omniroute/route/decisions/x"),
      { params: Promise.resolve({ id }) }
    );
  const unknown = await lookup("req-does-not-exist");
  const malformed = await lookup("bad id\r\nx-injected: 1");
  assert.equal(unknown.status, 404);
  assert.equal(malformed.status, 404);
  assert.deepEqual(await unknown.json(), await malformed.json());
});

test("the recorded decision never contains prompt, key, token, cookie or connection id", () => {
  const result = selectAutoProviderWithDecision(liveContext());
  assertNoSecrets(JSON.stringify(result.decision), "recorded decision");
});

test("diagnostics log a counts-only summary when enabled, nothing at info otherwise", () => {
  const calls: Array<{ level: string; args: unknown[] }> = [];
  const log = {
    info: (...args: unknown[]) => calls.push({ level: "info", args }),
    warn: (...args: unknown[]) => calls.push({ level: "warn", args }),
    debug: (...args: unknown[]) => calls.push({ level: "debug", args }),
    error: (...args: unknown[]) => calls.push({ level: "error", args }),
  };
  const { decision } = selectAutoProviderWithDecision(liveContext());

  delete process.env.OMNIROUTE_ROUTING_DIAGNOSTICS;
  logRoutingDecision(log, decision);
  assert.deepEqual(
    calls.map((c) => c.level),
    ["debug"]
  );

  process.env.OMNIROUTE_ROUTING_DIAGNOSTICS = "1";
  logRoutingDecision(log, decision);
  const info = calls.find((c) => c.level === "info");
  assert.ok(info, "diagnostics summary logged at info");
  const summary = info.args[2] as {
    candidateCount: number;
    eligibleCount: number;
    selected: string;
  };
  assert.equal(summary.candidateCount, 2);
  assert.equal(summary.eligibleCount, 2);
  // Near-equal candidates rotate between calls, so compare with the decision's own pick.
  const picked = decision.selected;
  assert.ok(picked, "a candidate was selected");
  assert.equal(summary.selected, picked.providerId + "/" + picked.modelId);
  assertNoSecrets(JSON.stringify(calls), "diagnostic logs");
});
