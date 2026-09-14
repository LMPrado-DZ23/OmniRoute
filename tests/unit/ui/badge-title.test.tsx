// @vitest-environment jsdom
/**
 * Badge did not accept a `title`, so tooltips passed to it (for example the memory type
 * explanations in the Memories tab) were silently dropped. The title must reach the rendered
 * element, and a badge without one must not get an empty attribute.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import Badge from "../../../src/shared/components/Badge";

let container: HTMLDivElement;
let root: Root;

describe("Badge title", () => {
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

  it("renders the title as a tooltip attribute", async () => {
    await act(async () => {
      root.render(<Badge title="Long-lived facts about the user">fact</Badge>);
    });

    const badge = container.firstElementChild as HTMLElement;
    expect(badge.getAttribute("title")).toBe("Long-lived facts about the user");
    expect(badge.textContent).toBe("fact");
  });

  it("renders no title attribute when none is given", async () => {
    await act(async () => {
      root.render(<Badge>plain</Badge>);
    });

    expect((container.firstElementChild as HTMLElement).hasAttribute("title")).toBe(false);
  });
});
