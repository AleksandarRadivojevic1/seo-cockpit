"use client";

import type { FeatureCollection, Geometry } from "geojson";
import { useMemo } from "react";
import { feature as topoFeature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import worldAtlas from "world-atlas/countries-110m.json";

import {
  ChoroplethChart,
  type ChoroplethFeature,
  type ChoroplethFeatureProperties,
  ChoroplethFeatureComponent,
  ChoroplethTooltip,
} from "./charts/choropleth";
import EmptyState from "./EmptyState";
import { binLabel, countryBin, COUNTRY_BIN_COUNT } from "../lib/analysis/geography";
import type { CountryBreakdown, CountryTotal } from "../lib/analysis/geography";
import type { DataState } from "../lib/portfolio";

/**
 * Bin colours, ascending. Defined in globals.css so light and dark each get
 * steps chosen against their own surface. `--geo-none` is chroma 0, which is
 * what keeps "no impressions" visibly off the ramp rather than merely the
 * palest step of it.
 */
const BIN_FILLS = ["var(--geo-1)", "var(--geo-2)", "var(--geo-3)", "var(--geo-4)"];
const NO_DATA_FILL = "var(--geo-none)";

function fillForBin(bin: number): string {
  return bin < 0 ? NO_DATA_FILL : (BIN_FILLS[bin] ?? NO_DATA_FILL);
}

/**
 * Formats a share, never rounding a real value down to "0%".
 *
 * Bosnia's single impression out of 223 is 0.45%, and printing that as "0%"
 * beside the count "1" states two contradictory things about the same country
 * — the same null-vs-zero conflation this project keeps hitting, in percentage
 * form. Sub-half-percent shares read "<1%".
 */
export function formatShare(share: number): string {
  if (share <= 0) return "0%";
  const pct = share * 100;
  if (pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/**
 * The atlas join key for a feature: its numeric ISO id where it has one, and
 * its name otherwise. Three features — Kosovo, N. Cyprus and Somaliland —
 * carry no `id` because they have no ISO 3166-1 assignment, and GSC does
 * report traffic from Kosovo. Keying on `id` alone drops them silently.
 */
function featureKey(f: ChoroplethFeature): string {
  if (f.id !== undefined && f.id !== null) return String(f.id);
  return f.properties?.name ?? "";
}

interface CountryMapProps {
  breakdown: CountryBreakdown;
  dataState: DataState;
}

/**
 * Country distribution as a world choropleth plus a ranked list.
 *
 * The list is not decoration. The real distribution is extreme — Serbia holds
 * ~95% of impressions while several countries sit at exactly 1 — and Serbia is
 * physically small at world scale, so the dominant value is a few pixels wide.
 * The map answers "where, roughly"; the list answers "how much".
 *
 * There is no "unattributed" remainder here, unlike the brand ring: GSC does
 * not anonymize the country dimension, and these rows reconcile exactly with
 * totals_daily. Every impression on screen is accounted for.
 */
export default function CountryMap({ breakdown, dataState }: CountryMapProps) {
  const geo = useMemo(() => {
    // Converted client-side on purpose: the GeoJSON is ~600KB and would
    // otherwise be serialized into the RSC payload on every page load. Only
    // the small per-country array crosses the server boundary.
    //
    // The JSON import widens to a structural literal that does not match
    // Topology, so it is re-asserted once here rather than typed as `any`.
    const topology = worldAtlas as unknown as Topology<{
      countries: GeometryCollection<ChoroplethFeatureProperties>;
    }>;
    return topoFeature(
      topology,
      topology.objects.countries
    ) as unknown as FeatureCollection<Geometry, ChoroplethFeatureProperties>;
  }, []);

  const byKey = useMemo(() => {
    const m = new Map<string, CountryTotal>();
    for (const c of breakdown.countries) {
      if (c.atlasKey) m.set(c.atlasKey, c);
    }
    return m;
  }, [breakdown]);

  if (dataState === "not-collected") {
    return <EmptyState title="Not collected yet" />;
  }
  if (breakdown.totalImpressions === 0) {
    // An all-grey world map here would read as a broken atlas rather than as
    // the true statement "this site had no impressions in the window".
    return <EmptyState title="No impressions in the last 28 days" />;
  }

  const lookup = (f: ChoroplethFeature) => byKey.get(featureKey(f));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        <div className="overflow-hidden rounded-md border border-border">
          <ChoroplethChart data={geo} aspectRatio="16 / 9">
            <ChoroplethFeatureComponent
              stroke="var(--geo-border)"
              strokeWidth={0.4}
              getFeatureColor={(f) => fillForBin(countryBin(lookup(f)?.impressions ?? 0))}
            />
            <ChoroplethTooltip
              valueLabel="Impressions"
              getFeatureName={(f) => lookup(f)?.name ?? f.properties?.name ?? "Unknown"}
              getFeatureValue={(f) => lookup(f)?.impressions ?? 0}
            />
          </ChoroplethChart>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-[2px] border border-border"
              style={{ background: NO_DATA_FILL }}
            />
            {binLabel(-1)}
          </span>
          {Array.from({ length: COUNTRY_BIN_COUNT }, (_, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <span
                className="inline-block size-3 rounded-[2px]"
                style={{ background: fillForBin(i) }}
              />
              {binLabel(i)}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <ul className="flex flex-col gap-1.5">
          {breakdown.countries.slice(0, 10).map((c) => (
            <li key={c.code} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="inline-block size-2.5 shrink-0 rounded-[2px]"
                  style={{ background: fillForBin(countryBin(c.impressions)) }}
                />
                <span className="truncate">{c.name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {c.impressions.toLocaleString()}
                <span className="ml-1.5 text-xs text-muted-foreground/70">
                  {formatShare(c.share)}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <p className="text-xs text-muted-foreground/70">
          {breakdown.countryCount} {breakdown.countryCount === 1 ? "country" : "countries"} ·{" "}
          {breakdown.totalImpressions.toLocaleString()} impressions. GSC reports country for every
          impression, so this is the full picture with nothing unattributed.
          {breakdown.unmapped.length > 0
            ? ` ${breakdown.unmapped
                .map((c) => c.name)
                .join(", ")} ${breakdown.unmapped.length === 1 ? "has" : "have"} no map location and ${
                breakdown.unmapped.length === 1 ? "is" : "are"
              } listed only.`
            : ""}
        </p>
      </div>
    </div>
  );
}
