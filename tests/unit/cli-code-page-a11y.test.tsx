// @vitest-environment jsdom
/**
 * Accessibility of /dashboard/cli-code (axe-core, jsdom).
 *
 * The 3.8.55 audit drove the shipped production build and found this page carrying
 * two axe-**critical** `select-name` nodes and two **serious** `color-contrast` nodes,
 * in both themes and at every width it measured. The filter selects had no accessible
 * name at all — no `id`, no `aria-label`, and the two visible `<label>`s had no
 * `htmlFor` — so a screen reader announced two unnamed combo boxes both saying "All".
 *
 * Nothing caught it because `tests/e2e/a11y.spec.ts` audited seven paths and this was
 * not one of them. That gate now includes this page; this test is the fast half, so a
 * regression fails in the unit suite rather than waiting for the nightly axe job.
 *
 * jsdom has no layout, so contrast is reported as "incomplete" here, not as a
 * violation — the contrast half is covered by the e2e sweep.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import axe from "axe-core";

import CliCodePageClient from "@/app/(dashboard)/dashboard/cli-code/CliCodePageClient";

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
      // No active provider: the state that renders the amber banner the audit measured
      // at 2.92:1 — the one line a first-run user most needs to read.
      if (url.startsWith("/api/providers")) return jsonResponse({ connections: [] });
      if (url.startsWith("/api/cli-tools")) return jsonResponse({ statuses: {} });
      return jsonResponse({});
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

test("the cli-code page reports zero axe violations", async () => {
  root = createRoot(container);
  await act(async () => {
    root.render(<CliCodePageClient />);
  });

  const results = await axe.run(container, { resultTypes: ["violations"] });

  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(" ")),
    }))
  ).toEqual([]);
});

test("every filter select has an accessible name", async () => {
  root = createRoot(container);
  await act(async () => {
    root.render(<CliCodePageClient />);
  });

  const selects = [...container.querySelectorAll("select")];
  expect(selects.length).toBeGreaterThan(0);

  for (const select of selects) {
    const labelled =
      Boolean(select.getAttribute("aria-label")) ||
      Boolean(select.getAttribute("aria-labelledby")) ||
      Boolean(select.closest("label")) ||
      (Boolean(select.id) && Boolean(container.querySelector(`label[for="${select.id}"]`)));

    expect(
      labelled,
      `a <select> with no accessible name is announced by its first option — here, "All"`
    ).toBe(true);
  }
}, 30_000);
