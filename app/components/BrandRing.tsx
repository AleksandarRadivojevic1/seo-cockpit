import EmptyState from "./EmptyState";
import type { BrandBreakdown } from "../lib/analysis/breakdown";

interface BrandRingProps {
  breakdown: BrandBreakdown;
}

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const SEGMENT_COLORS = {
  brand: "oklch(0.74 0.15 165)",
  nonBrand: "oklch(0.72 0.13 250)",
  anonymized: "oklch(0.55 0 0)",
} as const;

interface Segment {
  key: keyof typeof SEGMENT_COLORS;
  label: string;
  value: number;
  note?: string;
}

/**
 * Brand vs non-brand vs anonymized impressions.
 *
 * The third segment is not decoration. GSC withholds the query for rare
 * searches, so brand + non-brand is materially LESS than the site total —
 * 75% of Optika Cajs's impressions are unattributed on real data. A
 * two-slice ring would either drop that majority or rescale the two known
 * slices to fill the circle, and both would misstate what was measured.
 * The remainder is drawn, labelled, and explained.
 */
export default function BrandRing({ breakdown }: BrandRingProps) {
  const { brandImpressions, nonBrandImpressions, anonymizedImpressions, totalImpressions } =
    breakdown;

  if (totalImpressions === 0) {
    return <EmptyState title="No impressions in the last 28 days" />;
  }

  const segments: Segment[] = [
    { key: "brand", label: "Brand", value: brandImpressions },
    { key: "nonBrand", label: "Non-brand", value: nonBrandImpressions },
    {
      key: "anonymized",
      label: "Anonymized",
      value: anonymizedImpressions,
      note: "Google withholds the query for rare searches",
    },
  ];

  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
      <svg viewBox="0 0 100 100" className="h-32 w-32 shrink-0 -rotate-90" role="img"
        aria-label={`Impressions: ${brandImpressions} brand, ${nonBrandImpressions} non-brand, ${anonymizedImpressions} anonymized`}
      >
        {segments.map((segment) => {
          const fraction = segment.value / totalImpressions;
          const dash = fraction * CIRCUMFERENCE;
          const element = (
            <circle
              key={segment.key}
              cx="50"
              cy="50"
              r={RADIUS}
              fill="none"
              stroke={SEGMENT_COLORS[segment.key]}
              strokeWidth="12"
              strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
              strokeDashoffset={-offset}
            />
          );
          offset += dash;
          return element;
        })}
      </svg>

      <ul className="flex w-full min-w-0 flex-col gap-2">
        {segments.map((segment) => (
          <li key={segment.key} className="flex flex-col">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: SEGMENT_COLORS[segment.key] }}
                />
                <span className="truncate text-foreground">{segment.label}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {segment.value}
                <span className="pl-1.5 text-xs">
                  {Math.round((segment.value / totalImpressions) * 100)}%
                </span>
              </span>
            </div>
            {segment.note && (
              <span className="pl-4 text-xs text-muted-foreground/70">{segment.note}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
