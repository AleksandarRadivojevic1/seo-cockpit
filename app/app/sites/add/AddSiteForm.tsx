"use client";

import { useActionState, useState } from "react";

import { Button } from "../../../components/ui/button";
import {
  addSite,
  refreshProperties,
  type AddSiteState,
  type RefreshState,
} from "../actions";

const INITIAL: AddSiteState = { errors: {}, ok: false };
const INITIAL_REFRESH: RefreshState = { ok: false, requestedAt: null, error: null };

const inputClass =
  "h-8 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const labelClass = "text-xs font-medium text-muted-foreground";

function Field({
  label,
  children,
  error,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted-foreground/70">{hint}</span> : null}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </label>
  );
}

export default function AddSiteForm() {
  const [state, formAction, pending] = useActionState(addSite, INITIAL);
  const [refreshState, refreshAction, refreshing] = useActionState(
    refreshProperties,
    INITIAL_REFRESH,
  );
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [property, setProperty] = useState("");
  const [brandToken, setBrandToken] = useState("");

  return (
    <>
    <form action={formAction} className="flex flex-col gap-4">
      <Field
        label="Search Console property"
        error={state.errors.property}
        hint="Must match Search Console exactly: a domain property (sc-domain:example.com) or a URL-prefix property ending in / (https://example.com/). Checked against the properties the service account can read — grant it access in Search Console first."
      >
        <input
          name="property"
          value={property}
          onChange={(e) => setProperty(e.target.value)}
          placeholder="sc-domain:example.com"
          className={inputClass}
          autoComplete="off"
        />
      </Field>

      <Field label="Display name" error={state.errors.displayName}>
        <input
          name="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="My Agency"
          className={inputClass}
        />
      </Field>

      <Field
        label="Slug"
        error={state.errors.slug}
        hint="Used in the site's URL. Leave blank to derive it from the display name."
      >
        <input
          name="slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder={displayName ? slugifyPreview(displayName) : "my-agency"}
          className={inputClass}
          autoComplete="off"
        />
      </Field>

      <Field
        label="Brand token"
        error={state.errors.brandToken}
        hint="A word that identifies branded queries (usually the brand name), used to split brand vs non-brand traffic."
      >
        <input
          name="brandToken"
          value={brandToken}
          onChange={(e) => setBrandToken(e.target.value)}
          placeholder="agency"
          className={inputClass}
          autoComplete="off"
        />
      </Field>

      <details className="rounded-lg border border-border bg-card p-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          Advanced (optional)
        </summary>
        <div className="flex flex-col gap-4 pt-3">
          <Field
            label="Discovery seeds"
            hint="One search phrase per line. Overrides the seeds derived from page URLs when demand discovery runs."
          >
            <textarea name="discoverSeeds" rows={3} className={`${inputClass} h-auto py-1.5`} />
          </Field>
          <Field label="Trend seeds" hint="One head term per line, for Google Trends.">
            <textarea name="trendSeeds" rows={2} className={`${inputClass} h-auto py-1.5`} />
          </Field>
          <Field
            label="SERP location"
            hint="A city for local SERP checks, e.g. Leskovac, Serbia. Leave blank for country-level."
          >
            <input name="serpLocation" className={inputClass} autoComplete="off" />
          </Field>
        </div>
      </details>

      {state.ok ? (
        <p className="text-sm text-muted-foreground">
          Added. It will start collecting on the next nightly run (03:00 UTC) and
          backfill about 90 days of history.
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add site"}
        </Button>
      </div>
    </form>

    <form action={refreshAction} className="mt-4 border-t border-border pt-4">
      <p className="text-xs text-muted-foreground">
        Just granted the service account access in Search Console? The access
        check runs against a list the collector refreshes each night. Refresh it
        now, wait a few seconds, then add the site.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <Button type="submit" variant="outline" size="sm" disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh access list"}
        </Button>
        {refreshState.ok ? (
          <span className="text-xs text-muted-foreground">
            Asked the collector to refresh. Try adding again in a few seconds.
          </span>
        ) : null}
        {refreshState.error ? (
          <span className="text-xs text-destructive">{refreshState.error}</span>
        ) : null}
      </div>
    </form>
    </>
  );
}

// Local, display-only preview of the server's slugify (lib/userSites.ts owns
// the authoritative version used for validation and storage).
function slugifyPreview(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
