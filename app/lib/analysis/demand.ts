import { foldDiacritics } from "./brand";
import type { DemandRow } from "../db";

export type DemandIntent = "commercial" | "question" | "local" | "other";

export interface DemandGap {
  keyword: string;
  intent: DemandIntent;
  source: string;
  /** Position in the source's own ordering. A weak popularity proxy, NOT a volume. */
  suggestRank: number | null;
  risingPct: number | null;
  risingLabel: string | null;
  volume: number | null;
}

export interface DemandBreakdown {
  /** Keywords the site has never appeared for, ranked. */
  gaps: DemandGap[];
  /** Discovered keywords the site DOES already rank for. */
  covered: number;
  totalDiscovered: number;
  byIntent: Record<DemandIntent, number>;
  /** True when no source has ever run for this site. */
  notCollected: boolean;
}

/** Buying signals. Serbian first, since that is what these sites serve. */
const COMMERCIAL = [
  "cena", "cene", "cijena", "akcij", "jeftin", "popust", "prodaja",
  "kupovina", "kupiti", "online", "cenovnik",
];

/** Question openers — the thing AnswerThePublic and AlsoAsked package up. */
const QUESTION = ["kako ", "gde ", "koliko ", "zasto ", "zašto ", "da li ", "koji ", "kada ", "sta ", "šta "];

/** Serbian cities: a local modifier means the searcher wants a nearby shop. */
const LOCAL = [
  "beograd", "novi sad", "nis", "niš", "leskovac", "kragujevac", "subotica",
  "podgorica", "banja luka", "kraljevo", "cacak", "čačak", "zrenjanin",
];

export function classifyIntent(keyword: string): DemandIntent {
  const k = foldDiacritics(keyword);
  if (QUESTION.some((q) => k.startsWith(foldDiacritics(q)))) return "question";
  if (COMMERCIAL.some((c) => k.includes(c))) return "commercial";
  if (LOCAL.some((c) => k.includes(foldDiacritics(c)))) return "local";
  return "other";
}

/** Ordering weight per intent. Commercial first: it is closest to revenue. */
const INTENT_WEIGHT: Record<DemandIntent, number> = {
  commercial: 0,
  local: 1,
  question: 2,
  other: 3,
};

/**
 * Splits discovered demand into what the site already ranks for and what it
 * does not.
 *
 * MATCHING IS DIACRITIC-FOLDED, and it has to be: Serbian users type both
 * `sočiva` and `sociva`, GSC reports whichever was typed, and autocomplete
 * returns both. Comparing raw strings would report a keyword as a gap on one
 * spelling while the site already ranks for the other. This mirrors the
 * collector's `fold_diacritics` in demand.py — the two MUST agree.
 *
 * Deliberately NOT scored. No free source gives search volume, so any single
 * number here would be a composite of proxies dressed up as a measurement —
 * the same mistake the opportunity score avoided by rendering as a bar. Gaps
 * are grouped by intent and ordered within it, so the reasoning stays visible.
 */
export function buildDemandBreakdown(
  rows: DemandRow[],
  rankedQueries: Iterable<string>
): DemandBreakdown {
  const ranked = new Set<string>();
  for (const q of rankedQueries) ranked.add(foldDiacritics(q));

  const byIntent: Record<DemandIntent, number> = {
    commercial: 0,
    question: 0,
    local: 0,
    other: 0,
  };

  const gaps: DemandGap[] = [];
  let covered = 0;
  const seen = new Set<string>();

  for (const row of rows) {
    const folded = foldDiacritics(row.keyword);
    if (seen.has(folded)) continue;
    seen.add(folded);

    if (ranked.has(folded)) {
      covered += 1;
      continue;
    }
    const intent = classifyIntent(row.keyword);
    byIntent[intent] += 1;
    gaps.push({
      keyword: row.keyword,
      intent,
      source: row.source,
      suggestRank: row.suggestRank,
      risingPct: row.risingPct,
      risingLabel: row.risingLabel,
      volume: row.volume,
    });
  }

  gaps.sort((a, b) => {
    // A rising signal outranks everything: it is the only real measurement
    // present, and "Breakout" (rising_pct null, label set) is the strongest
    // of all — Google withheld a number precisely because growth was
    // off-scale, so it must not sort below a term with a plain percentage.
    const aRise = a.risingLabel === "Breakout" ? Infinity : (a.risingPct ?? -1);
    const bRise = b.risingLabel === "Breakout" ? Infinity : (b.risingPct ?? -1);
    if (aRise !== bRise) return bRise - aRise;

    if (INTENT_WEIGHT[a.intent] !== INTENT_WEIGHT[b.intent]) {
      return INTENT_WEIGHT[a.intent] - INTENT_WEIGHT[b.intent];
    }
    // Google's own suggestion order, as a tiebreak only. Null sorts last
    // rather than as 0, which would rank an unmeasured term top.
    const aRank = a.suggestRank ?? Number.MAX_SAFE_INTEGER;
    const bRank = b.suggestRank ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return a.keyword.localeCompare(b.keyword);
  });

  return {
    gaps,
    covered,
    totalDiscovered: seen.size,
    byIntent,
    notCollected: rows.length === 0,
  };
}
