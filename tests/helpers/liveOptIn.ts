/**
 * Decide whether a live test may run.
 *
 * Live tests send real traffic to a running OmniRoute and, through it, to real (often paid)
 * providers. Test runners such as `npm run test:integration` collect them together with local
 * tests, so having credentials exported in a shell must not be enough to run them: the opt-in flag
 * must also be exactly "1". Pass the result as node:test's `skip` option.
 */

/** Default opt-in flag for live tests under tests/integration. */
export const LIVE_TESTS_FLAG = "RUN_LIVE_TESTS";

export interface LiveOptInOptions {
  /** Opt-in flag that must be exactly "1". Defaults to RUN_LIVE_TESTS. */
  flag?: string;
  /** Environment variables that must be non-empty, for example OMNIROUTE_API_KEY. */
  requiredEnv: readonly string[];
  /** Environment to read. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Returns undefined when the live test may run, otherwise the reason it is skipped. */
export function liveSkipReason({
  flag = LIVE_TESTS_FLAG,
  requiredEnv,
  env = process.env,
}: LiveOptInOptions): string | undefined {
  if (env[flag] !== "1") {
    return `${flag}!=1 — skipping live test (set ${flag}=1 to send real traffic)`;
  }
  const missing = requiredEnv.filter((name) => !env[name]);
  if (missing.length > 0) {
    return `${missing.join(" and ")} not set — skipping live test`;
  }
  return undefined;
}
