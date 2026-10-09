import { REPORT_LANGUAGES, type ReportLanguage } from "../../lib/report/language";

/**
 * SR / EN links for the report. Plain links that change `?lang=`, so the PDF
 * button and a reload keep the choice. Lives in the report's screen-only
 * toolbar, so it never prints.
 */
export default function LanguageSwitch({
  current,
  hrefFor,
}: {
  current: ReportLanguage;
  hrefFor: (lang: ReportLanguage) => string;
}) {
  return (
    <nav aria-label="Report language" className="flex items-center gap-1 text-sm">
      {REPORT_LANGUAGES.map((lang) => (
        <a
          key={lang}
          href={hrefFor(lang)}
          aria-current={lang === current ? "true" : undefined}
          className={
            lang === current
              ? "rounded-md bg-neutral-900 px-2 py-1 text-white"
              : "rounded-md px-2 py-1 text-neutral-600 hover:bg-neutral-100"
          }
        >
          {lang.toUpperCase()}
        </a>
      ))}
    </nav>
  );
}
