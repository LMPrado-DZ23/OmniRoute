"use client";

import type { ReactNode } from "react";

const BASE_CLASS =
  "px-3 py-2 rounded-lg bg-bg-subtle border border-border text-sm text-text-primary focus:outline-none focus:border-primary appearance-none cursor-pointer";

type FilterSelectProps = {
  /** Unique element id. The viewer renders once per page, so fixed ids are unique. */
  id: string;
  /** Accessible name. Rendered into a visually-hidden <label htmlFor={id}>. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Extra classes merged after the shared control styling (e.g. a min-width). */
  className?: string;
  children: ReactNode;
};

/**
 * A request-log filter `<select>` whose accessible name comes from a real
 * `<label htmlFor>` bound to its `id`.
 *
 * Audit NEW-MEDIUM-1: the five filter selects on `/dashboard/logs` had no accessible
 * name at all — no `id`, no `aria-label`, no wrapping or explicit `<label>` — so axe
 * reported a critical `select-name` violation at every width and a screen reader
 * announced five unnamed combo boxes. Same defect and same `htmlFor`/`id` fix as C-M3
 * on Route Trace. The label is visually hidden because the compact filter row already
 * conveys each control's meaning through its first option ("All providers", …).
 */
export function FilterSelect({
  id,
  label,
  value,
  onChange,
  className,
  children,
}: FilterSelectProps) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className ? `${BASE_CLASS} ${className}` : BASE_CLASS}
      >
        {children}
      </select>
    </>
  );
}

/** Sort modes offered by the request-log sort control, in display order. */
export const SORT_OPTIONS = [
  "newest",
  "oldest",
  "tokens_desc",
  "tokens_asc",
  "duration_desc",
  "duration_asc",
  "status_desc",
  "status_asc",
  "model_asc",
  "model_desc",
];

/** `"tokens_desc"` -> `"sortTokensDesc"`, the `requestLogger` message key for that option. */
export function sortOptionKey(value: string): string {
  const camel = value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
  return `sort${camel}`;
}
