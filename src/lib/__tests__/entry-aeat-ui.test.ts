import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("New Bill entry clarity refinements", () => {
  it("uses the requested accounting clerk field labels", () => {
    const src = read("src/lib/item-layout.ts");
    expect(src).toContain('wbs: "WBS (Stock)"');
    expect(src).toContain('itemDescription: "Claim / Contract No. (Stock Name)"');
    expect(src).toContain('costCentre: "Cost Centre (Project)"');
    expect(src).toContain('hqTax: "HQ TAX (SST)"');
    expect(src).toContain('orderNo: "Order No. (Tariff)"');
  });

  it("makes HQ Tax and Order No shorter while Ref No is wider", () => {
    const src = read("src/routes/index.tsx");
    expect(src).toContain('const shortSelectClass = "min-w-[135px] flex-[0.8_1_145px]"');
    expect(src).toContain('const refWideClass = "min-w-[190px] flex-[1.8_1_220px]"');
    expect(src).toMatch(/case "hqTax":[\s\S]{0,100}shortSelectClass/);
    expect(src).toMatch(/case "orderNo":[\s\S]{0,220}shortSelectClass/);
    expect(src).toMatch(/case "refNo":[\s\S]{0,100}refWideClass/);
  });

  it("keeps the New Bill header compact and totals on one responsive row", () => {
    const src = read("src/routes/index.tsx");
    expect(src).toContain('<div className="app-card p-3">');
    expect(src).toContain('grid grid-cols-1 gap-2.5 md:grid-cols-3');
    expect(src).toContain("Sub Total (MYR)");
    expect(src).toContain("Tax (MYR)");
    expect(src).toContain("Grand Total (MYR)");
    expect(src).toContain("flex flex-wrap items-center justify-end gap-x-8");
  });
});

describe("AEAT interaction refinements", () => {
  it("defaults Breakdown credit side to ON and exports the current mode", () => {
    const src = read("src/routes/reports_.purchase.$view.tsx");
    expect(src).toContain("const [breakdownCreditSide, setBreakdownCreditSide] = useState(true)");
    expect(src).toContain("Breakdown credit side");
    expect(src).toContain("buildAdvancedExpenditureAuditRows(report, result, { breakdownCreditSide })");
    expect(src).toContain("buildAdvancedExpenditureExcelXml(rows)");
  });
});
