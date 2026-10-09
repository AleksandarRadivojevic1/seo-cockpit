import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import UserSitesFileNotice from "../components/UserSitesFileNotice";

describe("UserSitesFileNotice", () => {
  it("renders nothing when the file is fine", () => {
    expect(renderToStaticMarkup(<UserSitesFileNotice message={null} />)).toBe("");
  });

  it("shows the parse error as an alert, so a malformed file doesn't read as 'no user sites'", () => {
    const html = renderToStaticMarkup(
      <UserSitesFileNotice message="/config/user-sites.json could not be parsed (invalid JSON: Unexpected end of JSON input)." />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("could not be parsed");
    expect(html).toContain("Unexpected end of JSON input");
  });
});
