// @vitest-environment jsdom
/**
 * A failed load must not render as "you have no workspaces".
 *
 * `reloadList` caught, fired an error toast, and left `workspaces` at `[]` — so the page
 * fell into its friendly empty state: **"No workspaces yet — Create a workspace to group
 * API keys."** Error toasts auto-dismiss after 8 seconds (`notificationStore.ts`), and
 * what remained on screen was a confident, wrong statement about the user's account.
 *
 * "We could not reach the server" and "you have none" are different facts. The product
 * audit found this one; the same shape recurs wherever a catch leaves a collection empty.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { WorkspacesPageClient } from "@/app/(dashboard)/dashboard/costs/workspaces/WorkspacesPageClient";

const EMPTY_TITLE = "No workspaces yet";
const LOAD_ERROR = "Could not load workspaces.";

let container: HTMLDivElement;
let root: Root;

/** Fetch that fails the list endpoints, as an unreachable server would. */
function failingFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/workspaces") || url.startsWith("/api/keys")) {
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

/** Fetch that succeeds and genuinely returns nothing. */
function emptyFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/workspaces")
      return { ok: true, status: 200, json: async () => ({ workspaces: [] }) } as Response;
    if (url === "/api/keys")
      return { ok: true, status: 200, json: async () => ({ keys: [] }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  root = createRoot(container);
  await act(async () => {
    root.render(<WorkspacesPageClient />);
  });
  // Let the effect's promises settle so the page leaves its loading state.
  await act(async () => {
    await Promise.resolve();
  });
}

test("a failed load says so, and does not claim the account is empty", async () => {
  vi.stubGlobal("fetch", failingFetch());

  await render();

  expect(container.textContent).toContain(LOAD_ERROR);
  expect(
    container.textContent,
    "after the toast auto-dismisses this is all that is left on screen"
  ).not.toContain(EMPTY_TITLE);
});

test("a genuinely empty account still gets the friendly empty state", async () => {
  vi.stubGlobal("fetch", emptyFetch());

  await render();

  expect(container.textContent).toContain(EMPTY_TITLE);
  expect(container.textContent).not.toContain(LOAD_ERROR);
});

test("the failed state offers a retry", async () => {
  vi.stubGlobal("fetch", failingFetch());

  await render();

  const retry = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Retry")
  );
  expect(
    retry,
    "a dead end with no way forward is not much better than a wrong message"
  ).toBeTruthy();
});
