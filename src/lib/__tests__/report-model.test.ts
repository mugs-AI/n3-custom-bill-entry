import { describe, expect, it } from "vitest";
import {
  aggregateByGL,
  buildReportHeaderFilter,
  buildSummary,
  filterLines,
  mapBounded,
  mapInvoiceToLines,
  UNASSIGNED_CODE,
  validateCriteria,
  type GLDrillDownLine,
  type RawN3Header,
} from "../report-model";

function line(over: Partial<GLDrillDownLine>): GLDrillDownLine {
  return {
    invoiceId: "inv-1",
    docCode: "PI-1",
    docDate: "2026-07-01",
    isCancelled: false,
    supplierId: 10,
    supplierCode: "S001",
    supplierName: "Alpha",
    supplierInvNo: "INV-1",
    hqSequence: "",
    purchaserCode: "",
    purchaserName: "",
    paymentType: "",
    glAccountId: "gl-1",
    glAccountCode: "5000",
    glAccountName: "Purchases",
    projectId: 100,
    projectCode: "P1",
    stockId: 200,
    stockCode: "SKU1",
    itemDescription: "Item",
    taxCodeId: 3,
    taxCodeCode: "PT-5",
    qty: 1,
    unitPrice: 100,
    beforeTax: 100,
    taxAmount: 5,
    includingTax: 105,
    referenceNo: "",
    pos: 1,
    ...over,
  };
}

describe("validateCriteria", () => {
  it("requires both dates", () => {
    expect(validateCriteria({ dateFrom: "", dateTo: "2026-07-31" })).toMatch(/From/);
    expect(validateCriteria({ dateFrom: "2026-07-01", dateTo: "" })).toMatch(/To/);
  });
  it("rejects reversed range", () => {
    expect(
      validateCriteria({ dateFrom: "2026-07-31", dateTo: "2026-07-01" }),
    ).toMatch(/on or before/);
  });
  it("rejects non-positive IDs", () => {
    expect(
      validateCriteria({ dateFrom: "2026-07-01", dateTo: "2026-07-31", supplierId: 0 }),
    ).toMatch(/Invalid/);
  });
  it("accepts a valid criteria", () => {
    expect(validateCriteria({ dateFrom: "2026-07-01", dateTo: "2026-07-31" })).toBeNull();
  });
});

describe("buildReportHeaderFilter", () => {
  it("emits date range, cancelled=false and IDs only", () => {
    const f = buildReportHeaderFilter({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      supplierId: 42,
      purchaserId: 7,
    });
    expect(f).toBe(
      "docDate ge 2026-07-01T00:00:00Z and docDate le 2026-07-31T23:59:59Z and isCancelled eq false and supplierId eq 42 and purchaserId eq 7",
    );
  });
  it("escapes single quotes in hqSequence contains", () => {
    const f = buildReportHeaderFilter({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      hqSequence: "A'B",
    });
    expect(f).toContain("contains(tolower(description),tolower('A''B'))");
  });
  it("never references projected supplier/code path", () => {
    const f = buildReportHeaderFilter({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      supplierId: 1,
    });
    expect(f).not.toMatch(/supplier\//i);
  });
});

describe("mapInvoiceToLines", () => {
  const baseInv = (): RawN3Header => ({
    id: "inv-x",
    docCode: "PI-9",
    docDate: "2026-07-15T00:00:00Z",
    isCancelled: false,
    description: "HQ-001",
    supplierInvNo: "S-INV-1",
    supplierId: 10,
    supplier: { code: "S001", name: "Alpha" },
    purchaser: { code: "PUR1", name: "Buyer" },
    term: { code: "COD", description: "Cash" },
    details: [
      {
        id: "l1",
        pos: 1,
        accountId: "gl-1",
        account: { code: "5000", name: "Purchases" },
        stockId: 200,
        stock: { code: "SKU1", name: "Item 1" },
        projectId: 100,
        project: { code: "P1" },
        taxCodeId: 3,
        taxCode: { code: "PT-5" },
        description: "Line 1",
        qty: 2,
        unitPrice: 50,
        netAmount: 100,
        taxAmount: 5,
        subAmount: 105,
      },
    ],
  });

  it("PT-5% exclusive stored line yields 100 / 5 / 105", () => {
    const [row] = mapInvoiceToLines(baseInv());
    expect(row.beforeTax).toBe(100);
    expect(row.taxAmount).toBe(5);
    expect(row.includingTax).toBe(105);
  });

  it("tax-inclusive stored line uses persisted subAmount without adding tax twice", () => {
    const inv = baseInv();
    inv.details![0] = {
      ...inv.details![0],
      // N3 already split gross into net+tax; subAmount is the gross.
      netAmount: 95.24,
      taxAmount: 4.76,
      subAmount: 100,
    };
    const [row] = mapInvoiceToLines(inv);
    expect(row.beforeTax).toBe(95.24);
    expect(row.taxAmount).toBe(4.76);
    expect(row.includingTax).toBe(100);
  });

  it("cancelled invoices produce no lines", () => {
    const inv = baseInv();
    inv.isCancelled = true;
    expect(mapInvoiceToLines(inv)).toEqual([]);
  });

  it("missing GL Account routes into UNASSIGNED with placeholder", () => {
    const inv = baseInv();
    inv.details![0].accountId = null;
    inv.details![0].account = null;
    const [row] = mapInvoiceToLines(inv);
    expect(row.glAccountCode).toBe(UNASSIGNED_CODE);
  });

  it("falls back to itemDetails when details missing", () => {
    const inv = baseInv();
    inv.itemDetails = inv.details;
    delete inv.details;
    expect(mapInvoiceToLines(inv)).toHaveLength(1);

  // Anti-swap guardrail (Phase 3B Prerequisite Task 1). Locks the mapping so
  // beforeTax always comes from netAmount and includingTax from subAmount,
  // never the reverse.
  it("field mapping: beforeTax<-netAmount, taxAmount<-taxAmount, includingTax<-subAmount", () => {
    const inv: RawN3Header = {
      id: "inv-accept",
      docCode: "M1B2607002Ikeyinn3",
      docDate: "2026-07-24T00:00:00Z",
      isCancelled: false,
      itemDetails: [
        { id: "l1", pos: 1, accountId: "gl", account: { code: "300-9000", name: "P" },
          netAmount: 100, taxAmount: 5, subAmount: 105 },
        { id: "l2", pos: 2, accountId: "gl", account: { code: "300-9000", name: "P" },
          netAmount: 200, taxAmount: 20, subAmount: 220 },
        { id: "l3", pos: 3, accountId: "gl", account: { code: "300-9000", name: "P" },
          netAmount: 600, taxAmount: 60, subAmount: 660 },
      ],
    };
    const rows = mapInvoiceToLines(inv);
    expect(rows.map((r) => r.beforeTax)).toEqual([100, 200, 600]);
    expect(rows.map((r) => r.taxAmount)).toEqual([5, 20, 60]);
    expect(rows.map((r) => r.includingTax)).toEqual([105, 220, 660]);
    // Reject any swap: beforeTax total must be strictly less than includingTax.
    const sumB = rows.reduce((a, r) => a + r.beforeTax, 0);
    const sumI = rows.reduce((a, r) => a + r.includingTax, 0);
    expect(sumB).toBe(900);
    expect(sumI).toBe(985);
    expect(sumB).toBeLessThan(sumI);
  });
});

describe("aggregateByGL", () => {
  it("groups multiple lines with the same GL Account Code", () => {
    const lines = [
      line({ beforeTax: 100, taxAmount: 5, includingTax: 105 }),
      line({ beforeTax: 50, taxAmount: 2.5, includingTax: 52.5 }),
    ];
    const groups = aggregateByGL(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].glAccountCode).toBe("5000");
    expect(groups[0].beforeTax).toBe(150);
    expect(groups[0].taxAmount).toBe(7.5);
    expect(groups[0].includingTax).toBe(157.5);
    expect(groups[0].lineCount).toBe(2);
  });

  it("does not split a business group when name casing differs", () => {
    const lines = [
      line({ glAccountName: "Purchases" }),
      line({ glAccountName: "PURCHASES" }),
    ];
    const groups = aggregateByGL(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].glAccountName).toBe("Purchases");
  });

  it("counts distinct invoices per group", () => {
    const lines = [
      line({ invoiceId: "a" }),
      line({ invoiceId: "a" }),
      line({ invoiceId: "b" }),
    ];
    expect(aggregateByGL(lines)[0].invoiceCount).toBe(2);
  });

  it("keeps UNASSIGNED lines in reconciliation", () => {
    const lines = [
      line({ beforeTax: 100, taxAmount: 5, includingTax: 105 }),
      line({
        glAccountId: null,
        glAccountCode: UNASSIGNED_CODE,
        glAccountName: "(No GL Account)",
        beforeTax: 10,
        taxAmount: 0,
        includingTax: 10,
      }),
    ];
    const groups = aggregateByGL(lines);
    expect(groups).toHaveLength(2);
    const codes = groups.map((g) => g.glAccountCode).sort();
    expect(codes).toEqual(["5000", UNASSIGNED_CODE]);
  });

  it("sorts descending by including-tax by default", () => {
    const groups = aggregateByGL([
      line({ glAccountCode: "A", includingTax: 10, beforeTax: 10, taxAmount: 0 }),
      line({ glAccountCode: "B", includingTax: 200, beforeTax: 200, taxAmount: 0 }),
      line({ glAccountCode: "C", includingTax: 50, beforeTax: 50, taxAmount: 0 }),
    ]);
    expect(groups.map((g) => g.glAccountCode)).toEqual(["B", "C", "A"]);
  });

  it("preserves negative values", () => {
    const groups = aggregateByGL([line({ beforeTax: -100, taxAmount: -5, includingTax: -105 })]);
    expect(groups[0].includingTax).toBe(-105);
  });
});

describe("buildSummary", () => {
  it("summary equals the sum of GL groups", () => {
    const lines = [
      line({ glAccountCode: "A", beforeTax: 100, taxAmount: 5, includingTax: 105 }),
      line({
        glAccountCode: "B",
        invoiceId: "inv-2",
        beforeTax: 50,
        taxAmount: 3,
        includingTax: 53,
      }),
    ];
    const groups = aggregateByGL(lines);
    const s = buildSummary(lines, groups);
    expect(s.glAccountsCount).toBe(2);
    expect(s.invoiceCount).toBe(2);
    expect(s.lineCount).toBe(2);
    expect(s.beforeTax).toBe(150);
    expect(s.taxAmount).toBe(8);
    expect(s.includingTax).toBe(158);
  });
});

describe("filterLines", () => {
  const c = { dateFrom: "2026-07-01", dateTo: "2026-07-31" } as const;
  it("keeps only matching project/stock/tax", () => {
    const lines = [
      line({ projectId: 1 }),
      line({ projectId: 2 }),
      line({ projectId: 2, stockId: 999 }),
    ];
    expect(filterLines(lines, { ...c, projectId: 2 })).toHaveLength(2);
    expect(filterLines(lines, { ...c, projectId: 2, stockId: 999 })).toHaveLength(1);
  });
  it("drops cancelled lines even if a mapper leaked them", () => {
    expect(filterLines([line({ isCancelled: true })], c)).toHaveLength(0);
  });
});

describe("mapBounded", () => {
  it("never exceeds concurrency 3", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);
    await mapBounded(items, 3, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return i;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("clamps requested concurrency to the 3-worker safety cap", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapBounded([1, 2, 3, 4, 5, 6, 7, 8], 25, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
});
