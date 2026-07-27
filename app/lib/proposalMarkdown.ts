import { formatMetricValue, metricVerdictFor } from "./cwv-format";
import type { MetricKey } from "./cwv-format";
import type { SignalEntry } from "./analysis/signals";
import type { ReportData } from "./report/data";

/**
 * The subset of the shared report facts this serializer reads.
 *
 * Picked from `ReportData` rather than redeclared, so the English proposal
 * and the Serbian client report cannot drift apart in what they mean by
 * "impressions" or "opportunities". `opportunities` is ranked by opportunity
 * score, highest first.
 */
export type ProposalInput = Pick<
  ReportData,
  | "siteName"
  | "property"
  | "window"
  | "dataState"
  | "clicks"
  | "impressions"
  | "avgPosition"
  | "breakdown"
  | "opportunities"
  | "rising"
  | "declining"
  | "topPages"
  | "cwv"
>;

/** Rows included per section — a findings page, not a data dump. */
const MAX_ROWS = 10;

function pct(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
}

function path(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}` || "/";
  } catch {
    return url;
  }
}

/**
 * The trend line for the headline number.
 *
 * A null delta means there was no prior window to compare against, which
 * is not the same as flat. Writing "0%" there would invent a comparison
 * for a client — the one direction this document must never fail in.
 */
function clicksLine(clicks: ProposalInput["clicks"]): string {
  if (clicks.deltaPct === null) {
    return `**${clicks.recent}** clicks (no prior window to compare against)`;
  }
  const rounded = Math.round(clicks.deltaPct * 10) / 10;
  const direction = rounded === 0 ? "no change" : rounded > 0 ? "up" : "down";
  return `**${clicks.recent}** clicks (${direction} ${Math.abs(rounded)}% vs the previous 28 days)`;
}

function queryRows(entries: SignalEntry[]): string[] {
  return entries
    .slice(0, MAX_ROWS)
    .map(
      (e) =>
        `| ${e.query} | ${e.position.toFixed(1)} | ${e.impressions} | ${(e.ctr * 100).toFixed(1)}% |`
    );
}

const QUERY_TABLE_HEAD = ["| Query | Position | Impressions | CTR |", "| --- | --- | --- | --- |"];

/**
 * Serializes one site's findings as Markdown, for the "copy findings"
 * button on the proposal page.
 *
 * Written to be handed to a client, which sets the standard for what it
 * may claim. Three rules follow from that and are enforced by tests:
 *
 * 1. Empty sections are stated, never dropped. A missing heading reads as
 *    "not checked"; "none found" is itself a finding.
 * 2. The anonymized impression share is disclosed wherever the brand split
 *    appears. GSC withholds the query for most searches on small sites, so
 *    presenting brand vs non-brand as the whole picture overstates what is
 *    known.
 * 3. Nothing unmeasured is scored, and nothing measured is hidden. A null
 *    metric says "not measured"; a real zero is printed as a zero.
 *
 * The raw opportunity score never appears: it is unbounded and unitless,
 * so a number would imply a precision it does not have. Ordering carries
 * the ranking instead.
 */
export function toProposalMarkdown(input: ProposalInput): string {
  const lines: string[] = [];

  lines.push(`# ${input.siteName}`);
  lines.push("");
  lines.push(`SEO findings for ${input.property} — ${input.window.start} to ${input.window.end}.`);
  lines.push("");

  if (input.dataState === "not-collected") {
    lines.push(
      "> No search data has been collected for this site yet, so the sections below are empty. This is a collection gap, not a ranking result."
    );
    lines.push("");
  } else if (input.dataState === "zero") {
    lines.push(
      "> This site was measured over the full window and recorded no impressions. The data is present and the result is genuinely zero."
    );
    lines.push("");
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(`- ${clicksLine(input.clicks)}`);
  lines.push(`- **${input.impressions}** impressions`);
  lines.push(
    `- Average position **${input.avgPosition === null ? "not available" : input.avgPosition.toFixed(1)}**`
  );
  lines.push("");

  lines.push("## Opportunities");
  lines.push("");
  if (input.opportunities.length === 0) {
    lines.push(
      "No queries with ranking upside were found in this window — everything tracked is already on page 1, or has too few impressions to judge."
    );
  } else {
    lines.push("Queries ranked below page 1, ordered by remaining upside.");
    lines.push("");
    lines.push(...QUERY_TABLE_HEAD, ...queryRows(input.opportunities));
  }
  lines.push("");

  lines.push("## Movement");
  lines.push("");
  if (input.rising.length === 0 && input.declining.length === 0) {
    lines.push("No queries moved enough to report in this window.");
  } else {
    lines.push(`- Rising: ${input.rising.length === 0 ? "none" : input.rising.slice(0, MAX_ROWS).map((e) => e.query).join(", ")}`);
    lines.push(
      `- Declining: ${input.declining.length === 0 ? "none" : input.declining.slice(0, MAX_ROWS).map((e) => e.query).join(", ")}`
    );
  }
  lines.push("");

  lines.push("## Where the impressions come from");
  lines.push("");
  const b = input.breakdown;
  lines.push(`- Brand queries: **${b.brandImpressions}** (${pct(b.brandImpressions, b.totalImpressions)})`);
  lines.push(
    `- Non-brand queries: **${b.nonBrandImpressions}** (${pct(b.nonBrandImpressions, b.totalImpressions)})`
  );
  lines.push(
    `- Not attributed: **${b.anonymizedImpressions}** (${pct(b.anonymizedImpressions, b.totalImpressions)})`
  );
  lines.push("");
  lines.push(
    "Google withholds the search term for rare queries, so the brand/non-brand split covers only the attributed portion above."
  );
  lines.push("");

  lines.push("## Top pages");
  lines.push("");
  if (input.topPages.length === 0) {
    lines.push("No page-level data was returned for this window.");
  } else {
    lines.push("| Page | Clicks | Impressions | Position |", "| --- | --- | --- | --- |");
    for (const page of input.topPages.slice(0, MAX_ROWS)) {
      lines.push(
        `| ${path(page.page)} | ${page.clicks} | ${page.impressions} | ${page.position.toFixed(1)} |`
      );
    }
  }
  lines.push("");

  lines.push("## Core Web Vitals");
  lines.push("");
  if (!input.cwv) {
    lines.push("No Core Web Vitals have been collected for this site yet.");
  } else {
    const { cwv } = input;
    // An unmeasured metric already reads "Not measured"; appending
    // "(not measured)" to it is noise. A measured one keeps its verdict.
    const metricLine = (label: string, value: number | null, key: MetricKey) => {
      const shown = formatMetricValue(value, key);
      return value === null
        ? `- ${label}: **${shown}**`
        : `- ${label}: **${shown}** (${metricVerdictFor(value, key)})`;
    };
    lines.push(metricLine("LCP", cwv.lcp_p75, "lcp"));
    lines.push(metricLine("INP", cwv.inp_p75, "inp"));
    lines.push(metricLine("CLS", cwv.cls_p75, "cls"));
    lines.push("");
    lines.push(
      cwv.source === "psi"
        ? "Measured as lab data from a single PageSpeed Insights run — this site has too little traffic for Chrome UX Report field data, and INP has no lab equivalent."
        : "Measured as field data (75th percentile) from the Chrome UX Report, based on real visits."
    );
  }
  lines.push("");

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
