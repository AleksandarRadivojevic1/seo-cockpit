"use client";

import { useState } from "react";

import { SR } from "../../lib/report/sr";

/**
 * Downloads the report as a PDF file.
 *
 * Rendered as a real link to the PDF route, so it works with JavaScript
 * disabled and the browser handles the download itself. The click handler is
 * an enhancement on top: the server needs a few seconds to print the page,
 * and a link that appears to do nothing for that long reads as broken — so
 * the fetch path exists purely to show progress and to report a failure
 * instead of leaving the client staring at an unchanged page.
 *
 * Hidden in print: a download button is a dead control on paper.
 */
export default function PrintButton({ href }: { href: string }) {
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  async function download(event: React.MouseEvent<HTMLAnchorElement>) {
    // Let modified clicks (new tab, save-as) behave normally.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();

    setState("busy");
    try {
      const res = await fetch(href);
      if (!res.ok) throw new Error(`PDF request failed: ${res.status}`);

      // The filename lives in Content-Disposition, which fetch exposes only
      // as a raw header; the RFC 5987 form carries the Serbian characters.
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
      const name = encoded ? decodeURIComponent(encoded) : (plain ?? "report.pdf");

      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="flex items-center gap-3">
      {state === "error" && <span className="text-xs text-red-700">{SR.printError}</span>}
      <a
        href={href}
        onClick={download}
        aria-busy={state === "busy"}
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition-colors hover:bg-neutral-100 aria-busy:cursor-progress aria-busy:opacity-60"
      >
        {state === "busy" ? SR.printBusy : SR.print}
      </a>
    </div>
  );
}
