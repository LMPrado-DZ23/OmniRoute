// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string) => key;
    return Object.assign(t, { has: () => false });
  },
}));

import RoutingDecisionLookup from "../../../src/app/(dashboard)/dashboard/analytics/RoutingDecisionLookup";

const decision = {
  decisionId: "rd_11111111-2222-3333-4444-555555555555",
  requestId: "req-ui-1",
  policyVersion: "rp_0123456789abcdef",
  generatedAt: "2026-09-14T12:00:00.000Z",
  liveRequestExecuted: true,
  strategy: "rules",
  selectionMode: "deterministic",
  selected: {
    providerId: "alpha",
    modelId: "alpha-model",
    score: 0.91,
    factors: [],
    eligible: true,
    exclusionReasons: [],
    quota: "available",
    circuit: "closed",
    estimatedCostUsd: 0.001,
    estimatedLatencyMs: 200,
  },
  candidates: [
    {
      providerId: "alpha",
      modelId: "alpha-model",
      score: 0.91,
      factors: [],
      eligible: true,
      exclusionReasons: [],
      quota: "available",
      circuit: "closed",
      estimatedCostUsd: 0.001,
      estimatedLatencyMs: 200,
    },
    {
      providerId: "beta",
      modelId: "beta-model",
      score: 0,
      factors: [],
      eligible: false,
      exclusionReasons: ["circuit_open"],
      quota: "unknown",
      circuit: "open",
      estimatedCostUsd: null,
      estimatedLatencyMs: null,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RoutingDecisionLookup", () => {
  it("looks up a decision by id and shows candidates with exclusion reasons", async () => {
    const fetchMock = vi.fn(async () => Response.json({ decision }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RoutingDecisionLookup />);

    const input = screen.getByLabelText("Request id or decision id");
    fireEvent.change(input, { target: { value: " req-ui-1 " } });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() =>
      expect(screen.getByText("rp_0123456789abcdef", { exact: false })).toBeTruthy()
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/omniroute/route/decisions/req-ui-1", {
      cache: "no-store",
    });
    expect(screen.getByText("circuit_open")).toBeTruthy();
    expect(screen.getByText("Selected: alpha/alpha-model", { exact: false })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("announces a not-found id without showing stale details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "x" }, { status: 404 }))
    );
    render(<RoutingDecisionLookup />);

    fireEvent.change(screen.getByLabelText("Request id or decision id"), {
      target: { value: "missing" },
    });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(screen.getByText(/No decision with that id/)).toBeTruthy());
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("keeps the lookup button disabled until an id is typed", () => {
    render(<RoutingDecisionLookup />);
    const button = screen.getByRole("button", { name: /look up/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
