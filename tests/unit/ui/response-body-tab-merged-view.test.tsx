// @vitest-environment jsdom
/**
 * The traffic inspector's Response tab merges streamed (SSE) bodies with mergeStream. It rendered
 * `merged.text` and `merged.toolCalls`, which MergedResponse never had ({ format, message?, raw? }),
 * so the default merged view of every streamed response was an empty box. The merged message must
 * be shown, and a stream the merger cannot rebuild must fall back to its raw events.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResponseBodyTab } from "../../../src/app/(dashboard)/dashboard/tools/traffic-inspector/components/tabs/ResponseBodyTab";
import type { InterceptedRequest } from "../../../src/mitm/inspector/types";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

let container: HTMLDivElement;
let root: Root;

function requestWithBody(responseBody: string): InterceptedRequest {
  return {
    id: "req-1",
    source: "proxy",
    timestamp: "2026-09-13T00:00:00.000Z",
    method: "POST",
    host: "api.example.test",
    path: "/v1/chat/completions",
    requestHeaders: {},
    requestBody: null,
    requestSize: 0,
    responseHeaders: {},
    responseBody,
    responseSize: responseBody.length,
    status: 200,
  } as InterceptedRequest;
}

async function renderTab(body: string) {
  await act(async () => {
    root.render(<ResponseBodyTab request={requestWithBody(body)} />);
  });
}

describe("ResponseBodyTab merged view", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("shows the merged message of an OpenAI stream", async () => {
    await renderTab(
      'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n' +
        'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n"
    );

    const merged = container.querySelector(".space-y-2");
    expect(merged).not.toBeNull();
    expect(merged?.textContent ?? "").toContain("choices");
  });

  it("falls back to the raw events when the stream format is unknown", async () => {
    await renderTab('data: {"custom":"payload-value"}\n\n');

    expect(container.textContent ?? "").toContain("payload-value");
  });
});
