import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Phase 3B routing guardrails:
//   - The temporary PurchaseBook probe route and its API endpoint were
//     removed after the audit-trail wiring landed. Re-introducing either
//     under the old paths must fail this suite.
//   - The Purchase Reports flat-sibling route must exist at
//     src/routes/reports_.purchase.$view.tsx so it renders on its own
//     without duplicating the GL Analysis page (reports.tsx is a leaf and
//     never renders <Outlet />).
//   - reports.tsx remains a leaf route (no <Outlet />) so nothing can
//     accidentally nest under it and swallow child content again.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("Phase 3B report routing", () => {
  it("temporary PurchaseBook probe files are removed", () => {
    expect(existsSync(resolve(process.cwd(), "src/routes/reports_.purchasebook-probe.tsx"))).toBe(
      false,
    );
    expect(
      existsSync(resolve(process.cwd(), "src/routes/api/reports/purchasebook-probe.ts")),
    ).toBe(false);
  });

  it("Purchase Reports shell route exists as a flat sibling", () => {
    const src = read("src/routes/reports_.purchase.$view.tsx");
    expect(src).toContain('createFileRoute("/reports_/purchase/$view")');
    expect(src).toContain("Purchase Audit Trail");
  });

  it("route tree exposes /reports/purchase/{view} without nesting under /reports", () => {
    const tree = read("src/routeTree.gen.ts");
    expect(tree).toMatch(/'\/reports\/purchase\/\$view'/);
    // Must NOT be added as a child of ReportsRoute.
    expect(tree).not.toMatch(/ReportsRoute[\s\S]{0,120}addChildren\([^)]*Purchase/);
    // Guardrail against re-introducing the probe.
    expect(tree).not.toContain("purchasebook-probe");
  });

  it("GL Analysis (reports.tsx) is still a leaf route (no <Outlet />)", () => {
    const src = read("src/routes/reports.tsx");
    expect(src).not.toMatch(/<Outlet\b/);
  });

  it("reports.tsx no longer links to the removed probe route", () => {
    const src = read("src/routes/reports.tsx");
    expect(src).not.toContain("purchasebook-probe");
    expect(src).not.toMatch(/PurchaseBook Probe/);
  });
});
