// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const intl = vi.hoisted(() => ({
  locale: "en",
  messages: {} as Record<string, string>,
}));

vi.mock("next-intl", () => ({
  useLocale: () => intl.locale,
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      (intl.messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
        String(values?.[name] ?? "")
      );
    return Object.assign(t, { has: (key: string) => key in intl.messages });
  },
}));

import RoutingDecisionLookup from "../../../src/app/(dashboard)/dashboard/analytics/RoutingDecisionLookup";
import ptBR from "../../../src/i18n/messages/pt-BR.json";

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
  intl.locale = "en";
  intl.messages = {};
});

async function lookUp(value = "req-ui-1") {
  fireEvent.change(screen.getByLabelText(/Request id or decision id|ID da requisição/i), {
    target: { value },
  });
  fireEvent.click(screen.getByRole("button", { name: /look up|consultar|buscar/i }));
}

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

  it("renders badges, enums and the timestamp in the active locale", async () => {
    intl.locale = "pt-BR";
    intl.messages = (ptBR as { analytics: Record<string, string> }).analytics;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ decision }))
    );
    render(<RoutingDecisionLookup />);
    await lookUp();

    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    for (const english of ["selected", "eligible", "excluded", "live", "deterministic"]) {
      expect(screen.queryByText(english)).toBeNull();
    }
    expect(screen.getByText("selecionado")).toBeTruthy();
    expect(screen.getByText("excluído")).toBeTruthy();
    expect(screen.getByText("circuito aberto")).toBeTruthy();
    expect(screen.getByText("ao vivo")).toBeTruthy();
    const time = document.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe(decision.generatedAt);
    expect(time?.textContent).not.toBe(decision.generatedAt);
  });

  it("announces a found decision and moves focus to it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ decision }))
    );
    render(<RoutingDecisionLookup />);
    await lookUp();

    await waitFor(() =>
      expect(screen.getByText("Decision found: alpha/alpha-model was chosen.")).toBeTruthy()
    );
    const results = screen.getByLabelText("Routing decision details");
    expect(document.activeElement).toBe(results);
  });

  for (const status of [401, 403]) {
    it(`tells the user to sign in again on ${status}`, async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error: "x" }, { status }))
      );
      render(<RoutingDecisionLookup />);
      await lookUp();

      await waitFor(() => expect(screen.getByText(/Sign in again/)).toBeTruthy());
      expect(screen.queryByText(/Try again/)).toBeNull();
      expect(screen.queryByRole("table")).toBeNull();
    });
  }

  it("keeps the generic retry message for server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "x" }, { status: 500 }))
    );
    render(<RoutingDecisionLookup />);
    await lookUp();

    await waitFor(() => expect(screen.getByText(/Try again/)).toBeTruthy());
  });

  it("says how many candidates a compact decision left out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ decision: { ...decision, omittedCandidates: 260 } }))
    );
    render(<RoutingDecisionLookup />);

    fireEvent.change(screen.getByLabelText("Request id or decision id"), {
      target: { value: "req-ui-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
    expect(screen.getByText("260 lower-ranked candidates are not listed.")).toBeTruthy();
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
