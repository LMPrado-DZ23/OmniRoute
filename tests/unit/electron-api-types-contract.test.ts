/**
 * Contract between the Electron bridge and its renderer-facing types.
 *
 * electron/types.d.ts is hand-written, and it had drifted: preload.js exposed 12 members
 * (auto-update, autostart, web-cookie login, getAppVersion) that ElectronAPI did not declare, so
 * every dashboard call site was a TS2339. These checks read the real sources, so a member added
 * to one side without the other fails here instead of in the typecheck of some caller.
 *
 * main.js and preload.js cannot be loaded without the Electron binary, so they are read as text.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { PRIVILEGED_IPC_CHANNELS } = require("../../electron/lib/ipcOriginGuard");

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const preload = read("electron/preload.js");
const types = read("electron/types.d.ts");
const mainJs = read("electron/main.js");
const loginManager = read("electron/loginManager.js");

/** Text from `startMarker` up to the first line that is exactly `endLine`. */
function block(source: string, startMarker: string, endLine: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source
    .slice(start)
    .search(new RegExp(`\\r?\\n${endLine.replace(/[()[\]{}.*+?^$|\\]/g, "\\$&")}\\r?\\n`));
  assert.notEqual(end, -1, `end of block not found after: ${startMarker}`);
  return source.slice(start, start + end);
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

// preload.js: `  name: (…) => safeInvoke("channel", …),` inside exposeInMainWorld("electronAPI", {…})
const bridge = block(preload, 'contextBridge.exposeInMainWorld("electronAPI", {', "});");
const exposedMembers = sorted([...bridge.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]));
const invokeChannelByMember = new Map(
  [...bridge.matchAll(/^ {2}(\w+):.*?safeInvoke\("([^"]+)"/gm)].map((m) => [m[1], m[2]])
);

// types.d.ts: members of `export interface ElectronAPI {…}`, each up to the `;` that ends its
// line (Prettier wraps long signatures), whitespace collapsed so wrapping does not matter.
const apiInterface = block(types, "export interface ElectronAPI {", "}");
const declaredSignatures = new Map(
  [...apiInterface.matchAll(/^ {2}(\w+)\??[(:][\s\S]*?;\s*$/gm)].map((m) => [
    m[1],
    m[0].replace(/\s+/g, " ").trim(),
  ])
);

describe("ElectronAPI declares exactly what preload.js exposes", () => {
  it("found a non-trivial bridge and interface (parser sanity)", () => {
    assert.ok(exposedMembers.length >= 20, `bridge members: ${exposedMembers.join(", ")}`);
    assert.ok(invokeChannelByMember.size >= 12, "invoke members");
  });

  it("has the same member names on both sides", () => {
    assert.deepEqual(sorted(declaredSignatures.keys()), exposedMembers);
  });

  it("types every listener as returning a disposer", () => {
    for (const member of exposedMembers.filter((name) => /^on[A-Z]/.test(name))) {
      assert.match(declaredSignatures.get(member) ?? "", /\): \(\) => void;$/, member);
    }
  });
});

describe("privileged invoke members declare the withPrivilegedSender denial", () => {
  // Declared before the denial shape was typed; their callers still assume the success value.
  // Finding F-8 (audit/AUTONOMOUS_MISSION_STATE.md) fixes those callers and empties this set.
  const DENIAL_NOT_YET_DECLARED = new Set(["openExternal", "getDataDir", "restartServer"]);

  for (const [member, channel] of invokeChannelByMember) {
    const privileged = (PRIVILEGED_IPC_CHANNELS as readonly string[]).includes(channel);
    if (privileged && DENIAL_NOT_YET_DECLARED.has(member)) continue;
    it(`${member} (${channel}) ${privileged ? "can" : "cannot"} resolve to IpcFailure`, () => {
      const signature = declaredSignatures.get(member) ?? "";
      if (privileged) assert.match(signature, /\bIpcFailure\b/, signature);
      else assert.doesNotMatch(signature, /\bIpcFailure\b/, signature);
    });
  }

  it("the not-yet-declared set only names privileged invoke members", () => {
    for (const member of DENIAL_NOT_YET_DECLARED) {
      const channel = invokeChannelByMember.get(member);
      assert.ok(
        channel && (PRIVILEGED_IPC_CHANNELS as readonly string[]).includes(channel),
        member
      );
    }
  });
});

describe("event payload types match what the main process sends", () => {
  it("UpdateStatus lists every update-status sent by main.js", () => {
    const sent = [
      ...mainJs.matchAll(/sendToRenderer\("update-status",\s*\{\s*status: "([a-z-]+)"/g),
    ];
    const declared = [
      ...block(types, "export type UpdateStatus =", "").matchAll(/status: "([a-z-]+)"/g),
    ];
    assert.ok(sent.length >= 6, "update-status sends found in main.js");
    assert.deepEqual(sorted(declared.map((m) => m[1])), sorted(sent.map((m) => m[1])));
  });

  it("LoginStatus lists every login status emitted by loginManager.js and main.js", () => {
    const emitted = [
      ...loginManager.matchAll(/emit\("status",\s*\{\s*providerId[^,]*,\s*status: "([a-z]+)"/g),
      ...mainJs.matchAll(
        /sendToRenderer\("login:status",\s*\{\s*providerId[^,]*,\s*status: "([a-z]+)"/g
      ),
    ];
    const statusUnion = block(types, "export interface LoginStatus {", "}").match(
      /status:([\s\S]*?);/
    );
    assert.ok(statusUnion, "LoginStatus.status union");
    const declared = [...statusUnion[1].matchAll(/"([a-z]+)"/g)];
    assert.ok(emitted.length >= 8, "login status emits found");
    assert.deepEqual(sorted(declared.map((m) => m[1])), sorted(emitted.map((m) => m[1])));
  });
});
