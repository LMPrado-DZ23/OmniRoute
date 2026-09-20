/**
 * The cli-code cards must honour `OMNIROUTE_BASE_PATH`.
 *
 * `ToolDetailClient` resolved the base URL it hands to all 27 cards with
 * `window.location.origin`, which drops the subpath. On a reverse-proxy deploy under
 * `/omniroute`, every card printed `https://host/v1` instead of
 * `https://host/omniroute/v1` — the wrong-base-URL failure #57 and #60 exist to prevent,
 * on the page whose entire job is telling people what to paste.
 *
 * Every other surface that shows a base URL already used `useDisplayBaseUrl`, whose own
 * docstring says the subpath "keeps /v1 examples correct under reverse-proxy subpaths
 * (OMNIROUTE_BASE_PATH)". This one was the exception, so the test pins the rule rather
 * than one call site: no base-URL surface resolves the origin by hand.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DETAIL = path.join(
  ROOT,
  "src",
  "app",
  "(dashboard)",
  "dashboard",
  "cli-code",
  "components",
  "ToolDetailClient.tsx"
);

test("the detail page resolves its base URL through the shared hook", () => {
  const source = fs.readFileSync(DETAIL, "utf8");

  assert.match(
    source,
    /import \{ useDisplayBaseUrl \} from "@\/shared\/hooks\/useDisplayBaseUrl";/,
    "the hook is what applies OMNIROUTE_BASE_PATH and refuses a non-public origin"
  );
  assert.match(source, /const displayBaseUrl = useDisplayBaseUrl\(\);/);
});

test("it no longer reads window.location.origin as the base URL", () => {
  const source = fs.readFileSync(DETAIL, "utf8");
  const offending = source
    .split("\n")
    .filter(
      (line) => line.includes("window.location.origin") && !line.trimStart().startsWith("//")
    );

  assert.deepEqual(
    offending,
    [],
    "window.location.origin drops the subpath, which is the whole defect:\n" + offending.join("\n")
  );
});

test("the hook still resolves a subpath, so the fix has something to stand on", async () => {
  const { resolveDisplayBaseUrl } = await import("../../src/shared/hooks/useDisplayBaseUrl.ts");

  assert.equal(
    resolveDisplayBaseUrl(
      undefined,
      "https://llms.example.com",
      "/omniroute/dashboard",
      "/omniroute"
    ),
    "https://llms.example.com/omniroute",
    "a subpath deploy must keep its prefix in the printed base URL"
  );
  assert.equal(
    resolveDisplayBaseUrl(undefined, "https://llms.example.com", "/dashboard", undefined),
    "https://llms.example.com",
    "and a root deploy must not grow one"
  );
});
