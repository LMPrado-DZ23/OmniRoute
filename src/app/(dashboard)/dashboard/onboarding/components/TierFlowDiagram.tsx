"use client";

import { useTranslations } from "next-intl";
import Image from "next/image";

/**
 * Which asset is shown is decided by CSS, not by JavaScript.
 *
 * This component used to pick the src from `next-themes`' `resolvedTheme` — the only
 * `next-themes` import in the entire `src/` tree, and there is no `ThemeProvider` from
 * that library anywhere. `resolvedTheme` was therefore always `undefined`, the ternary
 * always fell to the light asset, and dark mode served a white card in a dark UI while
 * `tier-flow-dark.svg` shipped and was never used.
 *
 * The app's real theme is a zustand store that toggles a `dark` class on `<html>`
 * (`src/store/themeStore.ts`), so a `dark:` variant reads it directly. That also removes
 * the hydration gap a JS-resolved theme has: the correct image is right on first paint.
 *
 * The hidden one is `display: none`, so it is out of the accessibility tree and only the
 * visible image is announced.
 */
export function TierFlowDiagram() {
  const t = useTranslations("onboarding.tier");
  const tOnboarding = useTranslations("onboarding");
  const alt = tOnboarding("tierFlowDiagramAlt");
  const imageClass = "w-full max-w-2xl rounded-lg border border-border";

  return (
    <div className="flex flex-col items-center gap-3 my-4">
      <Image
        src="/images/tier-flow-light.svg"
        alt={alt}
        width={800}
        height={420}
        priority
        className={`${imageClass} dark:hidden`}
      />
      <Image
        src="/images/tier-flow-dark.svg"
        alt={alt}
        width={800}
        height={420}
        className={`hidden ${imageClass} dark:block`}
      />
      <p className="mx-auto max-w-md text-xs leading-relaxed text-text-muted text-center text-balance">
        {t("flowCaption")}
      </p>
    </div>
  );
}
