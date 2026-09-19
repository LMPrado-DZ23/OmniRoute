"use client";

import { EVENT_DESCRIPTIONS, WEBHOOK_EVENT_VALUES } from "@/lib/webhooks/eventDescriptions";

interface EventChecklistProps {
  selected: string[];
  onChange: (events: string[]) => void;
  allEventsLabel?: string;
  /** Accessible name of the chip group (audit C L6). */
  groupLabel?: string;
}

const CHIP_BASE = "rounded-full border px-3 py-1 text-xs font-medium transition-colors";
const CHIP_ON = "border-primary/30 bg-primary/10 text-primary";
const CHIP_OFF = "border-border bg-surface text-text-muted hover:text-text-main";

/**
 * Event subscription chips. The selectable events come from the single source of truth the
 * API validates against (`WEBHOOK_EVENT_VALUES`), so the UI can never offer an event the
 * server rejects (audit C H1) and new events appear here automatically.
 */
export function EventChecklist({
  selected,
  onChange,
  allEventsLabel = "All events",
  groupLabel,
}: EventChecklistProps) {
  const isAll = selected.includes("*");

  const toggle = (event: string) => {
    if (event === "*") {
      onChange(["*"]);
      return;
    }
    const without = selected.filter((e) => e !== "*");
    const next = without.includes(event) ? without.filter((e) => e !== event) : [...without, event];
    onChange(next.length > 0 ? next : ["*"]);
  };

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={groupLabel}>
      <button
        type="button"
        aria-pressed={isAll}
        onClick={() => toggle("*")}
        className={`${CHIP_BASE} ${isAll ? CHIP_ON : CHIP_OFF}`}
      >
        {allEventsLabel}
      </button>
      {WEBHOOK_EVENT_VALUES.map((ev) => {
        const pressed = isAll || selected.includes(ev);
        return (
          <button
            key={ev}
            type="button"
            aria-pressed={pressed}
            title={EVENT_DESCRIPTIONS[ev].description}
            onClick={() => toggle(ev)}
            className={`${CHIP_BASE} ${pressed ? CHIP_ON : CHIP_OFF}`}
          >
            {ev}
          </button>
        );
      })}
    </div>
  );
}
