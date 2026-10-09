/** The client's only navigation: their report and their live data. */
export default function ShareTabs({ token, current }: { token: string; current: "report" | "live" }) {
  const tabs = [
    { key: "report", label: "Report", href: `/share/${token}` },
    { key: "live", label: "Live data", href: `/share/${token}/live` },
  ] as const;
  return (
    <nav aria-label="Client view" className="flex items-center gap-1 text-sm">
      {tabs.map((tab) => (
        <a
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === current ? "page" : undefined}
          className={
            tab.key === current
              ? "rounded-md bg-neutral-900 px-3 py-1 text-white"
              : "rounded-md px-3 py-1 text-neutral-600 hover:bg-neutral-100"
          }
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
