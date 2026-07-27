import EmptyState from "./EmptyState";
import { cn } from "../lib/utils";
import type { SerpCheckRow } from "../lib/db";
import {
  absenceLabel,
  classifyDomain,
  isHomepage,
  rankCompetitors,
  serpState,
  topResults,
  type DomainKind,
} from "../lib/analysis/serp";

const KIND_LABEL: Record<DomainKind, string> = {
  own: "You",
  competitor: "Shop",
  marketplace: "Marketplace",
  social: "Social",
  content: "Article",
};

const KIND_STYLE: Record<DomainKind, string> = {
  own: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  competitor: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  marketplace: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  social: "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  content: "bg-muted text-muted-foreground",
};

interface SerpCompetitorsProps {
  checks: SerpCheckRow[];
  ownDomain: string;
  /** Organic results shown per keyword. */
  resultsPerKeyword?: number;
}

function KindTag({ kind }: { kind: DomainKind }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        KIND_STYLE[kind]
      )}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

/**
 * Who holds the searches this site is missing.
 *
 * Search Console can only report queries the site already appears for, and
 * the demand panel can only say a keyword exists. This panel answers the
 * question both of those leave open: is the gap winnable, and who would
 * have to be displaced.
 *
 * Deliberately unscored, for the same reason the demand list is: no free
 * source gives volume, so a "difficulty 47" would be proxies dressed as a
 * measurement. The observable facts are shown instead — who ranks, whether
 * they rank with a homepage or a deep page, whether a marketplace or a
 * video owns the result, and how far down we are if we appear at all.
 */
export default function SerpCompetitors({
  checks,
  ownDomain,
  resultsPerKeyword = 5,
}: SerpCompetitorsProps) {
  const state = serpState(checks);

  // Three distinct empty states. A FAILED check writes nothing at all, so it
  // is indistinguishable from "never checked" -- which is the conservative
  // and correct outcome, never "we looked and nobody ranks".
  if (state === "not-checked") {
    return (
      <EmptyState
        title="No SERP checks run yet"
        description="Run `python -m seocockpit.schedule serp --dry-run` to see what it would cost."
      />
    );
  }
  if (state === "empty-serp") {
    return (
      <EmptyState
        title="Google returned no organic results"
        description="Checked, and these searches have no organic listings at all."
      />
    );
  }

  const competitors = rankCompetitors(checks, ownDomain).filter((c) => c.kind !== "own");

  return (
    <div className="flex flex-col gap-5">
      {competitors.length > 0 && (
        <div>
          <h3 className="pb-2 text-xs font-medium text-muted-foreground">
            Domains holding these searches most often
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {competitors.slice(0, 10).map((c) => (
              <span
                key={c.domain}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs"
              >
                <span className="text-foreground">{c.domain}</span>
                <span className="tabular-nums text-muted-foreground">
                  {c.appearances}/{checks.length}
                </span>
                <KindTag kind={c.kind} />
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {checks.map((check) => (
          <div key={check.keyword} className="border-t border-border/60 pt-3 first:border-0 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-foreground">{check.keyword}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {check.ourPosition === null ? (
                  absenceLabel(check)
                ) : (
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    You rank {check.ourPosition}
                  </span>
                )}
                {check.localPack === 1 && (
                  <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
                    Map pack
                  </span>
                )}
                {check.adsTop != null && check.adsTop > 0 && (
                  <span className="tabular-nums">
                    {check.adsTop} ad{check.adsTop === 1 ? "" : "s"} above
                  </span>
                )}
              </span>
            </div>

            <ol className="flex flex-col gap-0.5 pt-1.5">
              {topResults(check, resultsPerKeyword).map((result) => {
                const kind = classifyDomain(result.domain, ownDomain);
                return (
                  <li
                    key={result.position}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <span className="w-4 shrink-0 text-right tabular-nums">{result.position}</span>
                    <span className="truncate text-foreground">{result.domain}</span>
                    <KindTag kind={kind} />
                    {/* A homepage ranking means authority is winning; a deep
                        page means content is, which is the beatable case. */}
                    {!isHomepage(result.url) && (
                      <span className="text-[10px] whitespace-nowrap">deep page</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}
