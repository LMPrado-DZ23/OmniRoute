/**
 * Audit C L9 — one "Skip to content" link, and a target on every page that shows it.
 *
 * The root layout renders the skip link on every page; the dashboard Sidebar rendered a
 * second copy (keyboard users passed it twice), and /login had no `#main-content`, so the
 * link went nowhere. The e2e keyboard spec checks the behaviour in a browser; this guard
 * keeps the static structure from regressing in the unit run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("skip link", () => {
  it("is rendered once, by the root layout", () => {
    assert.equal(count(read("src/app/layout.tsx"), 'href="#main-content"'), 1);
    assert.equal(count(read("src/shared/components/Sidebar.tsx"), 'href="#main-content"'), 0);
  });

  it("targets a focusable <main> in the dashboard layout", () => {
    const layout = read("src/shared/components/layouts/DashboardLayout.tsx");
    assert.match(layout, /<main\s+id="main-content"\s+tabIndex=\{-1\}/);
  });

  it("targets a focusable <main> in every /login render branch", () => {
    const login = read("src/app/login/page.tsx");
    const mains = login.match(/<main\s+id="main-content"\s+tabIndex=\{-1\}/g) ?? [];
    // probe-failed (NEW-MEDIUM-3), loading, bootstrap/welcome, second-state and the
    // sign-in form branches. Every JSX-returning branch in the page must render the
    // target, so the count is tied to the number of `return (` statements rather than
    // pinned to a literal — a new branch without a skip target fails here.
    // `[ ]` (not \s) and the optional \r keep this identical under LF and CRLF.
    const branches = login.match(/^[ ]{2,4}return \(\r?$/gm) ?? [];
    assert.equal(branches.length, 5);
    assert.equal(mains.length, branches.length);
    assert.doesNotMatch(login, /<div className="min-h-screen/);
  });
});
