/**
 * The login brute-force guard must not put every internet client in one bucket.
 *
 * `/api/auth/login` keyed the guard on the token-stamped socket peer. That is exactly
 * right for a direct connection — it is unspoofable, so an attacker cannot reset their
 * own counter with a forged `X-Forwarded-For`. But behind nginx / Caddy / a cloudflared
 * sidecar the socket peer is the **proxy**, and every client on the internet presents
 * the same loopback address. A security audit demonstrated the consequence: four wrong
 * passwords from four different forwarded IPs, then the CORRECT password from a fifth,
 * answered 429. Five wrong guesses every fifteen minutes, from anywhere, keeps the
 * operator permanently out of their own dashboard.
 *
 * The authz pipeline had already made this call for the IP filter —
 * `checkRequestIP(request, viaProxy ? null : trustedPeerIp)` — and this route simply
 * never consulted the marker.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveLoginGuardIp } from "../../../src/app/api/auth/login/route.ts";

const STAMP_TOKEN = "test-peer-stamp-token";
const PROXY_PEER = "127.0.0.1";
const OPERATOR = "198.51.100.9";
const ATTACKER = "203.0.113.7";

/** A request carrying the stamped headers the custom server writes. */
function requestWith(headers: Record<string, string>) {
  return { headers: new Headers(headers) } as unknown as Parameters<typeof resolveLoginGuardIp>[0];
}

/**
 * The via-proxy marker is `<token>|1` — the per-process stamp token, a pipe, then the
 * flag (src/server/authz/peerStamp.ts, resolveStampedViaProxy). A client that knows the
 * header name but not the token cannot set it.
 */
function viaProxyHeaderValue(): string {
  return `${STAMP_TOKEN}|1`;
}

const ORIGINAL_TOKEN = process.env.OMNIROUTE_PEER_STAMP_TOKEN;

test.after(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
  else process.env.OMNIROUTE_PEER_STAMP_TOKEN = ORIGINAL_TOKEN;
});

test("direct connection: the unspoofable socket peer keys the guard", () => {
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = STAMP_TOKEN;

  const key = resolveLoginGuardIp(
    requestWith({ "x-omniroute-trusted-peer-ip": ATTACKER }),
    "should-not-be-used"
  );

  assert.equal(
    key,
    ATTACKER,
    "without a proxy the socket peer is the end user and cannot be forged — keep using it"
  );
});

test("no peer stamp at all: falls back to the audit address rather than nothing", () => {
  delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;

  assert.equal(resolveLoginGuardIp(requestWith({}), OPERATOR), OPERATOR);
});

test("nothing resolvable: a null key is honest, not an empty-string bucket", () => {
  delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;

  assert.equal(resolveLoginGuardIp(requestWith({}), null), null);
});

test("two clients behind one proxy do not share a lockout bucket", () => {
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = STAMP_TOKEN;
  const viaProxy = viaProxyHeaderValue();

  // Both requests arrive on the same socket peer — the proxy — which is exactly the
  // state that made every internet client collide.
  const headers = {
    "x-omniroute-trusted-peer-ip": PROXY_PEER,
    "x-omniroute-via-proxy": viaProxy,
  };

  const attackerKey = resolveLoginGuardIp(requestWith(headers), ATTACKER);
  const operatorKey = resolveLoginGuardIp(requestWith(headers), OPERATOR);

  assert.equal(attackerKey, ATTACKER);
  assert.equal(operatorKey, OPERATOR);
  assert.notEqual(
    attackerKey,
    operatorKey,
    "with the proxy hop as the key these are the same string, and one stranger's " +
      "five wrong guesses lock the operator out of their own dashboard"
  );
  assert.notEqual(attackerKey, PROXY_PEER, "the proxy hop must never be the key");
});

test("the guard itself separates distinct keys", async () => {
  const guard = await import("../../../src/server/auth/loginGuard.ts");
  guard.resetLoginGuardForTests();

  const enabled = { enabled: true };
  const { FAILURE_THRESHOLD } = guard.LOGIN_GUARD_TUNABLES;

  for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
    guard.recordLoginFailure(ATTACKER, enabled);
  }

  assert.equal(guard.checkLoginGuard(ATTACKER, enabled).allowed, false);
  assert.equal(
    guard.checkLoginGuard(OPERATOR, enabled).allowed,
    true,
    "a different client must not inherit someone else's lockout"
  );

  guard.resetLoginGuardForTests();
});
