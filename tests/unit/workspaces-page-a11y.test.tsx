// @vitest-environment jsdom
/**
 * Accessibility of /dashboard/costs/workspaces (axe-core, jsdom).
 *
 * The page is rendered with a workspace, a project, assigned and unassigned API keys — the
 * state with every control on screen — and must report ZERO axe violations. jsdom has no
 * layout, so axe reports colour-contrast as "incomplete" rather than a violation; the page
 * only uses shared components whose contrast is already gated by tests/e2e/a11y.spec.ts.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// axe over a whole page routinely takes more than the 5 s default on a hosted runner (the run-36230905592
// failure is a bare "Test timed out in 5000ms"), which says nothing about the page.
vi.setConfig({ testTimeout: 30_000 });
import axe from "axe-core";

import { WorkspacesPageClient } from "@/app/(dashboard)/dashboard/costs/workspaces/WorkspacesPageClient";

const WORKSPACE = {
  id: "ws-1",
  name: "Research",
  budget: { limitUsd: 100, interval: "monthly", warningThreshold: 0.8 },
  spend: { decision: "warn", spendUsd: 85, limitUsd: 100 },
};

const PROJECT = {
  id: "pr-1",
  workspaceId: "ws-1",
  name: "Chatbot",
  budget: { limitUsd: 40, interval: "monthly", warningThreshold: 0.8 },
  apiKeyIds: ["key-1"],
  spend: { decision: "allow", spendUsd: 3, limitUsd: 40 },
};

const KEYS = [
  { id: "key-1", name: "Chatbot key", projectId: "pr-1" },
  { id: "key-2", name: "Spare key", projectId: null },
  { id: "key-3", name: "Other workspace key", projectId: "pr-9" },
];

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/workspaces") return jsonResponse({ workspaces: [WORKSPACE] });
      if (url === "/api/keys") return jsonResponse({ keys: KEYS });
      if (url === "/api/workspaces/ws-1")
        return jsonResponse({ workspace: WORKSPACE, role: "owner", projects: [PROJECT] });
      throw new Error(`unexpected fetch in a jsdom test: ${url}`);
    })
  );
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("the workspaces page reports zero axe violations with a workspace selected", async () => {
  root = createRoot(container);
  await act(async () => {
    root.render(<WorkspacesPageClient />);
  });
  const select = container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]');
  expect(select).not.toBeNull();
  await act(async () => {
    select?.click();
  });
  expect(container.textContent).toContain("Chatbot");
  expect(container.textContent).toContain("API keys in this project");

  const results = await axe.run(container, { resultTypes: ["violations"] });
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(" ")),
    }))
  ).toEqual([]);
});
