// Test-only network guard: unit tests must never reach a real provider.
//
// Loaded via `node --import ./tests/_setup/blockNetwork.ts` next to
// tests/_setup/isolateDataDir.ts in every test invocation (package.json test scripts,
// stryker.conf.json tap.nodeArgs, the quality.yml TIA step, scripts/quality/test-scoped.sh
// and scripts/release/merge-train.sh). tests/unit/block-network-wiring.test.ts fails if
// any of those places loads isolateDataDir.ts without this module. NEVER import it from
// production code.
//
// Why it sits BELOW fetch: importing a route loads open-sse/utils/proxyFetch.ts, which
// replaces globalThis.fetch at import time with its own wrapper around the real fetch.
// A test that stubbed globalThis.fetch before that import was silently bypassed and sent
// real requests to api.anthropic.com. Any guard that patches globalThis.fetch can be
// bypassed the same way, and an undici global dispatcher is not enough either, because a
// request can carry its own dispatcher (proxyFetch does). So the guard hooks:
//
//   1. net.Socket.prototype.connect: every TCP client in Node ends here — the built-in
//      fetch, undici with any Agent/dispatcher, http/https/http2, net.connect and
//      tls.connect (a TLSSocket is a net.Socket and tls.connect calls its connect()).
//   2. The wreq-js native binding (request / createTransport / websocketConnect*): its
//      Rust HTTP client opens sockets outside Node's net module, so the socket hook
//      cannot see it. The binding is patched lazily, the first time anything requires it.
//
// Allowed: loopback (127.0.0.0/8, ::1, IPv4-mapped loopback, `localhost`) and Unix
// sockets / Windows named pipes, so tests that start a local server keep working.
//
// Modes (env OMNIROUTE_TEST_NETWORK_GUARD):
//   "enforce"  the attempt is refused, reported on stderr, and the process exits
//              non-zero even if the test caught and swallowed the error.
//   "report"   the attempt is still refused (nothing leaves the machine) and reported,
//              but the process exit code is left alone — used to inventory offenders
//              without failing the run on the guard itself.
//   unset      DEFAULT_GUARD_MODE.
// Any other value is rejected at startup.
//
// Live tests: when one of LIVE_TEST_FLAGS is exactly "1" the guard stands aside entirely.
import net from "node:net";
import { Module } from "node:module";

export const GUARD_MODE_ENV = "OMNIROUTE_TEST_NETWORK_GUARD";
export const BLOCKED_ERROR_CODE = "ERR_TEST_NETWORK_BLOCKED";
export const LOG_PREFIX = "[network-guard]";

/**
 * Existing opt-in flags whose tests are meant to send real traffic to external hosts.
 * Every one is compared with === "1" by the tests that read it.
 */
export const LIVE_TEST_FLAGS = [
  "RUN_LIVE_TESTS", // tests/helpers/liveOptIn.ts — tests/integration live suites
  "RUN_COMBO_LIVE", // tests/integration/combo-live (npm run test:combo:live)
  "RUN_BOUNDARY_LIVE", // tests/boundary/*.live.test.ts (npm run test:boundary:live)
  "RUN_LIVE_WIRE_CAPTURE", // tests/integration/live-default-combo-wire-capture.test.ts
  "RUN_CLI_SMOKE", // tests/integration/upstream-cli-smoke.int.test.ts
  "RUN_CONTRACT_INT", // tests/integration/provider-journey.contract.test.ts
  "RUN_SERVICES_INT", // tests/integration/services — npm registry + binary downloads
  "RUN_LLMLINGUA_INT", // tests/unit/compression/llmlingua-ultra-entry.test.ts — model download
  "RUN_QUOTA_REDIS_INT", // tests/unit/quota-redis-store.test.ts — real Redis
] as const;

export type GuardMode = "enforce" | "report" | "off";

/** Mode used when OMNIROUTE_TEST_NETWORK_GUARD is unset. */
export const DEFAULT_GUARD_MODE: "enforce" | "report" = "report";

export interface GuardDecision {
  mode: GuardMode;
  reason: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export function resolveGuardMode(env: Env): GuardDecision {
  const liveFlag = LIVE_TEST_FLAGS.find((flag) => env[flag] === "1");
  if (liveFlag) return { mode: "off", reason: `${liveFlag}=1 (live test run)` };
  const raw = env[GUARD_MODE_ENV];
  if (raw === undefined || raw === "") return { mode: DEFAULT_GUARD_MODE, reason: "default" };
  if (raw === "enforce" || raw === "report") {
    return { mode: raw, reason: `${GUARD_MODE_ENV}=${raw}` };
  }
  throw new Error(
    `${LOG_PREFIX} ${GUARD_MODE_ENV}="${raw}" is not supported. Use "enforce" or "report" ` +
      `(default: ${DEFAULT_GUARD_MODE}). To send real traffic, run a live suite with its live-test flag ` +
      `(${LIVE_TEST_FLAGS.join(", ")}).`
  );
}

const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/** True for loopback IPs (v4, v6, IPv4-mapped v6) and the name `localhost`. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
  if (normalized === "localhost") return true;
  const family = net.isIP(normalized);
  if (family === 4) return loopback.check(normalized, "ipv4");
  if (family === 6) return loopback.check(normalized, "ipv6");
  return false;
}

export type ConnectTarget =
  { kind: "local-socket"; path: string } | { kind: "tcp"; host: string; port: string };

function isPipeName(value: string): boolean {
  return value.length > 0 && Number.isNaN(Number(value));
}

/** Mirrors net's normalizeArgs() closely enough to know where a connect() goes. */
export function targetFromConnectArgs(args: readonly unknown[]): ConnectTarget {
  const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "object" && first !== null) {
    if ("path" in first && typeof first.path === "string" && first.path !== "") {
      return { kind: "local-socket", path: first.path };
    }
    const host = "host" in first && typeof first.host === "string" ? first.host : "localhost";
    const port = "port" in first ? String(first.port) : "";
    return { kind: "tcp", host, port };
  }
  if (typeof first === "string" && isPipeName(first)) {
    return { kind: "local-socket", path: first };
  }
  const host = typeof args[1] === "string" ? args[1] : "localhost";
  return { kind: "tcp", host, port: String(first) };
}

export class NetworkAccessBlockedError extends Error {
  override name = "NetworkAccessBlockedError";
  readonly code = BLOCKED_ERROR_CODE;

  constructor(
    readonly host: string,
    readonly port: string,
    readonly via: string,
    readonly testFile: string
  ) {
    super(
      `Unit tests must not reach the network: blocked ${via} connection to ${host}:${port} ` +
        `(test process: ${testFile}). Stub the call AFTER all imports and assert the stub is ` +
        `the live one (open-sse/utils/proxyFetch.ts replaces globalThis.fetch at import ` +
        `time); a real live test must run under its live-test flag ` +
        `(${LIVE_TEST_FLAGS.join(", ")}). Guard: tests/_setup/blockNetwork.ts ` +
        `[${BLOCKED_ERROR_CODE}]`
    );
  }
}

export interface Violation {
  host: string;
  port: string;
  via: string;
  testFile: string;
  stack: string;
}

function currentTestFile(): string {
  return process.argv[1] ?? "(unknown)";
}

function captureStack(): string {
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const stack = new Error("network attempt").stack ?? "";
  Error.stackTraceLimit = previousLimit;
  return stack
    .split("\n")
    .slice(1)
    .filter((line) => !line.includes("blockNetwork.ts"))
    .join("\n");
}

function hostPortFromUrl(raw: string): { host: string; port: string } {
  try {
    const url = new URL(raw);
    const defaultPort =
      url.protocol === "https:" || url.protocol === "wss:"
        ? "443"
        : url.protocol === "socks5:" || url.protocol === "socks5h:"
          ? "1080"
          : "80";
    return { host: url.hostname, port: url.port || defaultPort };
  } catch {
    return { host: raw, port: "" };
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" && field !== "" ? field : undefined;
}

export interface NetworkGuard {
  readonly decision: GuardDecision;
  readonly violations: readonly Violation[];
}

const INSTALLED = Symbol.for("omniroute.tests.networkGuard");

function isNetworkGuard(value: unknown): value is NetworkGuard {
  return typeof value === "object" && value !== null && "decision" in value;
}

function installNetworkGuard(decision: GuardDecision): NetworkGuard {
  const violations: Violation[] = [];

  function block(host: string, port: string, via: string): NetworkAccessBlockedError {
    const testFile = currentTestFile();
    const violation: Violation = { host, port, via, testFile, stack: captureStack() };
    violations.push(violation);
    process.stderr.write(
      `${LOG_PREFIX} ${decision.mode === "report" ? "REPORT" : "BLOCKED"} ` +
        `host=${host} port=${port} via=${via} file=${testFile}\n${violation.stack}\n`
    );
    return new NetworkAccessBlockedError(host, port, via, testFile);
  }

  // 1. Socket layer.
  const originalConnect = net.Socket.prototype.connect;
  function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = targetFromConnectArgs(args);
    if (target.kind === "local-socket" || isLoopbackHost(target.host)) {
      return Reflect.apply(originalConnect, this, args);
    }
    const error = block(target.host, target.port, "socket");
    // Fail the way a refused connection fails (async 'error' on the socket), so every
    // client — fetch, undici, http, tls — surfaces it through its normal error path.
    process.nextTick(() => this.destroy(error));
    return this;
  }
  Object.defineProperty(net.Socket.prototype, "connect", {
    value: guardedConnect,
    writable: true,
    configurable: true,
  });

  // 2. wreq-js native binding (Rust sockets never touch net.Socket).
  const transportProxies = new Map<string, string>();
  const patchedBindings = new WeakSet<object>();

  function wreqTarget(options: unknown): { host: string; port: string } | null {
    const transportId = stringField(options, "transportId");
    const egress =
      stringField(options, "proxy") ??
      (transportId ? transportProxies.get(transportId) : undefined) ??
      stringField(options, "url");
    if (!egress) return null;
    const target = hostPortFromUrl(egress);
    return isLoopbackHost(target.host) ? null : target;
  }

  function wrapBindingCall(binding: object, name: string): void {
    const original: unknown = Reflect.get(binding, name);
    if (typeof original !== "function") return;
    Object.defineProperty(binding, name, {
      value: function guardedBindingCall(this: unknown, ...args: unknown[]): unknown {
        const target = wreqTarget(args[0]);
        if (target) return Promise.reject(block(target.host, target.port, `wreq-js.${name}`));
        return Reflect.apply(original, this, args);
      },
      writable: true,
      configurable: true,
    });
  }

  function patchWreqBinding(exported: unknown): void {
    if (typeof exported !== "object" || exported === null) return;
    if (patchedBindings.has(exported)) return;
    const createTransport: unknown = Reflect.get(exported, "createTransport");
    const request: unknown = Reflect.get(exported, "request");
    if (typeof createTransport !== "function" || typeof request !== "function") return;
    patchedBindings.add(exported);
    Object.defineProperty(exported, "createTransport", {
      value: function guardedCreateTransport(this: unknown, ...args: unknown[]): unknown {
        const id: unknown = Reflect.apply(createTransport, this, args);
        const proxy = stringField(args[0], "proxy");
        if (typeof id === "string" && proxy) transportProxies.set(id, proxy);
        return id;
      },
      writable: true,
      configurable: true,
    });
    for (const name of ["request", "websocketConnect", "websocketConnectSession"]) {
      wrapBindingCall(exported, name);
    }
  }

  // wreq-js (both its ESM and CJS builds) loads the binding through createRequire(),
  // whose require() delegates to Module.prototype.require. Patch lazily there so test
  // processes that never touch wreq-js do not pay for loading the native addon.
  const originalRequire = Module.prototype.require;
  Object.defineProperty(Module.prototype, "require", {
    value: function guardedRequire(this: Module, id: string): unknown {
      const exported: unknown = Reflect.apply(originalRequire, this, [id]);
      if (id.includes("wreq-js")) patchWreqBinding(exported);
      return exported;
    },
    writable: true,
    configurable: true,
  });

  process.on("exit", () => {
    if (violations.length === 0) return;
    const hosts = [...new Set(violations.map((v) => `${v.host}:${v.port}`))].join(", ");
    process.stderr.write(
      `${LOG_PREFIX} ${violations.length} non-loopback connection attempt(s) in ` +
        `${currentTestFile()}: ${hosts}\n`
    );
    if (decision.mode === "enforce") process.exitCode = 1;
  });

  return { decision, violations };
}

function activate(): NetworkGuard {
  const existing: unknown = Reflect.get(globalThis, INSTALLED);
  if (isNetworkGuard(existing)) return existing;
  const decision = resolveGuardMode(process.env);
  const guard: NetworkGuard =
    decision.mode === "off" ? { decision, violations: [] } : installNetworkGuard(decision);
  Object.defineProperty(globalThis, INSTALLED, { value: guard, enumerable: false });
  return guard;
}

/** The active guard of this process (mode, and the attempts recorded so far). */
export const networkGuard: NetworkGuard = activate();
