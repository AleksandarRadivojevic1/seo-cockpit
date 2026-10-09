import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import * as dashboard from "../components/SiteDashboard";

describe("SiteDashboard", () => {
  it("exports the component and the two helpers the page re-exports", () => {
    expect(typeof dashboard.default).toBe("function");
    expect(typeof dashboard.buildTrendSeries).toBe("function");
    expect(typeof dashboard.formatNonBrandDelta).toBe("function");
  });

  it("renders no navigation of its own: every link arrives through a slot", () => {
    // The client live view renders this component; a link written inside it
    // would reach the client. Admin links are passed in by the admin page.
    const source = fs.readFileSync(path.join(process.cwd(), "components/SiteDashboard.tsx"), "utf-8");
    expect(source).not.toMatch(/<Link\b/);
    expect(source).not.toMatch(/\bhref=/);
    expect(source).not.toMatch(/from "next\/link"/);
  });
});
