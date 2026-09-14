"use client";

import { useActionState } from "react";

import { requestCollectionRun, type RunState } from "../app/sites/actions";

const INITIAL: RunState = { ok: false, requestedAt: null, error: null };

export default function RunNowButton() {
  const [state, formAction, pending] = useActionState(requestCollectionRun, INITIAL);

  return (
    <form action={formAction} className="flex items-center gap-2">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-7 items-center rounded-lg border border-border bg-background px-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
      >
        {pending ? "Requesting…" : "Run collection now"}
      </button>
      {state.ok ? (
        <span className="text-xs text-muted-foreground">Requested — starting within ~15s.</span>
      ) : null}
      {state.error ? (
        <span className="text-xs text-destructive">{state.error}</span>
      ) : null}
    </form>
  );
}
