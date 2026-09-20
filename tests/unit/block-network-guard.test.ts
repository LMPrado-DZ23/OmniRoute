// Regression guard for tests/_setup/blockNetwork.ts — the test-only module that makes
// "unit tests never reach a real provider" a property of the runner instead of a matter
// of discipline. Every attempt below runs in a CHILD process (the probe in
// tests/unit/fixtures/network-guard-probe.ts), because a blocked attempt in THIS process
// would, by design, fail this file. Non-loopback targets are 192.0.2.1 (RFC 5737
// TEST-NET-1) or `.invalid` names, so a broken guard still cannot reach a provider.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  BLOCKED_ERROR_CODE,
  DEFAULT_GUARD_MODE,
  GUARD_MODE_ENV,
  LIVE_TEST_FLAGS,
  NetworkAccessBlockedError,
  isLoopbackHost,
  networkGuard,
  resolveGuardMode,
  targetFromConnectArgs,
  isUnresolvableHost,
} from "../_setup/blockNetwork.ts";

const PROBE = "tests/unit/fixtures/network-guard-probe.ts";

interface ProbeRun {
  status: number | null;
  stderr: string;
  result: Record<string, string[]>;
}

function runProbe(scenario: string, extraEnv: Record<string, string> = {}): ProbeRun {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const flag of LIVE_TEST_FLAGS) delete env[flag];
  delete env[GUARD_MODE_ENV];
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--import",
      "./open-sse/utils/setupPolyfill.ts",
      "--import",
      "./tests/_setup/isolateDataDir.ts",
      "--import",
      "./tests/_setup/blockNetwork.ts",
      PROBE,
      scenario,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...env, [GUARD_MODE_ENV]: "enforce", ...extraEnv },
      timeout: 300_000,
    }
  );
  const line = child.stdout.split("\n").find((l) => l.startsWith("PROBE_RESULT="));
  const parsed: unknown = line ? JSON.parse(line.slice("PROBE_RESULT=".length)) : {};
  const result: Record<string, string[]> = {};
  if (typeof parsed === "object" && parsed !== null) {
    for (const [key, value] of Object.entries(parsed)) {
      result[key] = Array.isArray(value) ? value.map(String) : [];
    }
  }
  return { status: child.status, stderr: child.stderr, result };
}

function blocked(codes: string[] | undefined): boolean {
  return (
    codes !== undefined &&
    (codes.includes(BLOCKED_ERROR_CODE) || codes.includes(`message:${BLOCKED_ERROR_CODE}`))
  );
}

test("this suite itself runs under the guard", () => {
  // Loaded by the runner's --import, not only by this file's import: the decision was
  // taken before this module graph ran, and it matches the environment.
  assert.equal(networkGuard.decision.mode, resolveGuardMode(process.env).mode);
  if (!LIVE_TEST_FLAGS.some((flag) => process.env[flag] === "1")) {
    assert.notEqual(networkGuard.decision.mode, "off");
  }
  assert.equal(networkGuard.violations.length, 0);
});

test("isLoopbackHost accepts loopback only", () => {
  for (const host of ["127.0.0.1", "127.8.9.10", "::1", "[::1]", "localhost", "LOCALHOST."]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  assert.equal(isLoopbackHost("::ffff:127.0.0.1"), true);
  for (const host of [
    "api.anthropic.com",
    "192.0.2.1",
    "10.0.0.1",
    "0.0.0.0",
    "::",
    "128.0.0.1",
    "localhost.example.com",
    "::ffff:8.8.8.8",
  ]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test("targetFromConnectArgs mirrors net's argument forms", () => {
  assert.deepEqual(targetFromConnectArgs([443, "api.anthropic.com"]), {
    kind: "tcp",
    host: "api.anthropic.com",
    port: "443",
  });
  assert.deepEqual(targetFromConnectArgs([8080]), { kind: "tcp", host: "localhost", port: "8080" });
  assert.deepEqual(targetFromConnectArgs([{ host: "10.0.0.1", port: 80 }]), {
    kind: "tcp",
    host: "10.0.0.1",
    port: "80",
  });
  assert.deepEqual(targetFromConnectArgs([[{ host: "10.0.0.2", port: 81 }, null]]), {
    kind: "tcp",
    host: "10.0.0.2",
    port: "81",
  });
  assert.deepEqual(targetFromConnectArgs([{ path: "/tmp/s.sock" }]), {
    kind: "local-socket",
    path: "/tmp/s.sock",
  });
  assert.deepEqual(targetFromConnectArgs(["\\\\.\\pipe\\x"]), {
    kind: "local-socket",
    path: "\\\\.\\pipe\\x",
  });
});

test("resolveGuardMode: explicit enforce/report, default, off only for live flags", () => {
  assert.equal(resolveGuardMode({}).mode, DEFAULT_GUARD_MODE);
  assert.equal(resolveGuardMode({ [GUARD_MODE_ENV]: "" }).mode, DEFAULT_GUARD_MODE);
  assert.equal(resolveGuardMode({ [GUARD_MODE_ENV]: "enforce" }).mode, "enforce");
  assert.equal(resolveGuardMode({ [GUARD_MODE_ENV]: "report" }).mode, "report");
  for (const flag of LIVE_TEST_FLAGS) {
    assert.equal(resolveGuardMode({ [flag]: "1" }).mode, "off", flag);
    assert.equal(
      resolveGuardMode({ [flag]: "true", [GUARD_MODE_ENV]: "enforce" }).mode,
      "enforce",
      `${flag}=true`
    );
    assert.equal(resolveGuardMode({ [flag]: "1", [GUARD_MODE_ENV]: "enforce" }).mode, "off");
  }
  assert.throws(() => resolveGuardMode({ [GUARD_MODE_ENV]: "off" }), /not supported/);
});

test("the blocked error names the host, the port and the test process", () => {
  const error = new NetworkAccessBlockedError("api.anthropic.com", "443", "socket", "x.test.ts");
  assert.equal(error.code, BLOCKED_ERROR_CODE);
  assert.match(error.message, /api\.anthropic\.com:443/);
  assert.match(error.message, /x\.test\.ts/);
});

test("non-loopback attempts fail with the specific error, and a swallowed one still fails the process", () => {
  const run = runProbe("non-loopback");
  for (const via of ["net", "tls", "fetch", "http", "hostname"]) {
    assert.ok(blocked(run.result[via]), `${via}: ${JSON.stringify(run.result[via])}`);
  }
  // The probe catches every error, yet the guard forces a failing exit code.
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /\[network-guard\] BLOCKED host=192\.0\.2\.1 port=443 via=socket/);
  assert.match(run.stderr, /host=provider\.example\.invalid port=443/);
  assert.match(run.stderr, /network-guard-probe\.ts/, "stack/file must point at the caller");
});

test("loopback and local sockets keep working", () => {
  const run = runProbe("loopback");
  assert.deepEqual(run.result.ipv4, ["OK"]);
  assert.deepEqual(run.result.localhost, ["CONNECTED"]);
  assert.deepEqual(run.result.netDefaultHost, ["CONNECTED"]);
  assert.deepEqual(run.result.localSocket, ["CONNECTED"]);
  assert.ok(
    run.result.ipv6?.[0] === "OK" || run.result.ipv6?.[0] === "IPV6_UNAVAILABLE",
    JSON.stringify(run.result.ipv6)
  );
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /\[network-guard\]/);
});

test("a live-test flag makes the guard stand aside", () => {
  // This host's own non-loopback interface: the guard treats it as network, but the
  // connection never leaves the machine.
  const enforced = runProbe("own-interface");
  const live = runProbe("own-interface", { RUN_LIVE_TESTS: "1" });
  if (enforced.result.ownInterface?.[0] === "NO_INTERFACE") {
    assert.deepEqual(live.result.ownInterface, ["NO_INTERFACE"]);
  } else {
    assert.ok(blocked(enforced.result.ownInterface), JSON.stringify(enforced.result));
    assert.equal(enforced.status, 1);
    assert.deepEqual(live.result.ownInterface, ["CONNECTED"], live.stderr);
  }
  assert.equal(live.status, 0, live.stderr);
  assert.doesNotMatch(live.stderr, /\[network-guard\]/);
});

test("a pinned resolver is judged by the address it returns, not the hostname", () => {
  const run = runProbe("pinned-lookup");
  assert.deepEqual(run.result.pinnedToLoopback, ["OK"], run.stderr);
  assert.ok(blocked(run.result.pinnedToPublic), JSON.stringify(run.result));
  assert.match(
    run.stderr,
    /host=pinned\.example\.test->192\.0\.2\.1 .*via=socket\(pinned-lookup\)/
  );
  assert.equal(run.status, 1);
});

test("report mode still refuses the connection but leaves the exit code alone", () => {
  const run = runProbe("non-loopback", { [GUARD_MODE_ENV]: "report" });
  assert.ok(blocked(run.result.fetch), JSON.stringify(run.result));
  assert.match(run.stderr, /\[network-guard\] REPORT host=192\.0\.2\.1 port=443/);
  assert.equal(run.status, 0, run.stderr);
});

test("an unknown guard mode is rejected at startup", () => {
  const run = runProbe("loopback", { [GUARD_MODE_ENV]: "off" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /is not supported/);
});

test("the guard survives proxyFetch replacing globalThis.fetch at route import", () => {
  const run = runProbe("proxy-fetch");
  assert.deepEqual(run.result.fetchReplacedByRouteImport, ["true"], run.stderr);
  assert.ok(blocked(run.result.outbound), JSON.stringify(run.result));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /\[network-guard\] BLOCKED host=192\.0\.2\.1 port=443 via=socket/);
});

test("the guardedFetch bypass (its own pinned undici Agent) is blocked too", () => {
  // Second known way around a fetch stub: src/shared/network/guardedFetch.ts runs vendor
  // token validation on its own dispatcher, so globalThis.fetch never sees it.
  const run = runProbe("guarded-fetch");
  assert.deepEqual(run.result.loopback, ["OK"], run.stderr);
  assert.ok(blocked(run.result.outbound), JSON.stringify(run.result));
  assert.match(
    run.stderr,
    /host=guarded\.example\.test->192\.0\.2\.1 .*via=socket\(pinned-lookup\)/
  );
  assert.equal(run.status, 1);
});

test("the wreq-js native transport (outside net.Socket) is blocked too", () => {
  const run = runProbe("wreq");
  assert.ok(blocked(run.result.wreq), JSON.stringify(run.result));
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /\[network-guard\] BLOCKED host=192\.0\.2\.1 port=443 via=wreq-js\.request/
  );
});

// ─── RFC-reserved names are not "the network" ──────────────────────────────

test("names under an RFC-reserved TLD are not counted as reaching the network", () => {
  // RFC 2606 / RFC 6761 reserve these as permanently unresolvable, and tests use them to
  // exercise a FAILING outbound path on purpose — api-keys.test.ts sets CLOUD_URL to
  // http://cloud.example so the cloud-sync branch is taken and fails. Counting that as a
  // violation failed a file that never left the machine.
  for (const host of [
    "cloud.example",
    "api.test",
    "nothing.invalid",
    "foo.localhost",
    "DEEP.sub.Example",
    "trailing.example.",
  ]) {
    assert.equal(isUnresolvableHost(host), true, `${host} must be treated as unresolvable`);
  }
});

test("the exemption does not reach real names or addresses", () => {
  // The value of this guard is that its reds are real. An exemption that leaked to
  // `aihorde.net` — the live call the sweep actually caught — would destroy that.
  for (const host of [
    "aihorde.net",
    "api.openai.com",
    "example.com",
    "exampletest",
    "192.0.2.1",
    "2001:db8::1",
  ]) {
    assert.equal(isUnresolvableHost(host), false, `${host} must still be a violation`);
  }
});

test("an unresolvable name is still not loopback", () => {
  // Two separate questions, kept separate: `cloud.example` is exempt from the violation
  // count, but it is not a local address and must never be treated as one.
  assert.equal(isLoopbackHost("cloud.example"), false);
  assert.equal(isLoopbackHost("localhost"), true);
});
