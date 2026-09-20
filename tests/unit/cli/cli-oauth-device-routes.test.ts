import test from "node:test";
import assert from "node:assert/strict";

// Load first: blocks the network before any route/open-sse module is imported.
import { installRouteBackedFetch } from "./_helpers/routeBackedFetch.ts";
import { runOAuthStart } from "../../../bin/cli/commands/oauth.mjs";

// The device flow POSTed /api/providers/{key}/auth/start, polled
// .../auth/status and POSTed .../auth/apply. Those paths exist only for
// command-code; the real flow is GET /api/oauth/{key}/device-code followed by
// POST /api/oauth/{key}/poll, which stores the connection itself.
// `copilot` also had no provider: GitHub Copilot's OAuth app is the `github`
// provider (flowType device_code), and `codex` is PKCE, not a device flow.

test("oauth start --provider copilot drives device-code on the github provider", async (t) => {
  const calls = installRouteBackedFetch(t);
  t.mock.method(process.stdout, "write", () => true);
  t.mock.method(process.stderr, "write", () => true);
  const exits: number[] = [];
  t.mock.method(process, "exit", (code?: number) => {
    exits.push(code ?? 0);
    throw new Error(`exit:${code ?? 0}`);
  });

  // The provider call leaves the machine, which the test guard blocks, so the
  // device-code request fails — after it reached the real route handler.
  await assert.rejects(
    runOAuthStart({ provider: "copilot", browser: false, timeout: 1000 }, undefined),
    /exit:1/
  );

  assert.equal(calls.length, 1, "one request, to the device-code route");
  assert.equal(calls[0].method, "GET");
  assert.equal(
    calls[0].pathname,
    "/api/oauth/github/device-code",
    "copilot maps to the github provider key"
  );
  assert.equal(calls[0].routeFile, "src/app/api/oauth/[provider]/[action]/route.ts");
  assert.notEqual(calls[0].status, 404, "the route exists");
  assert.notEqual(calls[0].status, 405, "GET is exported");
  assert.deepEqual(exits, [1]);
});

test("the removed /api/providers/{key}/auth/* paths are not called any more", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("bin/cli/commands/oauth.mjs", "utf8");
  for (const gone of ["/auth/start", "/auth/status", "/auth/apply"]) {
    assert.equal(
      source.includes(`\${providerKey}${gone}`),
      false,
      `${gone} has no route for OAuth providers`
    );
  }
  assert.match(source, /\/api\/oauth\/\$\{providerKey\}\/device-code/);
  assert.match(source, /\/api\/oauth\/\$\{providerKey\}\/poll/);
});
