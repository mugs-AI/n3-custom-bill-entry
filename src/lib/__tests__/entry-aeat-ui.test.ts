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
    expect(src).toContain('<div className="app-card p-2.5">');
    expect(src).toContain("grid grid-cols-1 gap-2 lg:grid-cols-4");
    expect(src).toContain("Sub Total (MYR)");
    expect(src).toContain("Tax (MYR)");
    expect(src).toContain("Grand Total (MYR)");
    expect(src).toContain("flex flex-wrap items-center justify-end gap-x-8");
  });

  it("moves page help into an info popover and secondary supplier details into a right drawer", () => {
    const src = read("src/routes/index.tsx");
    expect(src).toContain("function InfoPopover");
    expect(src).toContain(
      'label={isEdit ? "About editing this Purchase Invoice" : "About New Bill Entry"}',
    );
    expect(src).toContain("Supplier details / Term");
    expect(src).toContain('aria-label="Supplier details and term"');
    expect(src).toContain("Secondary supplier information is kept here");
    expect(src).toContain("supplierDetailsOpen");
  });

  it("removes the per-line header strip and uses a compact delete icon", () => {
    const src = read("src/routes/index.tsx");
    expect(src).toContain('className="space-y-1.5 p-2 pr-9"');
    expect(src).toContain("Delete item ${index + 1}");
    expect(src).toContain("×");
    expect(src).not.toContain("Item {index + 1}");
  });

  it("puts Back to History, Discard changes and Update in N3 in the BillForm action row", () => {
    const form = read("src/routes/index.tsx");
    const edit = read("src/routes/purchase-invoices.$id.edit.tsx");
    expect(form).toContain("showBackToHistory");
    expect(form).toContain("Back to History");
    expect(form).toContain("Discard changes");
    expect(form).toContain("Update in N3");
    expect(edit).toContain("showBackToHistory");
    expect(edit).not.toContain('className="mb-3 flex items-center justify-end"');
  });
});

describe("AEAT screen-fit refinements", () => {
  it("renames the AEAT period label and fits the result table without a desktop min-width", () => {
    const src = read("src/routes/reports_.purchase.$view.tsx");
    expect(src).toContain(
      'periodLabel={viewId === "advanced-expenditure-audit" ? "From > To" : "Period"}',
    );
    expect(src).toContain('className="aeat-table w-full table-fixed text-left text-[12px]"');
    expect(src).toContain("aeatScreenLabel(column)");
    expect(src).toContain('return "w-[12%]"');
    expect(src).not.toContain("min-w-[1450px]");
  });

  it("wraps long AEAT values so WBS Element remains readable on screen", () => {
    const src = read("src/routes/reports_.purchase.$view.tsx");
    expect(src).toContain("whitespace-normal break-words");
    expect(src).toContain("title={rendered}");
  });
});

describe("AEAT interaction refinements", () => {
  it("defaults Breakdown credit side to ON and exports the current mode", () => {
    const src = read("src/routes/reports_.purchase.$view.tsx");
    expect(src).toContain("const [breakdownCreditSide, setBreakdownCreditSide] = useState(true)");
    expect(src).toContain("Breakdown credit side");
    expect(src).toContain(
      "buildAdvancedExpenditureAuditRows(report, result, { breakdownCreditSide })",
    );
    expect(src).toContain("buildAdvancedExpenditureExcelXml(rows, visibleColumns)");
  });
});
