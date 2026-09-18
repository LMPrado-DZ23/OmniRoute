// @vitest-environment jsdom
// Audit C M3: on the analytics Route Trace tab the "Request log" <label> was not
// associated with its <select>, so axe reported `select-name` (critical) and screen
// readers announced an unnamed combobox. The select must be named by that label.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import RouteExplainabilityTab from "@/app/(dashboard)/dashboard/analytics/RouteExplainabilityTab";

function jsonResponse(data: unknown, ok = true) {
  return new Response(JSON.stringify(data), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL) {
  return typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const p = requestPath(input);
      if (p.startsWith("/api/usage/call-logs")) {
        return jsonResponse([
          {
            id: "req-1",
            timestamp: "2026-09-18T10:00:00.000Z",
            status: 200,
            model: "gpt-4o-mini",
            requestedModel: "gpt-4o-mini",
            provider: "openai",
            comboName: null,
            duration: 120,
          },
        ]);
      }
      return jsonResponse({ error: "not in this test" }, false);
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Route Trace tab — request log select", () => {
  it("is named by its visible 'Request log' label", async () => {
    render(<RouteExplainabilityTab />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const select = screen.getByRole("combobox", { name: /request log/i });
    expect(select.tagName).toBe("SELECT");
    const label = document.querySelector(`label[for="${select.id}"]`);
    expect(label?.textContent?.trim()).toMatch(/request log/i);
  });
});
