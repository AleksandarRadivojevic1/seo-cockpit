/**
 * The client report's two languages.
 *
 * Only the report (and its PDF) is bilingual. The admin dashboard, the
 * proposal, and the client live view stay English.
 */
export const REPORT_LANGUAGES = ["sr", "en"] as const;
export type ReportLanguage = (typeof REPORT_LANGUAGES)[number];

export function isReportLanguage(value: unknown): value is ReportLanguage {
  return value === "sr" || value === "en";
}

/**
 * The language a report request renders in: `?lang=` when it is exactly
 * `sr` or `en`, otherwise the site's default.
 *
 * Strict on purpose: the parameter is written by our own links (the SR / EN
 * switch, the PDF button, share links), so anything else, including a
 * repeated parameter that Next passes as an array, is a mangled URL, and the
 * site default is the safe answer.
 */
export function resolveReportLanguage(
  param: string | string[] | null | undefined,
  siteDefault: ReportLanguage,
): ReportLanguage {
  return isReportLanguage(param) ? param : siteDefault;
}
