/**
 * Network guard for tests that import route modules or anything under `open-sse/`.
 *
 * `open-sse/utils/proxyFetch.ts` replaces `globalThis.fetch` when it is imported, so a stub
 * installed BEFORE the imports is silently bypassed. Call this AFTER every import: it installs a
 * stub that throws on any URL (no request can leave the machine) and records the attempt, and
 * returns helpers to prove the stub is the live `fetch` and that nothing tried to go out.
 */
export function blockOutboundFetch() {
  const attempts: string[] = [];
  const guard = async (input: unknown): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    attempts.push(url);
    throw new Error(`unexpected outbound fetch in a unit test: ${url}`);
  };
  globalThis.fetch = guard;
  return {
    attempts,
    isLive: () => globalThis.fetch === guard,
  };
}
