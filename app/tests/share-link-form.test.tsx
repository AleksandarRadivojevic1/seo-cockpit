import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import ShareLinkForm from "../components/ShareLinkForm";

describe("ShareLinkForm", () => {
  it("posts the site's slug and a label", () => {
    const html = renderToStaticMarkup(<ShareLinkForm slug="optika-cajs" />);
    expect(html).toContain('name="slug"');
    expect(html).toContain('value="optika-cajs"');
    expect(html).toContain('name="label"');
    expect(html).toContain("Create link");
  });
});
