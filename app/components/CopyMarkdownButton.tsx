"use client";

import { useState } from "react";

import { Button } from "./ui/button";

interface CopyMarkdownButtonProps {
  markdown: string;
}

/**
 * Copies the proposal's Markdown to the clipboard.
 *
 * The markdown is serialized on the server and passed down as a string, so
 * what gets copied is byte-identical to what the page was rendered from —
 * there is no second code path that could drift from the page's numbers.
 */
export default function CopyMarkdownButton({ markdown }: CopyMarkdownButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setState("copied");
    } catch {
      // Clipboard access can be denied outright (permissions, insecure
      // origin). Saying so beats a button that silently does nothing.
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  }

  return (
    <Button variant="outline" onClick={copy} className="print:hidden">
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy as Markdown"}
    </Button>
  );
}
