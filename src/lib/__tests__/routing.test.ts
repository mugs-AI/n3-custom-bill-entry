import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Phase 3B Prerequisite Correction A: guardrail against the probe becoming a
// child of /reports again. When probe was nested under reports, /reports
// rendered without an <Outlet /> and the URL changed but the page stayed on
// GL Analysis. The trailing-underscore filename makes it a flat sibling.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("/reports and /reports/purchasebook-probe routing", () => {
  it("probe route file is a flat sibling (reports_.purchasebook-probe.tsx)", () => {
    // File must exist under the flat-sibling filename.
    const src = read("src/routes/reports_.purchasebook-probe.tsx");
    expect(src).toContain('createFileRoute("/reports_/purchasebook-probe")');
    expect(src).toContain("PurchaseBook Probe");
    expect(src).toContain("Temporary diagnostic");
  });

  it("generated route tree exposes both paths as siblings, not parent/child", () => {
    const tree = read("src/routeTree.gen.ts");
    // Non-nested sibling — probe id lives under /reports_, not /reports.
    expect(tree).toContain("'/reports_/purchasebook-probe'");
    // Fullpath still resolves to /reports/purchasebook-probe for the URL.
    expect(tree).toMatch(/'\/reports\/purchasebook-probe':\s*typeof ReportsPurchasebookProbeRoute/);
    // reports.tsx must not adopt the probe as a child.
    expect(tree).not.toMatch(/ReportsRoute.*addChildren\([^)]*Probe/);
  });

  it("GL Analysis (reports.tsx) does not render <Outlet /> above its content", () => {
    // Reports is a leaf route (its component owns the whole page), so any
    // accidental nesting of the probe would remain invisible — which is the
    // exact failure Correction A fixes. Keep the leaf semantics explicit.
    const src = read("src/routes/reports.tsx");
    expect(src).not.toMatch(/<Outlet\b/);
  });
});
