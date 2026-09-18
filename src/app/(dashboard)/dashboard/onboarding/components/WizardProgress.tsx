"use client";

/**
 * Step indicator of the onboarding wizard. The connectors shrink (flex-1 with a small
 * minimum) instead of using fixed widths, so six steps fit the card from 320 px up and
 * never push the page into horizontal scroll at intermediate widths (audit C-09).
 */
export function WizardProgress({ stepCount, current }: { stepCount: number; current: number }) {
  return (
    <ol className="mb-8 flex w-full min-w-0 items-center justify-center">
      {Array.from({ length: stepCount }, (_, i) => (
        <li
          key={i}
          aria-current={i === current ? "step" : undefined}
          className={`flex min-w-0 items-center ${i < stepCount - 1 ? "flex-1" : ""}`}
        >
          <div
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-all duration-300 ${
              i < current
                ? "bg-green-500/20 text-green-400"
                : i === current
                  ? "bg-primary/20 text-primary ring-2 ring-primary/40"
                  : "bg-white/5 text-text-muted"
            }`}
          >
            {i < current ? (
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                check
              </span>
            ) : (
              i + 1
            )}
          </div>
          {i < stepCount - 1 && (
            <div
              className={`mx-1 h-0.5 min-w-2 flex-1 rounded-full transition-colors sm:mx-2 ${
                i < current ? "bg-green-500/40" : "bg-white/10"
              }`}
            />
          )}
        </li>
      ))}
    </ol>
  );
}
