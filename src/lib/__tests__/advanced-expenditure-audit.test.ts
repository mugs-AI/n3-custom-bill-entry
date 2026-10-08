import { describe, expect, it } from "vitest";
import {
  AEAT_EXCEL_COLUMNS,
  advancedExpenditureTotals,
  aeatScreenLabel,
  buildAdvancedExpenditureAuditRows,
  buildAdvancedExpenditureCsv,
  buildAdvancedExpenditureExcelXml,
  getAdvancedExpenditureColumns,
} from "../advanced-expenditure-audit";
import type { PurchaseAuditResult } from "../audit-trail";
import type { GLDrillDownLine, ReportData } from "../report-model";

function line(
  patch: Partial<GLDrillDownLine> & Pick<GLDrillDownLine, "invoiceId" | "glAccountCode">,
): GLDrillDownLine {
  return {
    invoiceId: patch.invoiceId,
    docCode: patch.docCode ?? patch.invoiceId,
    docDate: patch.docDate ?? "2026-10-01",
    isCancelled: patch.isCancelled ?? false,
    supplierId: patch.supplierId ?? 1,
    supplierCode: patch.supplierCode ?? "800-1001",
    supplierName: patch.supplierName ?? "Supplier",
    supplierInvNo: patch.supplierInvNo ?? "",
    hqSequence: patch.hqSequence ?? "",
    purchaserId: patch.purchaserId ?? null,
    purchaserCode: patch.purchaserCode ?? "",
    purchaserName: patch.purchaserName ?? "",
    paymentType: patch.paymentType ?? "",
    glAccountId: patch.glAccountId ?? patch.glAccountCode,
    glAccountCode: patch.glAccountCode,
    glAccountName: patch.glAccountName ?? "Expense",
    projectId: patch.projectId ?? null,
    projectCode: patch.projectCode ?? "",
    stockId: patch.stockId ?? null,
    stockCode: patch.stockCode ?? "",
    itemDescription: patch.itemDescription ?? "",
    taxCodeId: patch.taxCodeId ?? null,
    taxCodeCode: patch.taxCodeCode ?? "P5",
    tariffCodeId: patch.tariffCodeId ?? null,
    tariffCode: patch.tariffCode ?? "",
    tariffDescription: patch.tariffDescription ?? "",
    qty: patch.qty ?? 1,
    unitPrice: patch.unitPrice ?? patch.beforeTax ?? 0,
    beforeTax: patch.beforeTax ?? 0,
    taxAmount: patch.taxAmount ?? 0,
    includingTax: patch.includingTax ?? patch.beforeTax ?? 0,
    referenceNo: patch.referenceNo ?? "",
    pos: patch.pos ?? 1,
  };
}

function report(lines: GLDrillDownLine[]): ReportData {
  const total = lines.reduce((n, x) => n + x.beforeTax, 0);
  return {
    criteria: { dateFrom: "2026-10-01", dateTo: "2026-10-31" },
    summary: {
      glAccountsCount: new Set(lines.map((x) => x.glAccountCode)).size,
      invoiceCount: new Set(lines.map((x) => x.invoiceId)).size,
      lineCount: lines.length,
      beforeTax: total,
      taxAmount: 0,
      includingTax: total,
    },
    groups: [],
    lines,
    matchedInvoiceCount: new Set(lines.map((x) => x.invoiceId)).size,
    fetchedInvoiceCount: new Set(lines.map((x) => x.invoiceId)).size,
    overLimit: false,
  };
}

function audit(): PurchaseAuditResult {
  return {
    documents: [
      {
        invoiceId: "i1",
        docCode: "i1",
        docDate: "2026-10-01",
        supplierCode: "800-1001",
        supplierName: "Supplier A",
        termDescription: "",
        dueDate: "",
        currencyCode: "MYR",
        currencyRate: 1,
        creditor: {
          accountCode: "800-1001",
          accountName: "Supplier A",
          currencyCode: "MYR",
          currencyRate: 1,
          debit: 0,
          credit: 100,
          isSupplierCreditor: true,
          isTaxPosting: false,
        },
        postings: [],
        debit: 100,
        credit: 100,
        balanced: true,
        incomplete: false,
      },
    ],
    postingAccounts: [],
    grandDebit: 100,
    grandCredit: 100,
    balanced: true,
    balanceStatus: "balanced",
    isComplete: true,
    incompleteReasons: [],
    auditDocCodes: ["i1"],
    glRowsUsed: 2,
    docsWithoutGL: [],
  };
}

describe("Advanced Expenditure Audit Trail", () => {
  it("uses the exact 13 client template columns B:N in the required order", () => {
    expect(AEAT_EXCEL_COLUMNS).toEqual([
      "CO. CODE",
      "GL CODE",
      "Item Text (50)",
      "Debit",
      "Credit",
      "Amount in Company Code Currency",
      "Amount in Second Local Currency",
      "TAX CODE",
      "Tax Jurisdiction (15)",
      "Cost Center",
      "Profit Center",
      "ORDER NO.",
      "WBS ELEMENT",
    ]);
  });

  it("uses the same shortened labels on screen and in Excel/CSV", () => {
    const columns = getAdvancedExpenditureColumns();
    const byKey = new Map(columns.map((column) => [column.key, aeatScreenLabel(column)]));
    expect(byKey.get("companyCode")).toBe("CO. CODE");
    expect(byKey.get("glAccount")).toBe("GL CODE");
    expect(byKey.get("taxCode")).toBe("TAX CODE");
    expect(byKey.get("costCenter")).toBe("Cost Center");
    expect(byKey.get("profitCenter")).toBe("Profit Center");
    expect(byKey.get("orderNumber")).toBe("ORDER NO.");
    expect(byKey.get("wbsElement")).toBe("WBS ELEMENT");

    expect(columns.find((column) => column.key === "companyCode")?.label).toBe("CO. CODE");
    expect(columns.find((column) => column.key === "glAccount")?.label).toBe("GL CODE");
    expect(columns.find((column) => column.key === "taxCode")?.label).toBe("TAX CODE");
    expect(columns.find((column) => column.key === "costCenter")?.label).toBe("Cost Center");
    expect(columns.find((column) => column.key === "profitCenter")?.label).toBe("Profit Center");
    expect(columns.find((column) => column.key === "orderNumber")?.label).toBe("ORDER NO.");
    expect(columns.find((column) => column.key === "wbsElement")?.label).toBe("WBS ELEMENT");
  });

  it("hides the three optional AEAT columns by default and preserves canonical order when enabled", () => {
    const defaults = getAdvancedExpenditureColumns();
    expect(defaults.map((c) => c.label)).toEqual([
      "CO. CODE",
      "GL CODE",
      "Item Text (50)",
      "Debit",
      "Credit",
      "TAX CODE",
      "Cost Center",
      "Profit Center",
      "ORDER NO.",
      "WBS ELEMENT",
    ]);

    const shown = getAdvancedExpenditureColumns(["companyCurrencyAmount", "jurisdiction"]);
    expect(shown.map((c) => c.label)).toEqual([
      "CO. CODE",
      "GL CODE",
      "Item Text (50)",
      "Debit",
      "Credit",
      "Amount in Company Code Currency",
      "TAX CODE",
      "Tax Jurisdiction (15)",
      "Cost Center",
      "Profit Center",
      "ORDER NO.",
      "WBS ELEMENT",
    ]);
  });

  it("keeps the same GL separate when Cost Centre differs, including A-NIL", () => {
    const rows = buildAdvancedExpenditureAuditRows(
      report([
        line({
          invoiceId: "i1",
          glAccountCode: "210104",
          itemDescription: "Non-Cash",
          projectCode: "50000850",
          beforeTax: 10,
        }),
        line({
          invoiceId: "i2",
          glAccountCode: "210104",
          itemDescription: "Non-Cash",
          projectCode: "A-NIL",
          beforeTax: 20,
        }),
      ]),
      null,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.costCenter, r.profitCenter, r.debit])).toEqual([
      ["50000850", "50000850", 10],
      ["A-NIL", "A-NIL", 20],
    ]);
  });

  it("keeps the same GL separate when Item Text differs", () => {
    const rows = buildAdvancedExpenditureAuditRows(
      report([
        line({
          invoiceId: "i1",
          glAccountCode: "211317",
          itemDescription: "HQIADS-2627-0348",
          beforeTax: 1000,
        }),
        line({
          invoiceId: "i2",
          glAccountCode: "211317",
          itemDescription: "HQIADS-2627-0355",
          beforeTax: 600,
        }),
      ]),
      null,
    );
    expect(rows.map((r) => [r.itemText, r.debit])).toEqual([
      ["HQIADS-2627-0348", 1000],
      ["HQIADS-2627-0355", 600],
    ]);
  });

  it("keeps different N3 Stock Codes separate and exports code only as WBS Element", () => {
    const rows = buildAdvancedExpenditureAuditRows(
      report([
        line({
          invoiceId: "i1",
          glAccountCode: "211900",
          itemDescription: "HQIADS",
          stockCode: "C-0000623-01-09",
          beforeTax: 100,
        }),
        line({
          invoiceId: "i2",
          glAccountCode: "211900",
          itemDescription: "HQIADS",
          stockCode: "S-0012884-01-01",
          beforeTax: 200,
        }),
      ]),
      null,
    );
    expect(rows.map((r) => r.wbsElement)).toEqual(["C-0000623-01-09", "S-0012884-01-01"]);
  });

  it("aggregates only identical GL + item + cost centre + WBS + HQ Tax rows", () => {
    const rows = buildAdvancedExpenditureAuditRows(
      report([
        line({
          invoiceId: "i1",
          glAccountCode: "200007",
          itemDescription: "Non- Cash Payment IR 4 26-27",
          projectCode: "50000850",
          stockCode: "",
          taxCodeCode: "P5",
          beforeTax: 500,
        }),
        line({
          invoiceId: "i2",
          glAccountCode: "200007",
          itemDescription: "Non- Cash Payment IR 4 26-27",
          projectCode: "50000850",
          stockCode: "",
          taxCodeCode: "P5",
          beforeTax: 731.4,
        }),
      ]),
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyCode: "1000",
      glAccount: "200007",
      itemText: "Non- Cash Payment IR 4 26-27",
      debit: 1231.4,
      companyCurrencyAmount: "",
      secondLocalCurrencyAmount: "",
      taxCode: "P5",
      jurisdiction: "",
      costCenter: "50000850",
      profitCenter: "50000850",
      orderNumber: "",
      wbsElement: "",
    });
  });

  it("uses the existing reconciled creditor posting for credit rows", () => {
    const rows = buildAdvancedExpenditureAuditRows(
      report([
        line({
          invoiceId: "i1",
          glAccountCode: "200007",
          itemDescription: "Expense",
          taxCodeCode: "P5",
          beforeTax: 100,
        }),
      ]),
      audit(),
    );
    expect(rows).toContainEqual({
      companyCode: "1000",
      glAccount: "800-1001",
      itemText: "Supplier A",
      debit: 0,
      credit: 100,
      companyCurrencyAmount: "",
      secondLocalCurrencyAmount: "",
      taxCode: "P5",
      jurisdiction: "",
      costCenter: "",
      profitCenter: "",
      orderNumber: "",
      wbsElement: "",
    });
    expect(advancedExpenditureTotals(rows)).toEqual({ debit: 100, credit: 100 });
  });

  it("defaults Breakdown credit side to ON and preserves real creditor codes", () => {
    const rows = buildAdvancedExpenditureAuditRows(
      report([
        line({
          invoiceId: "i1",
          glAccountCode: "200007",
          itemDescription: "Expense",
          taxCodeCode: "P5",
          beforeTax: 100,
        }),
      ]),
      audit(),
    );
    const credit = rows.find((r) => r.credit > 0);
    expect(credit?.glAccount).toBe("800-1001");
    expect(credit?.itemText).toBe("Supplier A");
  });

  it("can consolidate the credit side into one truthful row with blank G/L Account", () => {
    const rows = buildAdvancedExpenditureAuditRows(
      report([
        line({
          invoiceId: "i1",
          glAccountCode: "200007",
          itemDescription: "Expense",
          taxCodeCode: "P5",
          beforeTax: 100,
        }),
      ]),
      audit(),
      { breakdownCreditSide: false },
    );
    const credits = rows.filter((r) => r.credit > 0);
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({
      companyCode: "1000",
      glAccount: "",
      itemText: "Total Credit",
      credit: 100,
      taxCode: "P5",
      costCenter: "",
      profitCenter: "",
      orderNumber: "",
      wbsElement: "",
    });
  });

  it("makes Excel and CSV follow the same visible AEAT columns", () => {
    const rows = buildAdvancedExpenditureAuditRows(
      report([
        line({
          invoiceId: "i1",
          glAccountCode: "200007",
          itemDescription: 'HQIADS, "special"',
          projectCode: "50000850",
          stockCode: "C-0000623-01-03",
          beforeTax: 100,
        }),
      ]),
      null,
    );
    const columns = getAdvancedExpenditureColumns(["jurisdiction"]);
    const xml = buildAdvancedExpenditureExcelXml(rows, columns);
    const csv = buildAdvancedExpenditureCsv(rows, columns);

    expect(xml).toContain("Tax Jurisdiction (15)");
    expect(xml).not.toContain("Amount in Company Code Currency");
    expect(xml).not.toContain("Amount in Second Local Currency");
    expect(csv.split("\r\n")[0]).toBe(
      "CO. CODE,GL CODE,Item Text (50),Debit,Credit,TAX CODE,Tax Jurisdiction (15),Cost Center,Profit Center,ORDER NO.,WBS ELEMENT",
    );
    expect(csv).toContain('"HQIADS, ""special"""');
  });

  it("exports the exact 13 AEAT columns to an Excel-compatible workbook", () => {
    const rows = buildAdvancedExpenditureAuditRows(
      report([
        line({
          invoiceId: "i1",
          glAccountCode: "200007",
          itemDescription: "HQIADS",
          projectCode: "50000850",
          stockCode: "C-0000623-01-03",
          beforeTax: 100,
        }),
      ]),
      null,
    );
    const xml = buildAdvancedExpenditureExcelXml(rows);
    for (const column of AEAT_EXCEL_COLUMNS) expect(xml).toContain(column);
    expect(xml).toContain("200007");
    expect(xml).toContain("50000850");
    expect(xml).toContain("C-0000623-01-03");
    expect(xml).toContain("CO. CODE");
    expect(xml).toContain("Amount in Company Code Currency");
    expect(xml).toContain("Amount in Second Local Currency");
    expect(xml).toContain("Tax Jurisdiction (15)");
  });
});
