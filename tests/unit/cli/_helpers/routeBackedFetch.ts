/**
 * Runs CLI commands against the REAL route handlers instead of a hand-written
 * fetch stub: every request the command makes is resolved through the App
 * Router table (appRoutes.ts), the route module is imported, and its exported
 * HTTP-method handler answers. A command that calls a missing route gets the
 * same JSON 404 the /api catch-all returns; a missing verb gets a 405.
 *
 * Load the test with `--import ./tests/_setup/isolateDataDir.ts` (the npm test
 * scripts do) so handlers touch a throwaway DATA_DIR. Requests go to
 * http://localhost, the fresh-install loopback path where management auth is
 * not required.
 */
import type { TestContext } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

/** Dispatches one request to the real handler; exported for direct use in tests. */
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

/**
 * Replaces global fetch for the duration of the test. Returns the log of
 * routed calls so tests can assert on the method, path and body that reached
 * the handler.
 */
export function installRouteBackedFetch(t: TestContext): RoutedCall[] {
  const calls: RoutedCall[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const { signal: _signal, redirect: _redirect, ...rest } = init ?? {};
    const request = new NextRequest(urlOf(input), rest);
    const body = await readJsonBody(request);
    const { response, routeFile } = await dispatchToRoute(request);
    const url = new URL(request.url);
    calls.push({
      method: request.method,
      pathname: url.pathname,
      search: url.searchParams,
      body,
      routeFile,
      status: response.status,
    });
    return response;
  });
  return calls;
}
