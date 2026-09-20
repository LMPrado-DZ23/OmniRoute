/**
 * The login brute-force guard must not put every internet client in one bucket.
 *
 * `/api/auth/login` keyed the guard on the token-stamped socket peer. That is exactly
 * right for a direct connection — it is unspoofable, so an attacker cannot reset their
 * own counter with a forged `X-Forwarded-For`. But behind nginx / Caddy / a cloudflared
 * sidecar the socket peer is the **proxy**, and every client on the internet presents
 * the same loopback address. A security audit demonstrated the consequence: five wrong
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
import fs from "node:fs";
import path from "node:path";

const ROUTE = path.join(process.cwd(), "src", "app", "api", "auth", "login", "route.ts");

test("the login route derives its guard key from the via-proxy marker", () => {
  const source = fs.readFileSync(ROUTE, "utf8");

  assert.match(
    source,
    /resolveStampedViaProxy\(/,
    "the route must ask whether the request arrived through a proxy before keying the guard"
  );

  // Behind a proxy the end user's address is the forwarded one the audit context
  // resolved; the socket peer is the proxy hop and must NOT be the key.
  assert.match(
    source,
    /const clientIp = viaProxy\s*\?\s*auditContext\.ipAddress \|\| null\s*:\s*trustedPeerIp \|\| auditContext\.ipAddress \|\| null;/,
    "behind a proxy the guard must key on the forwarded client address, and only " +
      "otherwise on the unspoofable socket peer"
  );

  assert.doesNotMatch(
    source,
    /const clientIp = trustedPeerIp \|\| auditContext\.ipAddress \|\| null;/,
    "the unconditional socket-peer key is the defect: it shares one bucket across the internet"
  );
});

test("the guard itself still separates distinct clients", async () => {
  const guard = await import("../../../src/server/auth/loginGuard.ts");
  guard.resetLoginGuardForTests();

  const enabled = { enabled: true };
  const { FAILURE_THRESHOLD } = guard.LOGIN_GUARD_TUNABLES;

  // One client burns through the threshold.
  for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
    guard.recordLoginFailure("203.0.113.7", enabled);
  }
  assert.equal(
    guard.checkLoginGuard("203.0.113.7", enabled).allowed,
    false,
    "the offending client must be locked out"
  );

  // A different client — the operator — must be unaffected. This is the property the
  // route's keying decides: with the proxy hop as the key, these two are the same string.
  assert.equal(
    guard.checkLoginGuard("198.51.100.9", enabled).allowed,
    true,
    "a different client must not inherit someone else's lockout"
  );

  guard.resetLoginGuardForTests();
});
