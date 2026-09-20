// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

const {
  default: useThemeStore,
  COLOR_THEMES,
  ON_PRIMARY_DARK,
  ON_PRIMARY_LIGHT,
  pickOnPrimary,
} = await import("@/store/themeStore");
const { getContrastRatio } = await import("@/shared/utils/a11yAudit");

const root = () => document.documentElement;
const inlinePrimary = () => root().style.getPropertyValue("--color-primary");
const inlineHover = () => root().style.getPropertyValue("--color-primary-hover");
const inlineOnPrimary = () => root().style.getPropertyValue("--color-on-primary");
const inlineOnTint = (theme: "light" | "dark") =>
  root().style.getPropertyValue(`--preset-primary-on-tint-${theme}`);

// Surfaces the dashboard paints primary tints on, per theme (mirrors globals.css), and the
// tint strengths in use. Recomputed here so the test does not reuse the store's own table.
const TINT_SURFACES = {
  light: ["#f9f9fb", "#f5f5fa", "#ffffff", "#f0f0f5"],
  dark: ["#0b0e14", "#10141e", "#161b22", "#111520"],
} as const;

function tintOver(primary: string, surface: string, alpha: number) {
  const channels = (hex: string) =>
    [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const [pr, pg, pb] = channels(primary);
  const [sr, sg, sb] = channels(surface);
  const mix = (p: number, sc: number) =>
    Math.round(p * alpha + sc * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(pr, sr)}${mix(pg, sg)}${mix(pb, sb)}`;
}

function worstTintContrast(onTint: string, primary: string, theme: "light" | "dark") {
  let worst = Number.POSITIVE_INFINITY;
  for (const surface of TINT_SURFACES[theme]) {
    for (const alpha of [0.1, 0.15, 0.22]) {
      worst = Math.min(worst, getContrastRatio(onTint, tintOver(primary, surface, alpha)));
    }
  }
  return worst;
}

afterEach(() => {
  root().style.removeProperty("--color-primary");
  root().style.removeProperty("--color-primary-hover");
  root().style.removeProperty("--color-on-primary");
  root().style.removeProperty("--preset-primary-on-tint-light");
  root().style.removeProperty("--preset-primary-on-tint-dark");
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

  it("leaves the text-on-primary colour of the default preset to the theme-aware tokens", () => {
    useThemeStore.getState().setColorTheme("blue");
    expect(inlineOnPrimary()).not.toBe("");

    useThemeStore.getState().setColorTheme("coral");

    expect(inlineOnPrimary()).toBe("");
  });

  it("keeps white text on a preset where white already meets AA", () => {
    useThemeStore.getState().setCustomColorTheme("#123456");

    expect(inlineOnPrimary()).toBe(ON_PRIMARY_LIGHT);
  });

  it("switches to black text on a preset where white falls under AA (custom green)", () => {
    // #ffffff on #22c55e is 2.27:1 — the failure measured on /dashboard/logs.
    useThemeStore.getState().setCustomColorTheme("#22c55e");

    expect(inlineOnPrimary()).toBe(ON_PRIMARY_DARK);
    expect(getContrastRatio(inlineOnPrimary(), inlinePrimary())).toBeGreaterThanOrEqual(4.5);
    // The hover shade moves away from black text, so it never loses contrast.
    expect(getContrastRatio(inlineOnPrimary(), inlineHover())).toBeGreaterThanOrEqual(
      getContrastRatio(inlineOnPrimary(), inlinePrimary())
    );
  });

  it("meets AA for text on every built-in preset, at rest and on hover", () => {
    for (const id of Object.keys(COLOR_THEMES).filter((key) => key !== "coral")) {
      useThemeStore.getState().setColorTheme(id);
      const onPrimary = inlineOnPrimary();
      expect(getContrastRatio(onPrimary, inlinePrimary()), `${id} at rest`).toBeGreaterThanOrEqual(
        4.5
      );
      expect(getContrastRatio(onPrimary, inlineHover()), `${id} on hover`).toBeGreaterThanOrEqual(
        4.5
      );
    }
  });

  it("finds an AA text colour for any custom colour (sweep across the sRGB cube)", () => {
    const steps = [0, 51, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255];
    const toHex = (channel: number) => channel.toString(16).padStart(2, "0");
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const color = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
          expect(getContrastRatio(pickOnPrimary(color), color), color).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("derives an AA brand text colour for tints of a custom colour, in both themes", () => {
    // #22c55e through the coral-tuned 80%-black mix measured 2.95:1 on the light sidebar tint.
    useThemeStore.getState().setCustomColorTheme("#22c55e");

    for (const theme of ["light", "dark"] as const) {
      expect(
        worstTintContrast(inlineOnTint(theme), inlinePrimary(), theme),
        `${theme} tint`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("derives AA tint text for every built-in preset, in both themes", () => {
    for (const id of Object.keys(COLOR_THEMES).filter((key) => key !== "coral")) {
      useThemeStore.getState().setColorTheme(id);
      for (const theme of ["light", "dark"] as const) {
        expect(
          worstTintContrast(inlineOnTint(theme), inlinePrimary(), theme),
          `${id} ${theme} tint`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("leaves the tint text of the default preset to the theme-aware CSS tokens", () => {
    useThemeStore.getState().setColorTheme("violet");
    expect(inlineOnTint("light")).not.toBe("");

    useThemeStore.getState().setColorTheme("coral");

    expect(inlineOnTint("light")).toBe("");
    expect(inlineOnTint("dark")).toBe("");
  });

  it("initTheme removes a stale inline coral persisted by the previous behavior", () => {
    useThemeStore.setState({ colorTheme: "coral" });
    root().style.setProperty("--color-primary", "#e54d5e");

    useThemeStore.getState().initTheme();

    expect(inlinePrimary()).toBe("");
  });
});
