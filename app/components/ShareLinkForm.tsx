"use client";

import { useActionState, useRef, useState } from "react";

import { Button } from "./ui/button";
import { createShareLinkAction, type ShareLinkState } from "../app/sites/actions";

const INITIAL: ShareLinkState = { url: null, error: null };

const inputClass =
  "h-8 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** The new link, with a copy button that falls back to selecting the text:
 *  the clipboard API needs a secure context, and the LAN dashboard is http. */
function NewLink({ url }: { url: string }) {
  const field = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setNote("Copied.");
    } catch {
      field.current?.select();
      setNote("Selected: press Ctrl+C to copy.");
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          ref={field}
          readOnly
          value={url}
          aria-label="Share link"
          onFocus={(e) => e.currentTarget.select()}
          className={`${inputClass} flex-1 bg-muted font-mono text-xs`}
        />
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          Copy
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {note ? `${note} ` : ""}Send it to the client now: it can’t be shown again. Revoke or
        replace links on the Share links page.
      </p>
    </div>
  );
}

/**
 * Creates a client share link for this site. Admin only: rendered by the
 * admin site page, never by the client's live view.
 */
export default function ShareLinkForm({ slug }: { slug: string }) {
  const [state, formAction, pending] = useActionState(createShareLinkAction, INITIAL);

  return (
    <section className="rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm">
      <h2 className="pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Share with client
      </h2>
      <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input type="hidden" name="slug" value={slug} />
        <input
          name="label"
          placeholder="Label, e.g. Optika – owner"
          maxLength={80}
          autoComplete="off"
          className={`${inputClass} flex-1`}
        />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Creating…" : "Create link"}
        </Button>
      </form>
      {state.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
      {state.url ? <NewLink key={state.url} url={state.url} /> : null}
    </section>
  );
}
