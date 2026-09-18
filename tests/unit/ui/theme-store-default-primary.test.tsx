// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

const { default: useThemeStore } = await import("@/store/themeStore");

const root = () => document.documentElement;
const inlinePrimary = () => root().style.getPropertyValue("--color-primary");
const inlineHover = () => root().style.getPropertyValue("--color-primary-hover");

afterEach(() => {
  root().style.removeProperty("--color-primary");
  root().style.removeProperty("--color-primary-hover");
});

describe("themeStore primary color", () => {
  it("leaves the default coral preset to the theme-aware CSS tokens (no inline override)", () => {
    root().style.setProperty("--color-primary", "#e54d5e");
    root().style.setProperty("--color-primary-hover", "#c93d4e");

    useThemeStore.getState().setColorTheme("coral");

    expect(inlinePrimary()).toBe("");
    expect(inlineHover()).toBe("");
  });

  it("still applies a non-default preset inline, with a derived hover shade", () => {
    useThemeStore.getState().setColorTheme("blue");

    expect(inlinePrimary()).toBe("#3b82f6");
    expect(inlineHover()).not.toBe("");
    expect(inlineHover()).not.toBe("#3b82f6");
  });

  it("still applies a custom color inline", () => {
    useThemeStore.getState().setCustomColorTheme("#123456");

    expect(inlinePrimary()).toBe("#123456");
  });

  it("clears a previous preset override when switching back to the default", () => {
    useThemeStore.getState().setColorTheme("green");
    expect(inlinePrimary()).toBe("#22c55e");

    useThemeStore.getState().setColorTheme("coral");

    expect(inlinePrimary()).toBe("");
  });

  it("treats an unknown preset id like the default preset", () => {
    useThemeStore.getState().setColorTheme("not-a-preset");

    expect(inlinePrimary()).toBe("");
  });

  it("initTheme removes a stale inline coral persisted by the previous behavior", () => {
    useThemeStore.setState({ colorTheme: "coral" });
    root().style.setProperty("--color-primary", "#e54d5e");

    useThemeStore.getState().initTheme();

    expect(inlinePrimary()).toBe("");
  });
});
