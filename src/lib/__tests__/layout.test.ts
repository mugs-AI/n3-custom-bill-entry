import { describe, it, expect } from "vitest";
import { coerceLayout, DEFAULT_LAYOUT, LAYOUT_SCHEMA_VERSION } from "../item-layout";

describe("item-layout migration", () => {
  it("v1 layout without taxAmount is upgraded and Tax Amt appended to row 2", () => {
    const v1 = {
      schemaVersion: 1,
      row1: ["wbs", "itemDescription", "glAccount", "glAccountName", "costCentre"],
      row2: ["hqTax", "orderNo", "qty", "unitPrice", "netAmount", "refNo"],
    };
    const out = coerceLayout(v1);
    expect(out.schemaVersion).toBe(LAYOUT_SCHEMA_VERSION);
    expect([...out.row1, ...out.row2]).toContain("taxAmount");
    expect(out.row2).toContain("taxAmount");
  });

  it("Tax Amt appears exactly once across both rows", () => {
    const out = coerceLayout(DEFAULT_LAYOUT);
    const all = [...out.row1, ...out.row2];
    expect(all.filter((f) => f === "taxAmount")).toHaveLength(1);
  });

  it("invalid input falls back to default", () => {
    const out = coerceLayout(null);
    expect(out).toEqual(DEFAULT_LAYOUT);
  });

  it("duplicates are removed", () => {
    const out = coerceLayout({
      schemaVersion: 2,
      row1: ["wbs", "wbs", "itemDescription"],
      row2: ["qty"],
    });
    const all = [...out.row1, ...out.row2];
    expect(new Set(all).size).toBe(all.length);
  });
});
