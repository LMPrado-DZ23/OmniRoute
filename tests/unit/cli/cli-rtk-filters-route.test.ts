import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

// Load first: blocks the network before any route/open-sse module is imported.
import { installRouteBackedFetch } from "./_helpers/routeBackedFetch.ts";
import { registerContextEng } from "../../../bin/cli/commands/context-eng.mjs";

// `ctx rtk filters add/remove` POSTed /api/context/rtk/filters and DELETEd
// /api/context/rtk/filters/{id}; the route only exports GET. RTK filters come
// from a filters.toml bundle, validated or installed through
// POST /api/context/rtk/import — which is what `filters import` now calls.

const BUNDLE = `schema_version = 1
[filters.cli-import-test]
description = "CLI import test"
match_command = "^cli-import-test"
strip_lines_matching = ["^noise"]

[[tests.cli-import-test]]
name = "removes noise"
input = "noise\\nkept"
expected = "kept"
`;

function program(): Command {
  const p = new Command();
  p.exitOverride();
  p.option("--output <format>").option("--quiet");
  registerContextEng(p);
  return p;
}

function filtersCommand() {
  return program()
    .commands.find((c) => c.name() === "context-eng")
    ?.commands.find((c) => c.name() === "rtk")
    ?.commands.find((c) => c.name() === "filters");
}

test("rtk filters offers list and import, not per-filter add/remove", () => {
  const filters = filtersCommand();
  assert.ok(filters);
  assert.deepEqual(filters.commands.map((c) => c.name()).sort(), ["import", "list"]);
});

test("rtk filters list reads the real catalog route", async (t) => {
  const calls = installRouteBackedFetch(t);
  t.mock.method(process.stdout, "write", () => true);

  await program().parseAsync(["context-eng", "rtk", "filters", "list", "--output", "json"], {
    from: "user",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].pathname, "/api/context/rtk/filters");
  assert.equal(calls[0].routeFile, "src/app/api/context/rtk/filters/route.ts");
  assert.equal(calls[0].status, 200);
});

test("rtk filters import validates a bundle through the real import route", async (t) => {
  const calls = installRouteBackedFetch(t);
  t.mock.method(process.stdout, "write", () => true);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rtk-cli-")), "filters.toml");
  fs.writeFileSync(file, BUNDLE);

  await program().parseAsync(
    ["context-eng", "rtk", "filters", "import", file, "--output", "json"],
    {
      from: "user",
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].pathname, "/api/context/rtk/import");
  assert.equal(calls[0].routeFile, "src/app/api/context/rtk/import/route.ts");
  assert.equal(calls[0].status, 200, "the real handler must accept the request body");
  assert.deepEqual(calls[0].body, { action: "validate", content: BUNDLE });
});

test("rtk filters import --install installs the bundle for real", async (t) => {
  const calls = installRouteBackedFetch(t);
  const printed: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    printed.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rtk-cli-")), "filters.toml");
  fs.writeFileSync(file, BUNDLE);

  await program().parseAsync(
    [
      "context-eng",
      "rtk",
      "filters",
      "import",
      file,
      "--install",
      "--overwrite",
      "--output",
      "json",
    ],
    { from: "user" }
  );

  assert.deepEqual(calls[0].body, { action: "install", content: BUNDLE, overwrite: true });
  assert.equal(calls[0].status, 200);
  const installed = path.join(process.env.DATA_DIR ?? "", "rtk", "filters.toml");
  assert.ok(fs.existsSync(installed), "the bundle must land in DATA_DIR/rtk/filters.toml");
  assert.match(printed.join(""), /cli-import-test/);
});
