import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error - JS build helper without type declarations
import {
  materializeBundledSymlinks,
  syncRebuiltNativeModuleIntoHashedEntries,
} from "../../scripts/build/assembleStandalone.mjs";

function makePkg(dir: string, name: string, marker: string) {
  const pkgDir = join(dir, name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, marker }));
  return pkgDir;
}

test("materializeBundledSymlinks dereferences a live symlink into a real directory", () => {
  const root = mkdtempSync(join(tmpdir(), "mbs-live-"));
  try {
    const realPkgHome = join(root, "external");
    mkdirSync(realPkgHome, { recursive: true });
    makePkg(realPkgHome, "ws", "real-ws");

    const nm = join(root, "bundle", "node_modules");
    mkdirSync(nm, { recursive: true });
    symlinkSync(join(realPkgHome, "ws"), join(nm, "ws-a972e7ffa40ff725"), "dir");

    const summary = materializeBundledSymlinks(nm);

    assert.equal(summary.materialized, 1);
    const target = join(nm, "ws-a972e7ffa40ff725");
    assert.equal(lstatSync(target).isSymbolicLink(), false);
    assert.equal(lstatSync(target).isDirectory(), true);
    assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).marker, "real-ws");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("materializeBundledSymlinks relinks a dangling hashed symlink to its sibling real package", () => {
  const root = mkdtempSync(join(tmpdir(), "mbs-dangle-"));
  try {
    const nm = join(root, "node_modules");
    mkdirSync(nm, { recursive: true });
    // Sibling real package (as copied by copyNativeAssetsAndExtraModules).
    makePkg(nm, "better-sqlite3", "real-bsq");
    // Dangling absolute link into a build machine that does not exist here.
    symlinkSync(
      "/Users/runner/work/OmniRoute/OmniRoute/.build/next/standalone/node_modules/better-sqlite3",
      join(nm, "better-sqlite3-90e2652d1716b047"),
      "dir"
    );

    const summary = materializeBundledSymlinks(nm);

    assert.equal(summary.relinked, 1);
    const target = join(nm, "better-sqlite3-90e2652d1716b047");
    assert.equal(lstatSync(target).isSymbolicLink(), false);
    assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).marker, "real-bsq");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("materializeBundledSymlinks drops a dangling link with no resolvable sibling", () => {
  const root = mkdtempSync(join(tmpdir(), "mbs-drop-"));
  try {
    const nm = join(root, "node_modules");
    mkdirSync(nm, { recursive: true });
    symlinkSync(
      "/nonexistent/build/machine/path/mystery",
      join(nm, "mystery-deadbeefcafe0001"),
      "dir"
    );

    const summary = materializeBundledSymlinks(nm);

    assert.equal(summary.removed, 1);
    assert.equal(existsSync(join(nm, "mystery-deadbeefcafe0001")), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("materializeBundledSymlinks handles scoped-package symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "mbs-scope-"));
  try {
    const realPkgHome = join(root, "external");
    mkdirSync(join(realPkgHome, "@huggingface"), { recursive: true });
    makePkg(join(realPkgHome, "@huggingface"), "transformers", "real-hf");

    const nm = join(root, "node_modules");
    mkdirSync(join(nm, "@huggingface"), { recursive: true });
    symlinkSync(
      join(realPkgHome, "@huggingface", "transformers"),
      join(nm, "@huggingface", "transformers-abc1234567890def"),
      "dir"
    );

    const summary = materializeBundledSymlinks(nm);

    assert.equal(summary.materialized, 1);
    const target = join(nm, "@huggingface", "transformers-abc1234567890def");
    assert.equal(lstatSync(target).isSymbolicLink(), false);
    assert.equal(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).marker, "real-hf");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("materializeBundledSymlinks leaves real directories untouched and no-ops on missing dir", () => {
  const root = mkdtempSync(join(tmpdir(), "mbs-noop-"));
  try {
    const nm = join(root, "node_modules");
    mkdirSync(nm, { recursive: true });
    makePkg(nm, "pino", "real-pino");

    const summary = materializeBundledSymlinks(nm);
    assert.deepEqual(summary, { materialized: 0, relinked: 0, removed: 0 });
    assert.equal(existsSync(join(nm, "pino", "package.json")), true);

    const missing = materializeBundledSymlinks(join(root, "does-not-exist"));
    assert.deepEqual(missing, { materialized: 0, relinked: 0, removed: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("syncRebuiltNativeModuleIntoHashedEntries overwrites a hashed entry with the rebuilt root module", () => {
  const root = mkdtempSync(join(tmpdir(), "sync-hashed-"));
  try {
    const rootModule = makePkg(root, "better-sqlite3", "electron-abi-rebuilt");

    const nm = join(root, "nested", "node_modules");
    makePkg(nm, "better-sqlite3-90e2652d1716b047", "stale-node-abi");

    const summary = syncRebuiltNativeModuleIntoHashedEntries(rootModule, nm);

    assert.equal(summary.synced, 1);
    const target = join(nm, "better-sqlite3-90e2652d1716b047");
    assert.equal(
      JSON.parse(readFileSync(join(target, "package.json"), "utf8")).marker,
      "electron-abi-rebuilt"
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("syncRebuiltNativeModuleIntoHashedEntries overwrites a plain-named entry too", () => {
  const root = mkdtempSync(join(tmpdir(), "sync-plain-"));
  try {
    const rootModule = makePkg(root, "better-sqlite3", "electron-abi-rebuilt");

    const nm = join(root, "nested", "node_modules");
    makePkg(nm, "better-sqlite3", "stale-node-abi");

    const summary = syncRebuiltNativeModuleIntoHashedEntries(rootModule, nm);

    assert.equal(summary.synced, 1);
    assert.equal(
      JSON.parse(readFileSync(join(nm, "better-sqlite3", "package.json"), "utf8")).marker,
      "electron-abi-rebuilt"
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("syncRebuiltNativeModuleIntoHashedEntries no-ops when root module or nested node_modules is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "sync-noop-"));
  try {
    const rootModule = join(root, "does-not-exist", "better-sqlite3");
    const nm = join(root, "nested", "node_modules");
    makePkg(nm, "better-sqlite3", "stale-node-abi");

    const missingRoot = syncRebuiltNativeModuleIntoHashedEntries(rootModule, nm);
    assert.deepEqual(missingRoot, { synced: 0 });

    const realRootModule = makePkg(root, "better-sqlite3", "electron-abi-rebuilt");
    const missingNm = syncRebuiltNativeModuleIntoHashedEntries(
      realRootModule,
      join(root, "does-not-exist-nm")
    );
    assert.deepEqual(missingNm, { synced: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("syncRebuiltNativeModuleIntoHashedEntries leaves unrelated entries untouched", () => {
  const root = mkdtempSync(join(tmpdir(), "sync-unrelated-"));
  try {
    const rootModule = makePkg(root, "better-sqlite3", "electron-abi-rebuilt");

    const nm = join(root, "nested", "node_modules");
    makePkg(nm, "pino", "real-pino");
    makePkg(nm, "better-sqlite3-helper", "unrelated-package");

    const summary = syncRebuiltNativeModuleIntoHashedEntries(rootModule, nm);

    assert.deepEqual(summary, { synced: 0 });
    assert.equal(
      JSON.parse(readFileSync(join(nm, "pino", "package.json"), "utf8")).marker,
      "real-pino"
    );
    assert.equal(
      JSON.parse(readFileSync(join(nm, "better-sqlite3-helper", "package.json"), "utf8")).marker,
      "unrelated-package"
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ---- Regression: the Windows leg of the v3.8.52 desktop release ------------------------
//
// The top-level pass only saw direct entries of node_modules. `global-agent/node_modules/
// .bin/semver` is nested, and Next's standalone copy writes it as an absolute link into the
// Linux build checkout. Restored on Windows it dangled, and 7-Zip aborted while packing the
// NSIS installer.

test("materializeBundledSymlinks dereferences a nested .bin link into a real file", () => {
  const root = mkdtempSync(join(tmpdir(), "mbs-nested-live-"));
  try {
    const checkout = join(root, "checkout", "semver", "bin");
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "semver.js"), "#!/usr/bin/env node\n// real semver cli\n");

    const nm = join(root, "bundle", "node_modules");
    const binDir = join(nm, "global-agent", "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(nm, "global-agent", "package.json"),
      JSON.stringify({ name: "global-agent" })
    );
    symlinkSync(join(checkout, "semver.js"), join(binDir, "semver"), "file");

    const summary = materializeBundledSymlinks(nm);

    const shim = join(binDir, "semver");
    assert.equal(summary.materialized, 1);
    assert.equal(lstatSync(shim).isSymbolicLink(), false);
    assert.equal(readFileSync(shim, "utf8"), "#!/usr/bin/env node\n// real semver cli\n");
    assert.equal(existsSync(join(nm, "global-agent", "package.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("materializeBundledSymlinks drops a nested link whose absolute target is gone", () => {
  const root = mkdtempSync(join(tmpdir(), "mbs-nested-dangle-"));
  try {
    const nm = join(root, "node_modules");
    const binDir = join(nm, "global-agent", "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "keep.txt"), "not a link");
    // An absolute target that cannot exist on any machine. A path like /home/runner/work/...
    // is real on the GitHub runner itself, where the link would be live, not dangling.
    symlinkSync(
      join(root, "build-machine", "semver", "bin", "semver.js"),
      join(binDir, "semver"),
      "file"
    );

    const summary = materializeBundledSymlinks(nm);

    assert.equal(summary.removed, 1);
    assert.equal(existsSync(join(binDir, "semver")), false);
    let stillThere = true;
    try {
      lstatSync(join(binDir, "semver"));
    } catch {
      stillThere = false;
    }
    assert.equal(stillThere, false, "the dangling link itself must be gone, not just unresolvable");
    assert.equal(readFileSync(join(binDir, "keep.txt"), "utf8"), "not a link");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("materializeBundledSymlinks drops a nested link to its own ancestor instead of recursing", () => {
  const root = mkdtempSync(join(tmpdir(), "mbs-nested-cycle-"));
  try {
    const nm = join(root, "node_modules");
    const pkgDir = join(nm, "pkg");
    mkdirSync(join(pkgDir, "sub"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "pkg" }));
    symlinkSync(pkgDir, join(pkgDir, "sub", "loop"), "dir");

    const summary = materializeBundledSymlinks(nm);

    assert.equal(summary.removed, 1);
    assert.equal(summary.materialized, 0);
    assert.equal(existsSync(join(pkgDir, "sub", "loop")), false);
    assert.equal(existsSync(join(pkgDir, "package.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
