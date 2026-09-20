// Child-process probe for tests/unit/block-network-guard.test.ts.
//
// Run as `node --import tsx/esm ... --import ./tests/_setup/blockNetwork.ts
// tests/unit/fixtures/network-guard-probe.ts <scenario>`; prints ONE JSON line prefixed
// with PROBE_RESULT= and lets the guard decide the exit code. Non-loopback targets are
// 192.0.2.1 (RFC 5737 TEST-NET-1, never routed to a real host), so even a broken guard
// cannot reach a provider from here.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { createRequire } from "node:module";

const BLACKHOLE = "192.0.2.1";

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const code: unknown = Reflect.get(current, "code");
    if (typeof code === "string") codes.push(code);
    const message: unknown = Reflect.get(current, "message");
    if (typeof message === "string" && message.includes("ERR_TEST_NETWORK_BLOCKED")) {
      codes.push("message:ERR_TEST_NETWORK_BLOCKED");
    }
    current = Reflect.get(current, "cause");
  }
  return codes;
}

function socketOutcome(socket: net.Socket, timeoutMs = 3000): Promise<string[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(["TIMEOUT"]);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(["CONNECTED"]);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve(errorCodes(error));
    });
  });
}

async function settle(run: () => Promise<unknown>): Promise<string[]> {
  try {
    await run();
    return ["OK"];
  } catch (error) {
    return errorCodes(error);
  }
}

async function withServer<T>(
  listen: (server: http.Server) => Promise<void>,
  use: (server: http.Server) => Promise<T>
): Promise<T> {
  const server = http.createServer((_req, res) => res.end("ok"));
  await listen(server);
  try {
    return await use(server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function listenOn(host: string): (server: http.Server) => Promise<void> {
  return (server) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => resolve());
    });
}

function portOf(server: http.Server): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function nonLoopback(): Promise<Record<string, string[]>> {
  return {
    net: await socketOutcome(net.connect(443, BLACKHOLE)),
    tls: await socketOutcome(tls.connect({ host: BLACKHOLE, port: 443 })),
    fetch: await settle(() => fetch(`https://${BLACKHOLE}/v1/messages`)),
    http: await new Promise<string[]>((resolve) => {
      http
        .get(`http://${BLACKHOLE}/`, (res) => {
          res.resume();
          resolve(["OK"]);
        })
        .on("error", (error) => resolve(errorCodes(error)));
    }),
    hostname: await settle(() => fetch("https://provider.example.invalid/v1/chat")),
  };
}

async function loopback(): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  await withServer(listenOn("127.0.0.1"), async (server) => {
    const port = portOf(server);
    result.ipv4 = await settle(() => fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()));
    result.localhost = await socketOutcome(net.connect(port, "localhost"));
    result.netDefaultHost = await socketOutcome(net.connect(port));
  });
  try {
    await withServer(listenOn("::1"), async (server) => {
      result.ipv6 = await settle(() =>
        fetch(`http://[::1]:${portOf(server)}/`).then((r) => r.text())
      );
    });
  } catch {
    result.ipv6 = ["IPV6_UNAVAILABLE"];
  }
  const pipePath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\omniroute-guard-${process.pid}`
      : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "guard-")), "s.sock");
  const pipeServer = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => pipeServer.listen(pipePath, () => resolve()));
  result.localSocket = await socketOutcome(net.connect(pipePath));
  await new Promise<void>((resolve) => pipeServer.close(() => resolve()));
  return result;
}

/** A non-loopback address of THIS host: the connection never leaves the machine. */
async function ownInterface(): Promise<Record<string, string[]>> {
  const address = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address;
  if (!address) return { ownInterface: ["NO_INTERFACE"] };
  return withServer(listenOn("0.0.0.0"), async (server) => ({
    ownInterface: await socketOutcome(net.connect(portOf(server), address)),
  }));
}

/**
 * A dispatcher that pins its own resolver (src/shared/network/guardedFetch.ts does this):
 * the hostname says nothing about where the socket goes, the resolved address does.
 */
async function pinnedLookup(): Promise<Record<string, string[]>> {
  const { Agent, request } = await import("undici");
  const pinTo = (address: string) =>
    new Agent({
      connect: {
        // Same shape as src/shared/network/hardenedWebhookFetch.ts::pinnedLookup.
        lookup: (_hostname: string, options: unknown, callback: unknown) => {
          if (typeof callback !== "function") return;
          const wantsAll =
            typeof options === "object" && options !== null && Reflect.get(options, "all") === true;
          if (wantsAll) callback(null, [{ address, family: 4 }]);
          else callback(null, address, 4);
        },
      },
    });
  const result: Record<string, string[]> = {};
  await withServer(listenOn("127.0.0.1"), async (server) => {
    const port = portOf(server);
    result.pinnedToLoopback = await settle(async () => {
      const response = await request(`http://pinned.example.test:${port}/`, {
        dispatcher: pinTo("127.0.0.1"),
      });
      await response.body.text();
    });
    result.pinnedToPublic = await settle(async () => {
      const response = await request(`http://pinned.example.test:${port}/`, {
        dispatcher: pinTo(BLACKHOLE),
      });
      await response.body.text();
    });
  });
  return result;
}

/**
 * The second known fetch-stub bypass (after proxyFetch): src/shared/network/guardedFetch.ts
 * validates the target, then runs the request on its OWN undici Agent with a pinned
 * resolver — a stub on globalThis.fetch never sees it. Its resolver is injected here so
 * the probe performs no DNS of its own.
 */
async function guardedFetchBypass(): Promise<Record<string, string[]>> {
  const { guardedFetch } = await import("../../../src/shared/network/guardedFetch.ts");
  const resolvesTo = (address: string) => async () => [{ address, family: 4 as const }];
  const result: Record<string, string[]> = {};
  await withServer(listenOn("127.0.0.1"), async (server) => {
    result.loopback = await settle(() =>
      guardedFetch(`http://guarded.example.test:${portOf(server)}/`, {
        lookup: resolvesTo("127.0.0.1"),
        allowPrivate: true,
      }).then((response) => response.text())
    );
  });
  result.outbound = await settle(() =>
    guardedFetch("https://guarded.example.test/v1/models", {
      lookup: resolvesTo(BLACKHOLE),
    })
  );
  return result;
}

async function proxyFetchPatched(): Promise<Record<string, string[]>> {
  const fetchBefore = globalThis.fetch;
  // The incident path: a route import pulls open-sse/utils/proxyFetch.ts, which
  // replaces globalThis.fetch with its own wrapper around the real fetch.
  await import("../../../src/app/api/providers/claude-auth/import/route.ts");
  const replaced = globalThis.fetch !== fetchBefore;
  return {
    fetchReplacedByRouteImport: [String(replaced)],
    outbound: await settle(() =>
      globalThis.fetch(`https://${BLACKHOLE}/api/claude_cli/bootstrap`, { method: "GET" })
    ),
  };
}

async function wreq(): Promise<Record<string, string[]>> {
  const wreqJs: unknown = createRequire(import.meta.url)("wreq-js");
  const wreqFetch: unknown =
    typeof wreqJs === "object" && wreqJs !== null ? Reflect.get(wreqJs, "fetch") : undefined;
  if (typeof wreqFetch !== "function") return { wreq: ["WREQ_UNAVAILABLE"] };
  return {
    wreq: await settle(() =>
      Promise.race([
        Reflect.apply(wreqFetch, undefined, [`https://${BLACKHOLE}/`]),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), 5000)
        ),
      ])
    ),
  };
}

const scenarios: Record<string, () => Promise<Record<string, string[]>>> = {
  "non-loopback": nonLoopback,
  loopback,
  "own-interface": ownInterface,
  "pinned-lookup": pinnedLookup,
  "proxy-fetch": proxyFetchPatched,
  "guarded-fetch": guardedFetchBypass,
  wreq,
};

const scenario = process.argv[2] ?? "";
const run = scenarios[scenario];
if (!run) throw new Error(`unknown scenario "${scenario}"`);
const outcome = await run();
process.stdout.write(`PROBE_RESULT=${JSON.stringify(outcome)}\n`);
