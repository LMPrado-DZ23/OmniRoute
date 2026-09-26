/**
 * Peer-locality stamp for tests that boot the app with `scripts/dev/run-next-playwright.mjs dev`.
 *
 * `clientApiPolicy` only lets an anonymous /v1 request through when it can prove the caller is
 * local (REQUIRE_API_KEY=false has never meant "the internet may call this"). In the Next
 * middleware runtime there is no socket, so locality comes from a token-stamped header that
 * OmniRoute's own custom server (`scripts/dev/run-next.mjs`, the standalone server) writes from
 * the real TCP peer. `run-next-playwright.mjs dev` launches the plain `next dev` CLI, which has no
 * such server — so every request looked remote and got AUTH_002, and three HTTP e2e suites failed
 * in the release-green sweep.
 *
 * These tests own both ends of the connection, so they can do what the custom server does: give the
 * child a per-run token and send the matching `<token>|<ip>` stamp. A wrong or missing token is
 * still ignored by the server, so nothing here weakens the check the suites are exercising.
 */
import { randomUUID } from "node:crypto";

/** Keep in sync with src/server/authz/headers.ts (the TS side cannot import a test helper). */
export const PEER_IP_HEADER = "x-omniroute-peer-ip";
export const VIA_PROXY_HEADER = "x-omniroute-via-proxy";
export const PEER_STAMP_TOKEN_ENV = "OMNIROUTE_PEER_STAMP_TOKEN";

export function createLocalPeerStamp(ip = "127.0.0.1") {
  const token = `e2e-peer-stamp-${randomUUID()}`;
  const stampHeaders: Record<string, string> = {
    [PEER_IP_HEADER]: `${token}|${ip}`,
    [VIA_PROXY_HEADER]: `${token}|0`,
  };

  function stampedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(stampHeaders)) headers.set(name, value);
    return fetch(input, { ...init, headers });
  }

  return {
    token,
    env: { [PEER_STAMP_TOKEN_ENV]: token },
    headers: stampHeaders,
    fetch: stampedFetch,
  };
}
