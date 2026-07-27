/**
 * Every user-visible string in the Serbian client report.
 *
 * Kept as a plain typed object rather than an i18n framework: one localized
 * surface does not justify message extraction, a locale switch, or runtime
 * negotiation. A second language later means a second file satisfying the
 * same shape.
 *
 * SEO terms that are industry-standard in English stay English — SEO, CTR,
 * Core Web Vitals, PageSpeed Insights, Chrome UX Report. A client who
 * googles "Core Web Vitals" finds the real thing; one who googles a Serbian
 * coinage invented here finds nothing, which makes the document read as
 * machine-translated and less credible, not more.
 *
 * Script is Serbian **Latin** throughout, matching both client sites.
 */
export const SR = {
  docTitle: "SEO izveštaj",
  preparedBy: "Izveštaj pripremio",
  author: "Aleksandar Radivojević",
  authorSite: "alexrad.dev",
  period: "Period",
  print: "Sačuvaj kao PDF",

  summary: "Sažetak",
  /** [one, few, other] — Serbian has three plural forms. See pluralSr. */
  clicks: ["klik", "klika", "klikova"] as [string, string, string],
  impressions: ["prikaz", "prikaza", "prikaza"] as [string, string, string],
  keywords: ["ključna reč", "ključne reči", "ključnih reči"] as [string, string, string],
  avgPosition: "prosečna pozicija",

  /**
   * Phrased so the date stays in the nominative case. Serbian would want a
   * genitive after "počelo" ("7. jula"), and `Intl` only gives the
   * nominative month name — so the sentence is built to need what we have
   * rather than bending the date into a form we cannot produce correctly.
   */
  noPrior: (firstDay: string) =>
    `Nema prethodnog perioda za poređenje — prvi izmereni dan je ${firstDay}`,
  vsPrior: (pct: string, up: boolean) =>
    `${up ? "više" : "manje"} za ${pct} u odnosu na prethodni period`,
  noChange: "bez promene u odnosu na prethodni period",

  notCollected:
    "Za ovaj sajt još nisu prikupljeni podaci o pretrazi, pa su sekcije ispod prazne. To je praznina u prikupljanju, a ne rezultat u pretrazi.",
  measuredZero:
    "Sajt je meren tokom celog perioda i nije zabeležio nijedan prikaz. Podaci postoje i rezultat je stvarna nula.",

  trend: "Prikazi kroz vreme",
  trendEmpty: "Nema dovoljno izmerenih dana za prikaz grafikona.",
} as const;
