import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// The Workspaces page used to print the server's English `message` for every refusal, in
// every language. The API already answered with a machine-readable `code` on some of them;
// this maps every code to a message key and keeps the English message as the fallback.
const { WORKSPACE_ERROR_CODES, workspaceErrorMessage } =
  await import("../../../src/app/(dashboard)/dashboard/costs/workspaces/useWorkspaces");
const { WorkspaceApiError } =
  await import("../../../src/app/(dashboard)/dashboard/costs/workspaces/workspaceApi");

const codes = WORKSPACE_ERROR_CODES as readonly string[];
const describe = workspaceErrorMessage as (
  error: unknown,
  translateCode: (code: string) => string
) => string;
const ApiError = WorkspaceApiError as new (
  message: string,
  code: string | undefined,
  status: number
) => Error;

const translate = (code: string) => `translated:${code}`;

test("a known code is translated, never shown as the server's English message", () => {
  for (const code of codes) {
    const error = new ApiError("A workspace with this name already exists", code, 409);
    assert.equal(describe(error, translate), `translated:${code}`);
  }
});

test("an UNKNOWN code falls back to the server message instead of a blank toast", () => {
  // A refusal added on the server before the dashboard learns about it must still say
  // something. Untranslated is acceptable; empty is not.
  const error = new ApiError("Quota exhausted for this workspace", "quota_exhausted", 429);
  assert.equal(describe(error, translate), "Quota exhausted for this workspace");
});

test("a plain Error (network down, thrown by fetch) keeps its own message", () => {
  assert.equal(describe(new Error("Failed to fetch"), translate), "Failed to fetch");
});

test("a non-Error throw is still rendered as something", () => {
  assert.equal(describe("boom", translate), "boom");
});

test("every code the API can answer with is in the list the UI translates", () => {
  // The list is only useful if it matches what the server actually emits. Read the codes
  // out of the handlers rather than trusting the two to stay in step by hand.
  const sources = [
    "src/lib/workspaces/http.ts",
    "src/lib/workspaces/access.ts",
    "src/lib/workspaces/memberHandlers.ts",
    "src/lib/workspaces/projectHandlers.ts",
    "src/lib/workspaces/workspaceHandlers.ts",
  ];
  const emitted = new Set<string>();
  for (const file of sources) {
    const src = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
    // `{ message, code: "x" }` in the shared not-found bodies
    for (const m of src.matchAll(/code:\s*"([a-z_]+)"/g)) emitted.add(m[1]);
    // The last argument of errorJson(status, message, code) / forbidden(message, code).
    // Read to the MATCHING close paren by counting depth rather than to the next `);`:
    // one call ends in `)` on a ternary arm, and a regex that scans past it swallows the
    // `"read"` / `"write"` of the next `authorized(...)` and invents codes that do not exist.
    for (const call of src.matchAll(/(?:errorJson|forbidden)\(/g)) {
      let depth = 1;
      let i = (call.index ?? 0) + call[0].length;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
      }
      const args = [
        ...src.slice((call.index ?? 0) + call[0].length, i - 1).matchAll(/"([a-z_]+)"/g),
      ];
      if (args.length > 0) emitted.add(args[args.length - 1][1]);
    }
  }
  const missing = [...emitted].filter((c) => !codes.includes(c));
  assert.deepEqual(missing, [], `codes the server emits but the UI cannot translate: ${missing}`);
});

test("every locale carries a message for every code", () => {
  // next-intl throws on a missing key, so a locale without these would turn a refusal into
  // a crashed toast in that language only — exactly the kind of gap that ships unnoticed.
  const dir = new URL("../../../src/i18n/messages/", import.meta.url);
  const locales = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(locales.length >= 40, `expected the full locale set, got ${locales.length}`);
  for (const file of locales) {
    const messages = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as {
      workspaces?: { errors?: Record<string, string> };
    };
    const errors = messages.workspaces?.errors ?? {};
    for (const code of codes) {
      assert.equal(typeof errors[code], "string", `${file} is missing workspaces.errors.${code}`);
      assert.ok(errors[code].trim().length > 0, `${file}: workspaces.errors.${code} is empty`);
    }
  }
});
