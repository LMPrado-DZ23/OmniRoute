/**
 * `REQUIRE_API_KEY=false` must not mean "the internet may call this gateway".
 *
 * The flag ships `false`, and it governs `/v1/**` — the inference surface.
 * `requireLogin` does **not**: that one governs `/api/**`. So an instance published
 * on a domain, with a dashboard password set and every management route correctly
 * answering 401, still routed and executed an anonymous
 * `POST /v1/chat/completions` — on the operator's provider credentials and quota.
 * A security audit demonstrated it against a local instance: the request came back
 * 502 after six real upstream attempts, not 401.
 *
 * The allowed identity was already literally named `local`. It just was not checked.
 *
 * These tests pin both directions, because a fix that only closed the hole would
 * break every local and LAN user of the default configuration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-clientapi-locality-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { clientApiPolicy } = await import("../../../src/server/authz/policies/clientApi.ts");

test.after(async () => {
  const core = await import("../../../src/lib/db/core.ts");
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test.beforeEach(() => {
  delete process.env.REQUIRE_API_KEY;
});

/** A CLIENT_API context with no credential, from the given socket peer. */
function anonymousFrom(peerIp: string | null) {
  const request: Record<string, unknown> = {
    method: "POST",
    headers: new Headers(),
    url: "http://localhost/api/v1/chat/completions",
  };
  if (peerIp !== null) request.ip = peerIp;
  return {
    request,
    classification: {
      routeClass: "CLIENT_API" as const,
      reason: "client_api_v1" as const,
      normalizedPath: "/api/v1/chat/completions",
    },
    requestId: "req_test",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the policy context shape is internal
const evaluate = (ctx: unknown) => clientApiPolicy.evaluate(ctx as any);

test("loopback keeps working without a key — the default local experience is untouched", async () => {
  for (const peer of ["127.0.0.1", "::1"]) {
    const outcome = await evaluate(anonymousFrom(peer));
    assert.equal(outcome.allow, true, `${peer} must still be allowed anonymously`);
    assert.equal(outcome.subject?.kind, "anonymous");
  }
});

test("a private-LAN caller keeps working — an IDE on another machine at home", async () => {
  const outcome = await evaluate(anonymousFrom("192.168.0.42"));

  assert.equal(outcome.allow, true);
  assert.equal(outcome.subject?.kind, "anonymous");
});

test("a public peer is refused — this is the open relay", async () => {
  const outcome = await evaluate(anonymousFrom("203.0.113.7"));

  assert.equal(outcome.allow, false, "an anonymous request from the internet must not be routed");
  assert.equal(outcome.status, 401);
});

test("an unresolvable peer is refused — the locality helpers fail closed", async () => {
  // A request whose peer cannot be established is not evidence of being local.
  const outcome = await evaluate(anonymousFrom(null));

  assert.equal(outcome.allow, false);
  assert.equal(outcome.status, 401);
});

test("REQUIRE_API_KEY=true refuses even loopback without a key — unchanged", async () => {
  process.env.REQUIRE_API_KEY = "true";

  const outcome = await evaluate(anonymousFrom("127.0.0.1"));

  assert.equal(outcome.allow, false);
  assert.equal(outcome.status, 401);
});
