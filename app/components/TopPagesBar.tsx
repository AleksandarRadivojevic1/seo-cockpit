import EmptyState from "./EmptyState";
import type { PageTotal } from "../lib/analysis/breakdown";
import type { SiteSummary } from "../lib/portfolio";

interface TopPagesBarProps {
  pages: PageTotal[];
  dataState: SiteSummary["dataState"];
}

/**
 * Strips the origin so the list reads as paths. The homepage collapses to
 * "/" rather than rendering as an empty string.
 */
export function displayPath(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}` || "/";
  } catch {
    // page_daily stores whatever GSC returned; if it isn't a parseable URL,
    // showing it verbatim beats hiding the row.
    return url;
  }
}

/**
 * Top pages by impressions, as a horizontal bar list.
 *
 * A bar *list* rather than a plotted bar chart because the category labels
 * here are URLs: long, similar-prefixed, and unreadable rotated under an
 * axis. Bars are scaled to the top row, so the comparison is between pages
 * rather than against an absolute axis nobody reads.
 */
export default function TopPagesBar({ pages, dataState }: TopPagesBarProps) {
  if (pages.length === 0) {
    if (dataState === "not-collected") return <EmptyState title="Not collected yet" />;
    if (dataState === "zero") {
      return <EmptyState title="No impressions in the last 28 days" />;
    }
    return <EmptyState title="No page data in the last 28 days" />;
  }

  const top = pages[0].impressions;

  return (
    <ul className="flex flex-col gap-2">
      {pages.map((page) => (
        <li key={page.page} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-mono text-xs text-foreground">
              {displayPath(page.page)}
            </span>
            <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
              {page.clicks} / {page.impressions}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500 dark:bg-emerald-400"
              style={{ width: `${top > 0 ? (page.impressions / top) * 100 : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
