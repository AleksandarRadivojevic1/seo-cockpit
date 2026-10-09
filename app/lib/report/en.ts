import type { ReportStrings } from "./sr";

/**
 * Every user-visible string in the English client report, for US clients.
 *
 * Same shape as `SR` (enforced by `ReportStrings`), US English, and the same
 * honesty rules: "not collected" and "measured, and zero" stay different
 * sentences, as do an absent prior period and a flat one.
 *
 * Plurals keep Serbian's three slots (one / few / other). English rules
 * never select "few", so the third slot repeats the plural.
 */
export const EN: ReportStrings = {
  docTitle: "SEO report",
  preparedBy: "Prepared by",
  author: "Aleksandar Radivojević, Deimos Agency",
  authorSite: "deimos.agency",
  period: "Period",
  print: "Download PDF",
  printBusy: "Preparing PDF…",
  printError: "The PDF couldn’t be prepared. Please try again.",

  summary: "Summary",
  clicks: ["click", "clicks", "clicks"],
  impressions: ["impression", "impressions", "impressions"],
  keywords: ["keyword", "keywords", "keywords"],
  avgPosition: "average position",

  growth: "Progress",
  months: ["month", "months", "months"],
  growthLead: (duration: string) =>
    `Over ${duration} of working together, here is how the key numbers have changed from the start to today.`,
  growthEmpty:
    "There isn’t enough history to show progress yet — it takes at least two months of collected data.",
  growthClicks: "Clicks",
  growthImpressions: "Impressions",
  growthPosition: "Average position",
  growthBefore: "at the start",
  growthAfter: "today",
  growthNew: "new",

  noPrior: (firstDay: string) =>
    `No previous period to compare with — the first measured day is ${firstDay}`,
  vsPrior: (pct: string, up: boolean) =>
    `${up ? "up" : "down"} ${pct} from the previous period`,
  noChange: "no change from the previous period",
  noPriorClicks: "the previous period recorded no clicks, so there is nothing to compare against",

  notCollected:
    "No search data has been collected for this site yet, so the sections below are empty. That is a gap in collection, not a search result.",
  measuredZero:
    "The site was measured throughout the period and recorded no impressions. The data exists, and the result is a real zero.",

  trend: "Impressions over time",
  trendEmpty: "Not enough measured days to draw the chart.",

  opportunities: "Opportunities",
  opportunitiesLead:
    "Searches the site already appears for, but below the first page — ranked by remaining potential.",
  opportunitiesEmpty:
    "No search in this period has untapped potential — everything we track is already on the first page or has too few impressions to judge.",
  colQuery: "Search term",
  colPosition: "Position",
  colImpressions: "Impressions",
  colClicks: "Clicks",
  colCtr: "CTR",
  colPage: "Page",

  movement: "Movement",
  movementRising: "Rising",
  movementDeclining: "Declining",
  movementNone: "none",
  movementEmpty: "No search moved enough to be shown.",

  sources: "Where impressions come from",
  sourceBrand: "Searches for your business name",
  sourceNonBrand: "Other searches",
  sourceAnonymous: "Search hidden by Google",
  sourcesNote:
    "Google doesn’t reveal the search term for rare searches, so the split between business-name searches and other searches covers only the part it shows.",

  pages: "Most visited pages",
  pagesEmpty: "No page-level data for this period.",

  demand: "Demand you’re not reaching",
  demandLead: (n: number, noun: string) =>
    `We found ${n} ${noun} people search for that the site doesn’t appear for yet.`,
  demandEmpty: "Demand research hasn’t been run for this site yet.",
  demandIntent: {
    commercial: "Ready to buy",
    local: "Local search",
    question: "Questions",
    other: "Other",
  },

  competitors: "Competitors",
  competitorsLead:
    "Sites that appear for the searches in the previous section, ranked by how many of them they show up for.",
  competitorsEmpty: "The competitor check hasn’t been run for these terms yet.",
  competitorsEmptySerp: "The check ran, but Google returned no results.",
  colDomain: "Site",
  colAppearances: "Searches",
  colBest: "Best position",
};
