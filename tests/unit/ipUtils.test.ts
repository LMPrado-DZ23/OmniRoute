import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import {
  extractClientIp,
  getClientIpFromRequest,
  isTrustedProxyPeer,
  trustedProxyPeers,
} from "@/lib/ipUtils";

/**
 * Regression tests for IP detection — ported from decolua/9router#1893.
 *
 * When OmniRoute runs behind a local reverse proxy (nginx etc.) the TCP peer
 * is loopback (127.0.0.1 / ::1) and forwarding headers (X-Forwarded-For,
 * X-Real-IP, CF-Connecting-IP) carry the real client IP. When the request
 * arrives directly from the public internet, the TCP peer IS the client and
 * forwarding headers are spoofable — keying brute-force buckets by them lets
 * one attacker either lock everyone else out or evade the lockout entirely.
 */

function makeReq(headers: Record<string, string>, remoteAddress?: string) {
  return {
    headers: new Headers(headers),
    socket: remoteAddress ? { remoteAddress } : undefined,
  };
}

describe("ipUtils — loopback-gated forwarding headers", () => {
  it("trusts X-Forwarded-For when TCP peer is 127.0.0.1 loopback", () => {
    const req = makeReq({ "x-forwarded-for": "203.0.113.10" }, "127.0.0.1");
    assert.equal(getClientIpFromRequest(req), "203.0.113.10");
  });

  it("trusts X-Forwarded-For when TCP peer is ::1 loopback", () => {
    const req = makeReq({ "x-forwarded-for": "203.0.113.11" }, "::1");
    assert.equal(getClientIpFromRequest(req), "203.0.113.11");
  });

  it("trusts X-Real-IP when TCP peer is loopback", () => {
    const req = makeReq({ "x-real-ip": "203.0.113.12" }, "127.0.0.1");
    assert.equal(getClientIpFromRequest(req), "203.0.113.12");
  });

  it("trusts CF-Connecting-IP when TCP peer is loopback", () => {
    const req = makeReq({ "cf-connecting-ip": "203.0.113.13" }, "127.0.0.1");
    assert.equal(getClientIpFromRequest(req), "203.0.113.13");
  });

  it("ignores spoofed X-Forwarded-For when TCP peer is a public address", () => {
    // Direct public client trying to spoof another IP — must be ignored so
    // the brute-force guard keys by the unspoofable TCP peer.
    const req = makeReq({ "x-forwarded-for": "203.0.113.99" }, "198.51.100.5");
    assert.equal(getClientIpFromRequest(req), "198.51.100.5");
  });

  it("ignores spoofed CF-Connecting-IP when TCP peer is a public address", () => {
    const req = makeReq({ "cf-connecting-ip": "203.0.113.88" }, "198.51.100.7");
    assert.equal(getClientIpFromRequest(req), "198.51.100.7");
  });

  it("falls back to forwarding headers when no socket peer is known", () => {
    // Edge runtime / fetch path where req.socket is absent — preserve prior
    // behavior, otherwise we'd lose all IPs in that path.
    const req = makeReq({ "x-forwarded-for": "203.0.113.20" });
    assert.equal(getClientIpFromRequest(req), "203.0.113.20");
  });

  it("returns loopback peer when no forwarding headers are present", () => {
    const req = makeReq({}, "127.0.0.1");
    assert.equal(getClientIpFromRequest(req), "127.0.0.1");
  });

  it("extractClientIp (lower-level) keeps prior contract", () => {
    // Lower-level helper does NOT know the peer — preserve prior behavior.
    assert.equal(extractClientIp("203.0.113.1, 10.0.0.1", "127.0.0.1"), "203.0.113.1");
    assert.equal(extractClientIp(null, "198.51.100.1"), "198.51.100.1");
    assert.equal(extractClientIp("unknown, 203.0.113.2", "10.0.0.1"), "203.0.113.2");
  });
});

// ─── Operator-declared reverse proxy (OMNIROUTE_TRUSTED_PROXY_IPS) ─────────
//
// Forwarding headers are trusted only from a loopback peer. That is right for a proxy on
// the same host and wrong for one on another machine: the peer is then a LAN address, the
// headers are ignored, and every visitor collapses onto the proxy's single IP — so the
// login lockout counts the whole internet as one client and five wrong passwords lock the
// owner out of their own panel. These cases pin the narrow opt-in that fixes it.

const TRUSTED_ENV = "OMNIROUTE_TRUSTED_PROXY_IPS";

function withTrustedProxies<T>(value: string | undefined, run: () => T): T {
  const previous = process.env[TRUSTED_ENV];
  if (value === undefined) delete process.env[TRUSTED_ENV];
  else process.env[TRUSTED_ENV] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[TRUSTED_ENV];
    else process.env[TRUSTED_ENV] = previous;
  }
}

const lanProxyRequest = {
  headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
  socket: { remoteAddress: "10.1.2.3" },
};

test("unset: a LAN peer's forwarding headers are still ignored", () => {
  // The default must be byte-identical to the behaviour before the allowlist existed.
  withTrustedProxies(undefined, () => {
    assert.equal(getClientIpFromRequest(lanProxyRequest), "10.1.2.3");
  });
});

test("a declared proxy is believed about the client behind it", () => {
  withTrustedProxies("10.1.2.3", () => {
    assert.equal(getClientIpFromRequest(lanProxyRequest), "203.0.113.7");
  });
});

test("declaring one proxy does not make every peer trusted", () => {
  // The whole point: the forged header still loses unless the PEER matches.
  withTrustedProxies("10.1.2.3", () => {
    assert.equal(
      getClientIpFromRequest({
        headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
        socket: { remoteAddress: "198.51.100.9" },
      }),
      "198.51.100.9"
    );
  });
});

test("the IPv4-mapped form of a declared proxy is the same proxy", () => {
  withTrustedProxies("10.1.2.3", () => {
    assert.equal(
      getClientIpFromRequest({
        headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
        socket: { remoteAddress: "::ffff:10.1.2.3" },
      }),
      "203.0.113.7"
    );
  });
});

test("a malformed entry is dropped, not tolerated", () => {
  // Half-parsing an allowlist is how one typo quietly starts trusting a header from
  // everywhere. `trustedProxyPeers` keeps the valid entries and silently drops the rest.
  assert.deepEqual([...trustedProxyPeers("10.1.2.3, not-an-ip, , 192.0.2.5")].sort(), [
    "10.1.2.3",
    "192.0.2.5",
  ]);
  assert.deepEqual([...trustedProxyPeers("nonsense")], []);
  assert.deepEqual([...trustedProxyPeers(undefined)], []);
  assert.deepEqual([...trustedProxyPeers("")], []);
});

test("isTrustedProxyPeer answers only about declared peers", () => {
  withTrustedProxies("10.1.2.3", () => {
    assert.equal(isTrustedProxyPeer("10.1.2.3"), true);
    assert.equal(isTrustedProxyPeer("::ffff:10.1.2.3"), true);
    assert.equal(isTrustedProxyPeer("10.1.2.4"), false);
    assert.equal(isTrustedProxyPeer(undefined), false);
    assert.equal(isTrustedProxyPeer(""), false);
  });
});

test("loopback is still trusted without any declaration", () => {
  withTrustedProxies(undefined, () => {
    assert.equal(
      getClientIpFromRequest({
        headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
        socket: { remoteAddress: "127.0.0.1" },
      }),
      "203.0.113.7"
    );
  });
});
