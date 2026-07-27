import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import SerpCompetitors from "../components/SerpCompetitors";
import type { SerpCheckRow } from "../lib/db";
import {
  absenceLabel,
  classifyDomain,
  isHomepage,
  ownDomainFor,
  rankCompetitors,
  serpState,
} from "../lib/analysis/serp";

const OWN = "optikacajs.rs";

function check(overrides: Partial<SerpCheckRow> & { keyword: string }): SerpCheckRow {
  return {
    checkedAt: "2026-07-27T12:00:00+00:00",
    location: null,
    depthChecked: 10,
    localPack: 0,
    adsTop: 0,
    adsBottom: 0,
    ourPosition: null,
    results: [],
    ...overrides,
  };
}

function result(position: number, domain: string, url?: string) {
  return { position, domain, url: url ?? `https://${domain}/some/page`, title: null };
}

describe("ownDomainFor", () => {
  it.each([
    ["https://optikacajs.rs/", "optikacajs.rs"],
    ["https://www.skedio.rs/", "skedio.rs"],
    ["sc-domain:alexrad.dev", "alexrad.dev"],
  ])("maps %s to %s", (property, expected) => {
    expect(ownDomainFor(property)).toBe(expected);
  });
});

describe("classifyDomain", () => {
  // Every domain below came out of a REAL captured SERP on 2026-07-27, not
  // from imagination.
  it.each([
    ["optikacajs.rs", "own"],
    ["shop.optikacajs.rs", "own"],
    ["kupujemprodajem.com", "marketplace"],
    ["ananas.rs", "marketplace"],
    ["youtube.com", "social"],
    ["instagram.com", "social"],
    ["reddit.com", "social"],
    ["mojvid.rs", "content"],
    ["diopta.rs", "competitor"],
    ["online.sanioptik.rs", "competitor"],
  ])("classifies %s as %s", (domain, expected) => {
    expect(classifyDomain(domain, OWN)).toBe(expected);
  });

  it("treats a subdomain of a known platform as that platform", () => {
    expect(classifyDomain("www.youtube.com", OWN)).toBe("social");
  });
});

describe("isHomepage", () => {
  it.each([
    ["https://okoplusoptika.rs/", true],
    ["https://cvikeri.com", true],
    ["https://alexrad.dev/sr", true],
    ["https://oculusoptika.rs/kategorija/naocare/dioptrijski-okviri/", false],
    ["https://online.sanioptik.rs/sr/akcije", false],
  ])("%s -> %s", (url, expected) => {
    expect(isHomepage(url)).toBe(expected);
  });
});

describe("absenceLabel", () => {
  it("states the depth actually examined rather than claiming 'not ranking'", () => {
    // A bare "not ranking" is unfalsifiable and overstates the measurement.
    expect(absenceLabel({ depthChecked: 10 })).toBe("Not in top 10");
    expect(absenceLabel({ depthChecked: 100 })).toBe("Not in top 100");
  });
});

describe("serpState", () => {
  it("distinguishes never-checked from checked-with-an-empty-SERP", () => {
    expect(serpState([])).toBe("not-checked");
    expect(serpState([check({ keyword: "a" })])).toBe("empty-serp");
    expect(serpState([check({ keyword: "a", results: [result(1, "diopta.rs")] })])).toBe("ok");
  });
});

describe("rankCompetitors", () => {
  it("counts a domain once per SERP even when it holds two positions", () => {
    // sanioptik.rs really did hold 1 and 5 of the same real SERP. Counting
    // both would let a site with many URLs outrank a site with one good one.
    const checks = [
      check({
        keyword: "dioptrijski okviri akcija",
        results: [result(1, "online.sanioptik.rs"), result(5, "online.sanioptik.rs")],
      }),
    ];
    const [top] = rankCompetitors(checks, OWN);
    expect(top.appearances).toBe(1);
    expect(top.bestPosition).toBe(1);
  });

  it("ranks by how many of the checked SERPs a domain appears in", () => {
    const checks = [
      check({ keyword: "a", results: [result(1, "diopta.rs"), result(2, "cvikeri.com")] }),
      check({ keyword: "b", results: [result(3, "diopta.rs")] }),
      check({ keyword: "c", results: [result(4, "diopta.rs")] }),
    ];
    const ranked = rankCompetitors(checks, OWN);
    expect(ranked[0]).toMatchObject({ domain: "diopta.rs", appearances: 3, bestPosition: 1 });
    expect(ranked[1]).toMatchObject({ domain: "cvikeri.com", appearances: 1 });
  });

  it("tags our own domain rather than silently dropping it", () => {
    const checks = [check({ keyword: "a", results: [result(4, OWN)] })];
    expect(rankCompetitors(checks, OWN)[0].kind).toBe("own");
  });
});

describe("SerpCompetitors panel", () => {
  function render(props: Parameters<typeof SerpCompetitors>[0]): string {
    return renderToStaticMarkup(createElement(SerpCompetitors, props));
  }

  it("says no checks have been run when none have", () => {
    const html = render({ checks: [], ownDomain: OWN });
    expect(html).toMatch(/no serp checks run yet/i);
  });

  it("distinguishes an empty SERP from never having checked", () => {
    // A FAILED check writes nothing, so it can only ever look like
    // "not checked". An empty SERP is a real, separate finding.
    const html = render({ checks: [check({ keyword: "obscure" })], ownDomain: OWN });
    expect(html).toMatch(/no organic results/i);
    expect(html).not.toMatch(/no serp checks run yet/i);
  });

  it("renders the depth-aware absence label, never a bare 'not ranking'", () => {
    const html = render({
      checks: [check({ keyword: "kontaktna sociva", results: [result(1, "diopta.rs")] })],
      ownDomain: OWN,
    });
    expect(html).toContain("Not in top 10");
    expect(html).not.toMatch(/not ranking/i);
  });

  it("shows our position when we do appear", () => {
    const html = render({
      checks: [
        check({
          keyword: "optika leskovac",
          ourPosition: 4,
          results: [result(4, OWN)],
        }),
      ],
      ownDomain: OWN,
    });
    expect(html).toContain("You rank 4");
  });

  it("marks a map pack, because it pushes organic below three local listings", () => {
    const html = render({
      checks: [
        check({ keyword: "optika blizu mene", localPack: 1, results: [result(1, "diopta.rs")] }),
      ],
      ownDomain: OWN,
    });
    expect(html).toMatch(/map pack/i);
  });

  it("does not claim a map pack when there was none", () => {
    const html = render({
      checks: [check({ keyword: "x", localPack: 0, results: [result(1, "diopta.rs")] })],
      ownDomain: OWN,
    });
    expect(html).not.toMatch(/map pack/i);
  });

  it("labels a deep page but not a homepage", () => {
    const html = render({
      checks: [
        check({
          keyword: "x",
          results: [
            result(1, "okoplusoptika.rs", "https://okoplusoptika.rs/"),
            result(2, "oculusoptika.rs", "https://oculusoptika.rs/kategorija/naocare/"),
          ],
        }),
      ],
      ownDomain: OWN,
    });
    expect(html).toContain("deep page");
    // Exactly one of the two results is deep.
    expect(html.match(/deep page/g)).toHaveLength(1);
  });

  it("surfaces marketplaces and social results as their own kinds", () => {
    const html = render({
      checks: [
        check({
          keyword: "x",
          results: [result(1, "kupujemprodajem.com"), result(2, "youtube.com")],
        }),
      ],
      ownDomain: OWN,
    });
    expect(html).toContain("Marketplace");
    expect(html).toContain("Social");
  });

  it("does not print a keyword-difficulty score anywhere", () => {
    // Same rule as the demand list and the opportunity bar: no free source
    // gives volume, so any single number would be proxies dressed up as a
    // measurement.
    const html = render({
      checks: [check({ keyword: "x", results: [result(1, "diopta.rs")] })],
      ownDomain: OWN,
    });
    expect(html).not.toMatch(/difficulty/i);
    expect(html).not.toMatch(/score/i);
  });
});
