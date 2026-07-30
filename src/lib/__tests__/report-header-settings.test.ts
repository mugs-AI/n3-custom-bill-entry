import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FIELD_IDS, DEFAULT_LAYOUT } from "../item-layout";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

const view = read("src/routes/reports_.purchase.$view.tsx");
const settings = read("src/routes/settings.tsx");

describe("Correction G — one compact report header", () => {
  it("renders every common metric through the inline Metric component", () => {
    for (const label of ["Period", "Coverage", "GL Analysis Totals (MYR)"]) {
      expect(view).toContain(`label="${label}"`);
    }
  });

  it("renders the four audit metrics in the same card", () => {
    for (const label of [
      "Target PIs",
      "Upstream Requests",
      "GL Rows Matched",
      "Documents Reconciled",
    ]) {
      expect(view).toContain(`label="${label}"`);
    }
  });

  it("uses one inline label/value wrapper per metric", () => {
    expect(view).toMatch(/crh-metric flex items-baseline/);
    expect(view).toMatch(/crh-label[\s\S]{0,400}crh-value/);
  });

  it("accounting reports do not render a second statistics card", () => {
    expect(view).not.toContain("<MiniStat");
    expect(view).not.toMatch(/<AuditReconcileHeader\b/);
    // Only one .compact-report-header card element exists.
    expect((view.match(/compact-report-header/g) ?? []).length).toBe(1);
  });

  it("warnings render only when warning data exists", () => {
    expect(view).toMatch(/auditResult\.docsWithoutGL\.length > 0 && \(/);
    expect(view).toMatch(/auditResult\.incompleteReasons\.length > 0 && \(/);
  });
});

describe("Correction G — Settings page structure", () => {
  it("keeps the three layout actions inside the Item Line Layout card header", () => {
    const cardStart = settings.indexOf('aria-label="Item Line Layout"');
    const headerEnd = settings.indexOf("Every one of the", cardStart);
    const header = settings.slice(cardStart, headerEnd);
    expect(header).toContain("Save Layout");
    expect(header).toContain("Cancel Changes");
    expect(header).toContain("Reset Default");
    expect(header).toMatch(/Unsaved changes/);
  });

  it("has no separate Preview card and no duplicate action bar", () => {
    expect((settings.match(/app-card/g) ?? []).length).toBe(3); // 2 cards + loading state
    expect(settings).not.toContain("Cancel Unsaved Changes");
    expect(settings).not.toContain("Reset to Default");
  });

  it("uses a two-column row editor grid on desktop", () => {
    expect(settings).toMatch(/grid gap-3 md:grid-cols-2[\s\S]{0,400}RowEditor/);
  });

  it("keeps every field exactly once across the default rows", () => {
    const all = [...DEFAULT_LAYOUT.row1, ...DEFAULT_LAYOUT.row2];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(FIELD_IDS.length);
  });

  it("keeps accessible move controls", () => {
    expect(settings).toContain("aria-label={`Move ${FIELD_LABELS[id]} up`}");
    expect(settings).toContain("aria-label={`Move ${FIELD_LABELS[id]} down`}");
    expect(settings).toContain("aria-label={`Move ${FIELD_LABELS[id]} to Row ${targetRow}`}");
  });

  it("renders the Report Print Layout controls with units", () => {
    expect(settings).toContain("Report Print Layout");
    expect(settings).toContain('label="Result font size"');
    expect(settings).toContain('label="Left margin"');
    expect(settings).toContain('label="Right margin"');
    expect(settings).toContain('unit="pt"');
    expect(settings).toContain('unit="mm"');
    expect(settings).toContain("Save Print Settings");
    expect(settings).toContain("Reset Print Defaults");
  });

  it("blocks saving invalid print settings", () => {
    expect(settings).toContain("if (!validation.ok) return;");
    expect(settings).toMatch(/disabled=\{!dirty \|\| !validation\.ok\}/);
  });

  it("draws the A4 diagram without an image asset", () => {
    expect(settings).toContain('aspectRatio: "210 / 297"');
    expect(settings).not.toMatch(/<img\b/);
  });
});
