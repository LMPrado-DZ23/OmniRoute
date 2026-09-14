/**
 * The quota analytics and reset timer modules log failures with the shared pino logger. They called
 * `log.error("message", error)`. Pino treats extra arguments as printf-style values for the message,
 * so with no placeholder the error was silently dropped: failures were logged without their cause.
 * The error must be passed as the merging object, `log.error({ err: error }, "message")`, which pino
 * serializes with its error serializer.
 *
 * Static source assertions, in the style of other logging and sanitization guards in this suite.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const CASES = [
  {
    file: "src/lib/quota/quotaAnalytics.ts",
    messages: ["Failed to compute quota analytics summary"],
  },
  {
    file: "src/lib/quota/quotaResetTimers.ts",
    messages: ["Failed to query active quota reset items", "Failed to reset expired quota windows"],
  },
];

for (const { file, messages } of CASES) {
  test(`${file} passes caught errors to pino as { err }`, () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const message of messages) {
      assert.ok(
        src.includes(`log.error({ err: error }, "${message}")`),
        `"${message}" must be logged as log.error({ err: error }, message)`
      );
      assert.ok(
        !src.includes(`log.error("${message}", error)`),
        `"${message}" must not pass the error as a dropped printf argument`
      );
    }
  });
}
