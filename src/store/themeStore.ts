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
