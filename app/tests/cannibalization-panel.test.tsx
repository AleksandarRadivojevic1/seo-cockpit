import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import Cannibalization from "../components/Cannibalization";

describe("Cannibalization", () => {
  it("shows a not-collected state when the snapshot is absent", () => {
    const html = renderToStaticMarkup(
      <Cannibalization breakdown={{ notCollected: true, items: [] }} />,
    );
    expect(html).toMatch(/not collected/i);
  });

  it("shows a clean measured-zero state when nothing cannibalizes", () => {
    const html = renderToStaticMarkup(
      <Cannibalization breakdown={{ notCollected: false, items: [] }} />,
    );
    expect(html).toMatch(/no cannibalized queries/i);
  });

  it("lists a cannibalized query with its canonical page and impressions at stake", () => {
    const html = renderToStaticMarkup(
      <Cannibalization
        breakdown={{
          notCollected: false,
          items: [
            {
              query: "kontaktna sociva",
              canonical: { page: "https://x/a", clicks: 5, impressions: 100, position: 3 },
              competitors: [{ page: "https://x/b", clicks: 0, impressions: 40, position: 8 }],
              impressionsAtStake: 40,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("kontaktna sociva");
    expect(html).toContain("https://x/a");
    expect(html).toContain("https://x/b");
    expect(html).toContain("40");
  });
});
