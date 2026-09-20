"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/appConfig";
import { getContrastRatio } from "@/shared/utils/a11yAudit";

interface ThemeState {
  theme: string;
  colorTheme: string;
  customColor: string;
  setTheme: (theme: string) => void;
  setColorTheme: (colorTheme: string) => void;
  setCustomColorTheme: (color: string) => void;
  toggleTheme: () => void;
  initTheme: () => void;
}

const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,
      colorTheme: "coral",
      customColor: "#3b82f6",

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },

      setColorTheme: (colorTheme) => {
        set({ colorTheme });
        applyColorTheme(colorTheme, get().customColor);
      },

      setCustomColorTheme: (color) => {
        const normalized = normalizeHexColor(color);
        set({ colorTheme: "custom", customColor: normalized });
        applyColorTheme("custom", normalized);
      },

      toggleTheme: () => {
        const currentTheme = get().theme;
        const newTheme = currentTheme === "dark" ? "light" : "dark";
        set({ theme: newTheme });
        applyTheme(newTheme);
      },

      initTheme: () => {
        const { theme, colorTheme, customColor } = get();
        applyTheme(theme);
        applyColorTheme(colorTheme, customColor);
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    }
  )
);

export const COLOR_THEMES: Record<string, string> = {
  coral: "#e54d5e",
  blue: "#3b82f6",
  red: "#ef4444",
  green: "#22c55e",
  violet: "#8b5cf6",
  orange: "#f97316",
  cyan: "#06b6d4",
};

// Apply light/dark theme to document
function applyTheme(theme: string) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const effectiveTheme = theme === "system" ? systemTheme : theme;

  if (effectiveTheme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

function applyColorTheme(colorTheme: string, customColor: string) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  // The default preset (and unknown ids, which fall back to it) follows the theme-aware
  // CSS tokens in globals.css: a deeper coral in light mode for WCAG AA contrast and the
  // original coral in dark mode. An inline value on <html> would beat both.
  const usesDefaultPreset =
    colorTheme !== "custom" && (colorTheme === "coral" || !COLOR_THEMES[colorTheme]);
  if (usesDefaultPreset) {
    root.style.removeProperty("--color-primary");
    root.style.removeProperty("--color-primary-hover");
    root.style.removeProperty("--color-on-primary");
    root.style.removeProperty("--preset-primary-on-tint-light");
    root.style.removeProperty("--preset-primary-on-tint-dark");
    return;
  }

  const baseColor =
    colorTheme === "custom" ? normalizeHexColor(customColor) : COLOR_THEMES[colorTheme];
  // The inline preset beats the theme-aware tokens in BOTH themes, so the text colour on a
  // primary surface must be derived from this exact colour. The hover shade moves AWAY
  // from that text colour (darker under white text, lighter under black text), so the
  // hover state keeps at least the base colour's contrast.
  const onPrimary = pickOnPrimary(baseColor);
  const hoverColor = shadeHexColor(baseColor, onPrimary === ON_PRIMARY_LIGHT ? -0.14 : 0.14);

  root.style.setProperty("--color-primary", baseColor);
  root.style.setProperty("--color-primary-hover", hoverColor);
  root.style.setProperty("--color-on-primary", onPrimary);
  // The 80% mixes in globals.css that make brand text readable on a primary TINT are tuned
  // for the coral brand; another hue needs another shade (white on a green tint measured
  // 2.95:1). These two per-theme overrides are consumed by the on-tint token in each theme.
  root.style.setProperty("--preset-primary-on-tint-light", pickOnTint(baseColor, "light"));
  root.style.setProperty("--preset-primary-on-tint-dark", pickOnTint(baseColor, "dark"));
}

/** WCAG 2.x AA minimum for normal-size text (SC 1.4.3). */
const AA_NORMAL_TEXT = 4.5;
/** Text on a primary surface: white — the look the app always had — whenever it passes AA. */
export const ON_PRIMARY_LIGHT = "#ffffff";
/**
 * Otherwise pure black. It is the only dark foreground that clears AA on EVERY colour
 * white fails on: white failing means luminance > 0.183, so black reaches at least 4.67:1.
 */
export const ON_PRIMARY_DARK = "#000000";

/** Foreground for text on a solid `primary` surface that meets WCAG AA for that colour. */
export function pickOnPrimary(primary: string) {
  return getContrastRatio(ON_PRIMARY_LIGHT, primary) >= AA_NORMAL_TEXT
    ? ON_PRIMARY_LIGHT
    : ON_PRIMARY_DARK;
}

/**
 * Surfaces the app paints primary TINTS on (bg-primary/10..22): the sidebar, the page
 * background and the card/subtle surfaces, per theme. Mirrors globals.css.
 */
const TINT_SURFACES: Record<"light" | "dark", string[]> = {
  light: ["#f9f9fb", "#f5f5fa", "#ffffff", "#f0f0f5"],
  dark: ["#0b0e14", "#10141e", "#161b22", "#111520"],
};
/** Tint strengths in use at call sites (bg-primary/10, /15, /22). */
const TINT_ALPHAS = [0.1, 0.15, 0.22];

function mixHexColors(a: string, b: string, weightOfA: number) {
  const left = hexChannels(a);
  const right = hexChannels(b);
  const channel = (index: number) =>
    Math.round(left[index] * weightOfA + right[index] * (1 - weightOfA));
  return `#${[0, 1, 2].map((i) => channel(i).toString(16).padStart(2, "0")).join("")}`;
}

function hexChannels(hex: string) {
  const normalized = normalizeHexColor(hex).slice(1);
  return [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16));
}

/**
 * Brand-coloured TEXT on a primary tint, shaded until it meets AA on every tint the app
 * paints in `theme`: away from the tint (towards black on light surfaces, towards white on
 * dark ones), keeping as much of the hue as the contrast allows.
 */
export function pickOnTint(primary: string, theme: "light" | "dark") {
  const target = theme === "light" ? ON_PRIMARY_DARK : ON_PRIMARY_LIGHT;
  const backdrops = TINT_SURFACES[theme].flatMap((surface) =>
    TINT_ALPHAS.map((alpha) => mixHexColors(primary, surface, alpha))
  );
  for (let keep = 100; keep >= 0; keep -= 5) {
    const candidate = mixHexColors(primary, target, keep / 100);
    if (backdrops.every((backdrop) => getContrastRatio(candidate, backdrop) >= AA_NORMAL_TEXT)) {
      return candidate;
    }
  }
  return target;
}

function normalizeHexColor(color: string) {
  const value = (color || "").trim();
  const hex = value.startsWith("#") ? value : `#${value}`;
  const valid = /^#([0-9a-fA-F]{6})$/.test(hex);
  return valid ? hex.toLowerCase() : "#3b82f6";
}

function shadeHexColor(hex: string, percent: number) {
  const normalized = normalizeHexColor(hex).slice(1);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);

  const shade = (channel: number) => {
    const target = percent < 0 ? 0 : 255;
    const amount = Math.round((target - channel) * Math.abs(percent));
    const next = percent < 0 ? channel - amount : channel + amount;
    return Math.max(0, Math.min(255, next));
  };

  const toHex = (channel: number) => channel.toString(16).padStart(2, "0");
  return `#${toHex(shade(r))}${toHex(shade(g))}${toHex(shade(b))}`;
}

export default useThemeStore;
