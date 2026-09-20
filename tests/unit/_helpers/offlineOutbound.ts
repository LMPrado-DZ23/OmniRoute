/**
 * Hermetic outbound layer for a unit test file.
 *
 * Most tests that reached the network did not ask for it: they exercise a route or a
 * service, and production code makes an incidental best-effort call on the side (the AI
 * Horde image-catalog poll behind /v1/models, the egress-IP probe warmed by the chat
 * route, a provider's live model discovery). The call is swallowed by a try/catch, so
 * the test passes either way — while real requests leave the machine.
 *
 * `installOfflineOutbound()` makes those calls fail immediately, in-process, with a
 * message naming the URL:
 *
 *   const offline = await installOfflineOutbound();   // AFTER all imports
 *
 * It MUST be called after the file's imports. open-sse/utils/proxyFetch.ts replaces
 * globalThis.fetch at import time, so a stub installed before a route import is silently
 * discarded — that is exactly how the incident happened. The call asserts that its stub
 * is the live globalThis.fetch once installed.
 *
 * Loopback stays open (tests that start a local server keep working) and a test that
 * WANTS a specific outbound URL answers it through `respond`; everything else throws.
 * The egress probe never touches globalThis.fetch (it calls undici's request() directly),
 * so it is neutralised through its own seam, `_setEgressProbeForTests`. The wreq-js TLS
 * transport (a native binding, also invisible to a fetch stub) is left to the test by
 * default — tests/_setup/blockNetwork.ts blocks it at the binding — and is routed through
 * `respond` when a suite passes `interceptTlsClient: true`.
 *
 * This is the in-process complement to tests/_setup/blockNetwork.ts: the setup module
 * makes the rule unbypassable at the socket layer, this helper keeps an individual test
 * from relying on the socket ever being attempted.
 */
import assert from "node:assert/strict";

import { isLoopbackHost } from "../../_setup/blockNetwork.ts";

export const STUBBED_ERROR_CODE = "ERR_TEST_OUTBOUND_STUBBED";

export class OutboundStubbedError extends Error {
  override name = "OutboundStubbedError";
  readonly code = STUBBED_ERROR_CODE;

  constructor(readonly url: string) {
    super(
      `Unexpected outbound request to ${url}. This unit test is offline: answer the URL ` +
        `through installOfflineOutbound({ respond }) if the test needs it, or leave it ` +
        `unanswered if production code is only making a best-effort call. ` +
        `[${STUBBED_ERROR_CODE}]`
    );
  }
}

/** Answers a request the test expects. Return undefined to leave a URL unanswered. */
export type OutboundResponder = (
  url: URL,
  init: RequestInit | undefined
) => Response | Promise<Response> | undefined;

export interface OfflineOutbound {
  /** Every non-loopback URL the code under test tried to reach. */
  readonly attempts: readonly string[];
  /** Restore the real fetch and the production seams. */
  restore(): void;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export interface OfflineOutboundOptions {
  /** Answer the URLs the test legitimately expects; everything else throws. */
  respond?: OutboundResponder;
  /**
   * Leave globalThis.fetch alone (default: replace it). proxyFetch's patchedFetch IS
   * globalThis.fetch, so replacing it also removes the proxy/TLS-fingerprint routing a
   * few tests assert on. Those tests pass `interceptFetch: false` and rely on the
   * production seams above plus tests/_setup/blockNetwork.ts at the socket layer.
   */
  interceptFetch?: boolean;
  /**
   * Also route open-sse/utils/proxyFetch.ts's wreq-js TLS client through `respond`
   * (default: leave that seam to the test). Suites that exercise the browser-impersonating
   * executors need it — their transport is a native binding, not globalThis.fetch.
   */
  interceptTlsClient?: boolean;
  /**
   * Refuse proxyFetch's own undici dispatchers for non-loopback hosts (default: on).
   * Turn it off only for a suite that drives proxyFetch against a real dispatcher.
   */
  interceptProxyDispatchers?: boolean;
}

export async function installOfflineOutbound(
  options: OfflineOutboundOptions = {}
): Promise<OfflineOutbound> {
  const restores: Array<() => void> = [];

  // Seams for transports that bypass globalThis.fetch, taken FIRST: importing them pulls
  // module graphs of their own (proxyDispatcher → proxyFetch), and a proxyFetch instance
  // loaded after the stub was installed would re-patch globalThis.fetch on top of it.
  try {
    const egress = await import("../../../src/lib/proxyEgress.ts");
    egress._setEgressProbeForTests(async () => ({
      ip: null,
      latencyMs: 0,
      error: "offline unit test",
    }));
    restores.push(() => egress._setEgressProbeForTests(null));
  } catch {
    // The module is optional for the caller's graph.
  }

  // proxyFetch's direct (no-proxy) path does NOT go through globalThis.fetch: it calls
  // undici's fetch with a dispatcher of its own, taken from open-sse/utils/proxyDispatcherCache
  // (symbol-keyed globals). A caller holding the proxyFetch export therefore opens a socket
  // before any fetch stub is consulted. Seeding those globals with a MockAgent that refuses
  // everything except loopback closes that path in-process — the request fails before connect,
  // and proxyFetch's fallback to globalThis.fetch lands on the stub below.
  if (options.interceptProxyDispatchers !== false) {
    const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = await import("undici");
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.enableNetConnect((host: string) => isLoopbackHost(host.replace(/:\d+$/, "")));
    // Anything that calls undici without an explicit dispatcher uses the global one.
    const previousGlobal = getGlobalDispatcher();
    setGlobalDispatcher(mock);
    restores.push(() => setGlobalDispatcher(previousGlobal));
    const scope: Record<symbol, unknown> = globalThis;
    const keys = [
      Symbol.for("omniroute.proxyDispatcher.default"),
      Symbol.for("omniroute.proxyDispatcher.retry"),
      Symbol.for("omniroute.proxyDispatcher.cache"),
    ];
    const previous = keys.map((key) => scope[key]);
    scope[keys[0]] = mock;
    scope[keys[1]] = mock;
    // Per-proxy dispatchers are looked up in this Map and created on a miss; always
    // answering with the mock keeps proxied egress in-process too.
    scope[keys[2]] = new Map<string, unknown>([]) as unknown;
    const cache = scope[keys[2]];
    if (cache instanceof Map) {
      Object.defineProperty(cache, "get", { value: () => mock, configurable: true });
    }
    restores.push(() => {
      keys.forEach((key, index) => {
        scope[key] = previous[index];
      });
      void mock.close();
    });
  }

  const attempts: string[] = [];

  async function answerOrThrow(raw: string, init?: RequestInit): Promise<Response> {
    attempts.push(raw);
    let parsed: URL | null = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    const answer = parsed ? await options.respond?.(parsed, init) : undefined;
    if (answer) return answer;
    throw new OutboundStubbedError(raw);
  }

  if (options.interceptTlsClient) {
    const proxyFetch = await import("../../../open-sse/utils/proxyFetch.ts");
    proxyFetch.setTlsClientForTest({ available: true, fetch: (url: string) => answerOrThrow(url) });
    restores.push(() => proxyFetch.setTlsClientForTest(null));
  }

  const liveFetch = globalThis.fetch;
  if (options.interceptFetch === false) {
    return {
      attempts,
      restore() {
        for (const restore of restores.reverse()) restore();
      },
    };
  }

  // A route imported LATER (inside a test) pulls proxyFetch, whose module body assigns
  // globalThis.fetch — that would drop this stub silently. proxyFetch guards that
  // assignment with the `isPatched` flag of its symbol-keyed global state, so claiming the
  // flag keeps later instances off globalThis.fetch. Tests that install a stub of their own
  // still win: this is a plain assignment, not an accessor.
  const patchState = Reflect.get(globalThis, Symbol.for("omniroute.proxyFetch.state"));
  if (typeof patchState === "object" && patchState !== null && "isPatched" in patchState) {
    const wasPatched: unknown = Reflect.get(patchState, "isPatched");
    Reflect.set(patchState, "isPatched", true);
    restores.push(() => {
      Reflect.set(patchState, "isPatched", wasPatched);
    });
  }

  const stub: typeof globalThis.fetch = async (input, init) => {
    const raw = urlOf(input);
    let host: string | null = null;
    try {
      host = new URL(raw).hostname;
    } catch {
      host = null;
    }
    if (host !== null && isLoopbackHost(host)) return liveFetch(input, init);
    return answerOrThrow(raw, init ?? undefined);
  };
  globalThis.fetch = stub;
  assert.equal(
    globalThis.fetch,
    stub,
    "installOfflineOutbound must run AFTER every import: something replaced globalThis.fetch"
  );

  restores.push(() => {
    globalThis.fetch = liveFetch;
  });

  return {
    attempts,
    restore() {
      for (const restore of restores.reverse()) restore();
    },
  };
}
