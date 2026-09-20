/**
 * "Allow Private Provider URLs" must not also unblock cloud metadata.
 *
 * Both provider guards returned the literal mode `"none"` — documented as *"no checks;
 * power users"* — as soon as `arePrivateProviderUrlsAllowed()` was true, which a dashboard
 * toggle sets. `"block-metadata"`, the mode that keeps 169.254.169.254 and
 * metadata.google.internal blocked, is only the MIDDLE tier, so flipping a switch labelled
 * "private URLs" reopened the SSRF→IMDS credential pivot on any cloud VPS.
 *
 * Admin-only, so not an unauthenticated vulnerability — but the label does not describe
 * what the switch does, and this instance is destined for a public VPS.
 *
 * Metadata now needs its own switch, named for what it does. Nothing becomes impossible;
 * it just stops happening as a side effect.
 */
import test from "node:test";
import assert from "node:assert/strict";

const policy = await import("../../src/shared/network/outboundUrlGuardPolicy.ts");

const PRIVATE_ENV = policy.PRIVATE_PROVIDER_URLS_ENV;
const METADATA_ENV = policy.CLOUD_METADATA_URLS_ENV;
const LOCAL_ENV = policy.LOCAL_PROVIDER_URLS_ENV;

const SAVED = {
  [PRIVATE_ENV]: process.env[PRIVATE_ENV],
  [METADATA_ENV]: process.env[METADATA_ENV],
  [LOCAL_ENV]: process.env[LOCAL_ENV],
  OUTBOUND_SSRF_GUARD_ENABLED: process.env.OUTBOUND_SSRF_GUARD_ENABLED,
};

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test.beforeEach(() => {
  setEnv({
    [PRIVATE_ENV]: undefined,
    [METADATA_ENV]: undefined,
    [LOCAL_ENV]: undefined,
    OUTBOUND_SSRF_GUARD_ENABLED: undefined,
  });
});

test.after(() => setEnv(SAVED));

test("the private-URL opt-in keeps cloud metadata blocked", () => {
  setEnv({ [PRIVATE_ENV]: "true" });

  assert.equal(
    policy.getProviderValidationGuard(),
    "block-metadata",
    "a toggle labelled 'Allow Private Provider URLs' must not unblock 169.254.169.254"
  );
  assert.equal(policy.getProviderOutboundGuard(), "block-metadata");
});

test("metadata egress needs its own switch, by name", () => {
  setEnv({ [PRIVATE_ENV]: "true", [METADATA_ENV]: "true" });

  assert.equal(policy.getProviderValidationGuard(), "none");
  assert.equal(policy.getProviderOutboundGuard(), "none");
});

test("the metadata switch alone does not relax anything else", () => {
  // Without the private-URL opt-in the guard stays where the local-first default puts it,
  // so the new flag cannot become a back door on its own.
  setEnv({ [METADATA_ENV]: "true", [LOCAL_ENV]: "false" });

  assert.equal(policy.getProviderValidationGuard(), "public-only");
  assert.equal(policy.getProviderOutboundGuard(), "public-only");
});

test("the local-first default is unchanged", () => {
  assert.equal(policy.getProviderValidationGuard(), "block-metadata");
  assert.equal(policy.getProviderOutboundGuard(), "block-metadata");
});

test("strict mode is unchanged", () => {
  setEnv({ [LOCAL_ENV]: "false" });

  assert.equal(policy.getProviderValidationGuard(), "public-only");
  assert.equal(policy.getProviderOutboundGuard(), "public-only");
});

test("only an explicit true opts in; a typo does not", () => {
  for (const value of ["", "false", "0", "no", "maybe", "TRUE "]) {
    setEnv({ [PRIVATE_ENV]: "true", [METADATA_ENV]: value });
    const expected = value.trim().toLowerCase() === "true" ? "none" : "block-metadata";
    assert.equal(
      policy.getProviderValidationGuard(),
      expected,
      `metadata flag ${JSON.stringify(value)} should yield ${expected}`
    );
  }
});
