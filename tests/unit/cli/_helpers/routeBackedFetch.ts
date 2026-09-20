/**
 * Runs CLI commands against the REAL route handlers instead of a hand-written
 * fetch stub: every request the command makes is resolved through the App
 * Router table (appRoutes.ts), the route module is imported, and its exported
 * HTTP-method handler answers. A command that calls a missing route gets the
 * same JSON 404 the /api catch-all returns; a missing verb gets a 405.
 *
 * NETWORK SAFETY. Importing a route loads open-sse/utils/proxyFetch.ts, which
 * replaces globalThis.fetch at import time and keeps the fetch it found as its
 * "original", and its patched fetch sends direct (no-proxy) traffic through
 * undici with its OWN Agent — i.e. straight to the network, past any fetch
 * stub. So this module, on load and before any route can be imported:
 *   1. blocks every outbound TCP connect in the process (net.Socket#connect
 *      throws for any non-IPC target), which also covers undici Agents,
 *      node:http(s) and SDK clients;
 *   2. imports proxyFetch first, then installs ONE process-wide guarded fetch
 *      that only answers loopback URLs (dispatched in-process to the real
 *      handler) and THROWS for every other URL;
 *   3. clears the proxy env vars and installs an undici MockAgent with
 *      net-connect disabled as a second line for the global dispatcher.
 * installRouteBackedFetch() re-asserts all of this before every test.
 *
 * Import this helper BEFORE any module that may import a route or open-sse.
 * Load the test with `--import ./tests/_setup/isolateDataDir.ts` (the npm test
 * scripts do) so handlers touch a throwaway DATA_DIR. Requests go to
 * http://localhost, the fresh-install loopback path where management auth is
 * not required.
 */
import type { TestContext } from "node:test";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MockAgent, setGlobalDispatcher } from "undici";
import { NextRequest } from "next/server";

import { ROOT, matchRoute, toApiPathname, type RouteParams } from "./appRoutes.ts";

type RouteContext = { params: Promise<RouteParams> };
type RouteHandler = (request: NextRequest, context: RouteContext) => Response | Promise<Response>;

export type RoutedCall = {
  method: string;
  pathname: string;
  search: URLSearchParams;
  body: unknown;
  routeFile: string | null;
  status: number;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

let activeLog: RoutedCall[] | null = null;

function isRouteHandler(value: unknown): value is RouteHandler {
  return typeof value === "function";
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.clone().text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Dispatches one request to the real handler. */
export async function dispatchToRoute(request: NextRequest): Promise<{
  response: Response;
  routeFile: string | null;
}> {
  const url = new URL(request.url);
  const apiPathname = toApiPathname(url.pathname);
  const match = apiPathname ? matchRoute(apiPathname) : null;
  if (!match) {
    return {
      response: Response.json(
        { error: { message: `Unknown API route: ${url.pathname}`, code: "unknown_route" } },
        { status: 404 }
      ),
      routeFile: null,
    };
  }
  const mod: Record<string, unknown> = await import(
    pathToFileURL(path.join(ROOT, match.file)).href
  );
  const handler = mod[request.method];
  if (!isRouteHandler(handler)) {
    return {
      response: Response.json({ error: "Method Not Allowed" }, { status: 405 }),
      routeFile: match.file,
    };
  }
  const response = await handler(request, { params: Promise.resolve(match.params) });
  return { response, routeFile: match.file };
}

async function guardedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = new URL(urlOf(input));
  if (!LOOPBACK_HOSTS.has(target.hostname)) {
    throw new Error(`routeBackedFetch: blocked outbound request to ${target.origin}`);
  }
  if (!activeLog) {
    throw new Error(
      `routeBackedFetch: loopback request to ${target.pathname} outside installRouteBackedFetch()`
    );
  }
  const { signal: _signal, redirect: _redirect, ...rest } = init ?? {};
  const request = new NextRequest(target.href, rest);
  const body = await readJsonBody(request);
  const { response, routeFile } = await dispatchToRoute(request);
  activeLog.push({
    method: request.method,
    pathname: target.pathname,
    search: target.searchParams,
    body,
    routeFile,
    status: response.status,
  });
  return response;
}

for (const key of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]) {
  delete process.env[key];
}
const netBlocker = new MockAgent();
netBlocker.disableNetConnect();
setGlobalDispatcher(netBlocker);

const realConnect = net.Socket.prototype.connect;
function blockedConnect(this: net.Socket, ...args: Parameters<net.Socket["connect"]>): net.Socket {
  const [first] = args;
  const ipcPath =
    typeof first === "string" ||
    (typeof first === "object" &&
      first !== null &&
      "path" in first &&
      typeof first.path === "string");
  if (!ipcPath) {
    throw new Error("routeBackedFetch: outbound TCP connect blocked in CLI route tests");
  }
  return realConnect.apply(this, args);
}
net.Socket.prototype.connect = blockedConnect;

const proxyFetchModule = await import("../../../../open-sse/utils/proxyFetch.ts");
globalThis.fetch = guardedFetch;

/** Throws unless every fetch path in the process ends in the guarded fetch. */
export function assertNetworkGuarded(): void {
  if (net.Socket.prototype.connect !== blockedConnect) {
    throw new Error("routeBackedFetch: the outbound-connect block was removed");
  }
  if (globalThis.fetch !== guardedFetch) {
    throw new Error("routeBackedFetch: globalThis.fetch was replaced by something unguarded");
  }
  if (typeof proxyFetchModule.getOriginalFetch !== "function") {
    throw new Error("routeBackedFetch: proxyFetch did not load before the guard");
  }
}

/**
 * Routes this test's loopback requests to the real handlers and returns the
 * log of routed calls (method, path, body, route file, status).
 */
export function installRouteBackedFetch(t: TestContext): RoutedCall[] {
  assertNetworkGuarded();
  const calls: RoutedCall[] = [];
  activeLog = calls;
  t.after(() => {
    if (activeLog === calls) activeLog = null;
  });
  return calls;
}
