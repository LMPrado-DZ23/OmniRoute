import test from "node:test";
import assert from "node:assert/strict";

import { runCacheClearCommand } from "../../../bin/cli/commands/cache.mjs";
import { installRouteBackedFetch } from "./_helpers/routeBackedFetch.ts";

// `omniroute cache clear` used to POST /api/cache/clear, a route that never
// existed. The full clear is DELETE /api/cache (what the dashboard's cache page
// and Settings → System storage call). Run the command against the real handler.

test("cache clear --yes performs the full clear through DELETE /api/cache", async (t) => {
  const calls = installRouteBackedFetch(t);
  const logged: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  t.mock.method(console, "error", () => {});

  const exitCode = await runCacheClearCommand({ yes: true });

  assert.equal(exitCode, 0);
  const clear = calls.find((c) => c.method === "DELETE");
  assert.ok(clear, "cache clear must issue a DELETE");
  assert.equal(clear.pathname, "/api/cache");
  assert.equal(clear.routeFile, "src/app/api/cache/route.ts");
  assert.equal(clear.status, 200);
  assert.equal([...clear.search.keys()].length, 0, "no selector means a full clear");
  assert.ok(logged.some((line) => /clear/i.test(line)));
});
