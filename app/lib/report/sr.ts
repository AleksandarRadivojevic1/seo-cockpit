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

  opportunities: "Prilike",
  opportunitiesLead:
    "Upiti za koje se sajt već pojavljuje, ali ispod prve strane — poređani po preostalom potencijalu.",
  opportunitiesEmpty:
    "Nijedan upit u ovom periodu nema neiskorišćen potencijal — sve što pratimo je već na prvoj strani ili ima premalo prikaza za procenu.",
  colQuery: "Upit",
  colPosition: "Pozicija",
  colImpressions: "Prikazi",
  colClicks: "Klikovi",
  colCtr: "CTR",
  colPage: "Stranica",

  movement: "Kretanje",
  movementRising: "U porastu",
  movementDeclining: "U padu",
  movementNone: "nijedan",
  movementEmpty: "Nijedan upit se nije pomerio dovoljno da bi bio prikazan.",

  sources: "Odakle dolaze prikazi",
  sourceBrand: "Upiti sa imenom radnje",
  sourceNonBrand: "Ostali upiti",
  sourceAnonymous: "Google ne otkriva upit",
  /**
   * Mandatory wherever the brand split appears. Three quarters of
   * optika-cajs's impressions carry no query, so presenting brand vs
   * non-brand as the whole picture would overstate what is known.
   */
  sourcesNote:
    "Google ne prikazuje pojam pretrage za retke upite, pa se podela na upite sa imenom radnje i ostale upite odnosi samo na prikazani deo.",

  pages: "Najposećenije stranice",
  pagesEmpty: "Nema podataka o pojedinačnim stranicama za ovaj period.",

  demand: "Tražnja koju ne pokrivate",
  demandLead: (n: number, noun: string) =>
    `Pronađeno je ${n} ${noun} koje ljudi pretražuju, a za koje se sajt još ne pojavljuje.`,
  demandEmpty: "Pretraga tražnje još nije pokrenuta za ovaj sajt.",
  demandIntent: {
    commercial: "Kupovna namera",
    local: "Lokalna pretraga",
    question: "Pitanja",
    other: "Ostalo",
  } as const,

  competitors: "Konkurencija",
  competitorsLead:
    "Sajtovi koji se pojavljuju za pretrage iz prethodne sekcije, poređani po broju pretraga u kojima se javljaju.",
  /** Never checked. */
  competitorsEmpty: "Provera konkurencije još nije pokrenuta za ove pojmove.",
  /** Checked, and Google returned nothing — a different claim about the world. */
  competitorsEmptySerp: "Provera je pokrenuta, ali Google nije vratio rezultate.",
  colDomain: "Sajt",
  colAppearances: "Pretraga",
  colBest: "Najbolja pozicija",

  cwv: "Brzina sajta",
  cwvEmpty: "Brzina sajta još nije merena.",
  cwvNotMeasured: "nije mereno",
  /**
   * All four members of `MetricVerdict`, including "not-measured". A missing
   * key would render `undefined` into a document the client keeps.
   */
  cwvVerdict: {
    good: "dobro",
    "needs-work": "može bolje",
    poor: "loše",
    "not-measured": "nije mereno",
  } as const,
  cwvLab:
    "Mereno u laboratorijskim uslovima, jednim PageSpeed Insights testom — sajt nema dovoljno posetilaca za podatke iz Chrome UX Report-a, a INP nema laboratorijski ekvivalent.",
  cwvField:
    "Mereno na stvarnim posetama (75. percentil), na osnovu podataka iz Chrome UX Report-a.",
} as const;
