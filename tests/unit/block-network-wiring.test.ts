// Every test entry point that loads tests/_setup/isolateDataDir.ts must also load
// tests/_setup/blockNetwork.ts, so no runner path (npm scripts, CI workflows, the scoped
// and merge-train scripts, Stryker) escapes the network guard.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ISOLATE = "./tests/_setup/isolateDataDir.ts";
const GUARD = "./tests/_setup/blockNetwork.ts";
const ROOT = process.cwd();

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function filesUnder(relative: string, extensions: readonly string[]): string[] {
  const dir = path.join(ROOT, relative);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)));
}

function unguardedLines(relative: string): string[] {
  return read(relative)
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(
      ({ line }) => line.includes(`--import ${ISOLATE}`) && !line.includes(`--import ${GUARD}`)
    )
    .map(({ number }) => `${relative}:${number}`);
}

test("every npm script that isolates DATA_DIR also loads the network guard", () => {
  const pkg: unknown = JSON.parse(read("package.json"));
  const scripts: unknown =
    typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "scripts") : undefined;
  assert.ok(typeof scripts === "object" && scripts !== null);
  const offenders = Object.entries(scripts)
    .filter(([, command]) => typeof command === "string" && command.includes(ISOLATE))
    .filter(([, command]) => typeof command === "string" && !command.includes(`--import ${GUARD}`))
    .map(([name]) => name);
  assert.deepEqual(offenders, []);
  assert.ok(Object.values(scripts).some((c) => typeof c === "string" && c.includes(GUARD)));
});

test("every workflow and shell entry point that isolates DATA_DIR also loads the guard", () => {
  const candidates = [
    ...filesUnder(".github/workflows", [".yml", ".yaml"]),
    ...filesUnder("scripts", [".sh", ".mjs", ".ts"]),
    ...filesUnder("tests", [".sh"]),
  ];
  const offenders = candidates.flatMap(unguardedLines);
  assert.deepEqual(offenders, []);
});

test("Stryker's node args load the guard right after isolateDataDir", () => {
  const config: unknown = JSON.parse(read("stryker.conf.json"));
  const tap: unknown =
    typeof config === "object" && config !== null ? Reflect.get(config, "tap") : undefined;
  const nodeArgs: unknown =
    typeof tap === "object" && tap !== null ? Reflect.get(tap, "nodeArgs") : undefined;
  assert.ok(Array.isArray(nodeArgs));
  const isolateAt = nodeArgs.indexOf(ISOLATE);
  assert.ok(isolateAt > 0);
  assert.deepEqual(nodeArgs.slice(isolateAt + 1, isolateAt + 3), ["--import", GUARD]);
});
