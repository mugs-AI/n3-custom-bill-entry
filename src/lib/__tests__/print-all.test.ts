import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { selectionPlan } from "../purchase-report-inquiry";

// Phase 3B Correction F guardrails.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("Correction F — routing & selection plan", () => {
  it("Print All route file exists as a flat sibling under /reports_/purchase", () => {
    expect(
      existsSync(resolve(process.cwd(), "src/routes/reports_.purchase.print-all.tsx")),
    ).toBe(true);
    const src = read("src/routes/reports_.purchase.print-all.tsx");
    expect(src).toContain('createFileRoute("/reports_/purchase/print-all")');
  });

  it("Route tree exposes /reports/purchase/print-all as a static sibling of /$view", () => {
    const tree = read("src/routeTree.gen.ts");
    expect(tree).toMatch(/'\/reports\/purchase\/print-all'/);
    // The static route must be its own file route, not swallowed by $view.
    expect(tree).toMatch(/ReportsPurchasePrintAll/);
  });

  it("All 8 views are pre-selected by default", () => {
    const src = read("src/routes/reports_.purchase.print-all.tsx");
    expect(src).toContain("new Set(VIEW_IDS)");
  });

  it("selectionPlan flags zero-selection as invalid and blocks accounting fetch", () => {
    const empty = selectionPlan<string>([], ["audit-trail", "posting-account"]);
    expect(empty.isValid).toBe(false);
    expect(empty.hasAccounting).toBe(false);
  });

  it("selectionPlan detects when only dimension reports are selected (audit stays disabled)", () => {
    const dims = selectionPlan<string>(
      ["wbs", "hq-tax"],
      ["audit-trail", "posting-account"],
    );
    expect(dims.isValid).toBe(true);
    expect(dims.hasAccounting).toBe(false);
  });

  it("selectionPlan detects any accounting selection triggers a single audit fetch", () => {
    const a = selectionPlan<string>(["posting-account"], ["audit-trail", "posting-account"]);
    expect(a.hasAccounting).toBe(true);
    const b = selectionPlan<string>(
      ["audit-trail", "posting-account", "wbs"],
      ["audit-trail", "posting-account"],
    );
    expect(b.hasAccounting).toBe(true);
    expect(b.count).toBe(3);
  });
});

describe("Correction F — compact print styling", () => {
  it("styles.css declares @page A4 portrait with a compact 7mm margin", () => {
    const css = read("src/styles.css");
    expect(css).toMatch(/@page\s*{[^}]*size:\s*A4\s+portrait/);
    expect(css).toMatch(/margin:\s*7mm/);
  });

  it("print CSS forces column headers to repeat on continuation pages", () => {
    const css = read("src/styles.css");
    expect(css).toMatch(/thead\s*{\s*display:\s*table-header-group/);
  });

  it("print CSS declares compact typography for reports", () => {
    const css = read("src/styles.css");
    expect(css).toMatch(/\.report-title[\s\S]{0,120}font-size:\s*13pt/);
    // Correction G: the body size is now user-configurable with a 7.5pt default.
    expect(css).toMatch(
      /\.report-container[\s\S]*table[\s\S]{0,200}font-size:\s*var\(--print-body-pt,\s*7\.5pt\)/,
    );

  });
});

describe("Correction F — shared header + report titles", () => {
  it("report titles are outside .no-print in the single-report shell", () => {
    const src = read("src/routes/reports_.purchase.$view.tsx");
    // The h1 must carry the print-visible report-title class.
    expect(src).toMatch(/report-title[\s\S]{0,200}\{meta\.title\}/);
  });

  it("large Purchase Audit Trail document card no longer forces break-inside: avoid", () => {
    const src = read("src/routes/reports_.purchase.$view.tsx");
    expect(src).not.toContain("print:break-inside-avoid");
  });

  it("accounting views no longer render a standalone AuditReconcileHeader (merged into CompactReportHeader)", () => {
    const src = read("src/routes/reports_.purchase.$view.tsx");
    // The definition still exists as legacy, but the two view components must not render it.
    const viewCalls = src.match(/<AuditReconcileHeader\b/g) ?? [];
    expect(viewCalls.length).toBe(0);
  });
});

describe("Correction F — GL Analysis launcher entry point", () => {
  it("PurchaseReportLauncher links to the Print All route", () => {
    const src = read("src/routes/reports.tsx");
    expect(src).toContain("/reports/purchase/print-all");
    expect(src).toMatch(/Print All 8 Reports/);
  });
});
