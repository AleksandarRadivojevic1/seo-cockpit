"use client";

import { SR } from "../../lib/report/sr";

/**
 * The only client component on the report.
 *
 * `window.print()` needs a real browser event, so this one button opts into
 * hydration. It is hidden by the print stylesheet — a button rendered into
 * a PDF a client keeps would be a dead control on a piece of paper.
 */
export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100"
    >
      {SR.print}
    </button>
  );
}
