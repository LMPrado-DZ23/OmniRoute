/**
 * Credential selection returns either credentials or a verdict: every connection rate limited, or
 * every connection expired, banned or out of credits. Routes answer both verdicts the same way, so
 * the shared helpers in src/app/api/v1/_shared/rateLimit.ts decide it once: credentialVerdictResponse
 * returns the route's response for a verdict (or null for usable credentials), and
 * isUsableCredentialSelection tells a fallback path whether a selection can be used at all.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { credentialVerdictResponse, isUsableCredentialSelection } =
  await import("../../src/app/api/v1/_shared/rateLimit.ts");

test("usable credentials produce no verdict response", () => {
  assert.equal(credentialVerdictResponse("openai", { apiKey: "sk-test" }), null);
  assert.equal(isUsableCredentialSelection({ apiKey: "sk-test" }), true);
});

test("a missing selection is not usable", () => {
  assert.equal(isUsableCredentialSelection(null), false);
  assert.equal(isUsableCredentialSelection(undefined), false);
});

test("an all-rate-limited pool answers 429 with the provider in the message", async () => {
  const verdict = { allRateLimited: true, retryAfter: 30, retryAfterHuman: "30s" };
  const response = credentialVerdictResponse("openai", verdict);
  assert.ok(response instanceof Response);
  assert.equal(response.status, 429);
  assert.match(await response.text(), /\[openai\] All accounts rate limited/);
  assert.equal(isUsableCredentialSelection(verdict), false);
});

test("an all-expired pool answers 401 with a reconnect hint", async () => {
  const verdict = { allExpired: true, expiredCount: 2, expiredStatus: "expired" };
  const response = credentialVerdictResponse("deepgram", verdict);
  assert.ok(response instanceof Response);
  assert.equal(response.status, 401);
  assert.match(await response.text(), /\[deepgram\] All 2 connection\(s\) authentication expired/);
  assert.equal(isUsableCredentialSelection(verdict), false);
});

test("a pool whose credits are exhausted answers 402", async () => {
  const response = credentialVerdictResponse("openai", {
    allExpired: true,
    expiredCount: 1,
    expiredStatus: "credits_exhausted",
  });
  assert.ok(response instanceof Response);
  assert.equal(response.status, 402);
  assert.match(await response.text(), /credits exhausted/);
});
