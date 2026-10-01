import { describe, expect, it } from "vitest";
import {
  buildExpenditureAuditRows,
  buildExpenditurePostingSummary,
  expenditureGrandTotal,
  expenditurePostingTotals,
  expenditureVendorAccount,
} from "../expenditure-audit";
import type { PurchaseAuditResult } from "../audit-trail";
import type { ReportData } from "../report-model";

function report(): ReportData {
  return {
    criteria: { dateFrom: "2026-07-10", dateTo: "2026-07-10" },
    summary: {
      glAccountsCount: 2,
      invoiceCount: 2,
      lineCount: 3,
      beforeTax: 187489,
      taxAmount: 0,
      includingTax: 187489,
    },
    groups: [],
    matchedInvoiceCount: 2,
    fetchedInvoiceCount: 2,
    overLimit: false,
    lines: [
      {
        invoiceId: "i1",
        docCode: "BIL2609/006",
        docDate: "2026-07-10",
        isCancelled: false,
        supplierId: 1,
        supplierCode: "800-1001",
        supplierName: "19SQN MILITARY CASH OFFICE",
        supplierInvNo: "",
        hqSequence: "",
        purchaserId: null,
        purchaserCode: "",
        purchaserName: "",
        paymentType: "",
        glAccountId: "g1",
        glAccountCode: "501203",
        glAccountName: "ADFPAY SALARY ADVANCE - NAVY",
        projectId: 28,
        projectCode: "50000028",
        stockId: null,
        stockCode: "",
        itemDescription: "MILITARY CASH OFFICE 16Jun25",
        taxCodeId: null,
        taxCodeCode: "",
        tariffCodeId: null,
        tariffCode: "",
        tariffDescription: "",
        qty: 1,
        unitPrice: 2000,
        beforeTax: 2000,
        taxAmount: 0,
        includingTax: 2000,
        referenceNo: "",
        pos: 1,
      },
      {
        invoiceId: "i1",
        docCode: "BIL2609/006",
        docDate: "2026-07-10",
        isCancelled: false,
        supplierId: 1,
        supplierCode: "800-1001",
        supplierName: "19SQN MILITARY CASH OFFICE",
        supplierInvNo: "",
        hqSequence: "",
        purchaserId: null,
        purchaserCode: "",
        purchaserName: "",
        paymentType: "",
        glAccountId: "g2",
        glAccountCode: "501216",
        glAccountName: "ADFPAY SALARY ADVANCE - RAAF",
        projectId: 6,
        projectCode: "50000006",
        stockId: null,
        stockCode: "",
        itemDescription: "MILITARY CASH OFFICE 16Jun25",
        taxCodeId: null,
        taxCodeCode: "",
        tariffCodeId: null,
        tariffCode: "",
        tariffDescription: "",
        qty: 1,
        unitPrice: 30500,
        beforeTax: 30500,
        taxAmount: 0,
        includingTax: 30500,
        referenceNo: "",
        pos: 2,
      },
      {
        invoiceId: "i2",
        docCode: "BIL2609/007",
        docDate: "2026-07-10",
        isCancelled: false,
        supplierId: 2,
        supplierCode: "800-2002",
        supplierName: "RCB ADVANCE PAY",
        supplierInvNo: "",
        hqSequence: "",
        purchaserId: null,
        purchaserCode: "",
        purchaserName: "",
        paymentType: "",
        glAccountId: "g3",
        glAccountCode: "501215",
        glAccountName: "ADFPAY SALARY ADVANCE - ARMY",
        projectId: 7,
        projectCode: "50000007",
        stockId: null,
        stockCode: "",
        itemDescription: "RCB ADVANCE PAY - CASH OFFICE MAY/JUN26",
        taxCodeId: null,
        taxCodeCode: "",
        tariffCodeId: null,
        tariffCode: "",
        tariffDescription: "",
        qty: 1,
        unitPrice: 154989,
        beforeTax: 154989,
        taxAmount: 0,
        includingTax: 154989,
        referenceNo: "",
        pos: 1,
      },
    ],
  };
}

function audit(): PurchaseAuditResult {
  return {
    documents: [
      {
        invoiceId: "i1",
        docCode: "BIL2609/006",
        docDate: "2026-07-10",
        supplierCode: "800-1001",
        supplierName: "19SQN MILITARY CASH OFFICE",
        termDescription: "",
        dueDate: "",
        currencyCode: "MYR",
        currencyRate: 1,
        creditor: {
          accountCode: "800-1001",
          accountName: "19SQN MILITARY CASH OFFICE",
          currencyCode: "MYR",
          currencyRate: 1,
          debit: 0,
          credit: 32500,
          isSupplierCreditor: true,
          isTaxPosting: false,
        },
        postings: [],
        debit: 32500,
        credit: 32500,
        balanced: true,
        incomplete: false,
      },
      {
        invoiceId: "i2",
        docCode: "BIL2609/007",
        docDate: "2026-07-10",
        supplierCode: "800-2002",
        supplierName: "RCB ADVANCE PAY",
        termDescription: "",
        dueDate: "",
        currencyCode: "MYR",
        currencyRate: 1,
        creditor: {
          accountCode: "800-2002",
          accountName: "RCB ADVANCE PAY",
          currencyCode: "MYR",
          currencyRate: 1,
          debit: 0,
          credit: 154989,
          isSupplierCreditor: true,
          isTaxPosting: false,
        },
        postings: [],
        debit: 154989,
        credit: 154989,
        balanced: true,
        incomplete: false,
      },
    ],
    postingAccounts: [],
    grandDebit: 187489,
    grandCredit: 187489,
    balanced: true,
    balanceStatus: "balanced",
    isComplete: true,
    incompleteReasons: [],
    auditDocCodes: ["BIL2609/006", "BIL2609/007"],
    glRowsUsed: 5,
    docsWithoutGL: [],
  };
}

describe("Expenditure Audit Trail", () => {
  it("uses N3 line data in the old-system column model and preserves N3 document numbering", () => {
    const rows = buildExpenditureAuditRows(report());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      docCode: "BIL2609/006",
      vendorAccount: "800-1001",
      expenditureType: "501203",
      costCentre: "50000028",
      chargedToAccount: "ADFPAY SALARY ADVANCE - NAVY",
      description: "MILITARY CASH OFFICE 16Jun25",
      amount: 2000,
    });
  });

  it("applies the two client legacy creditor aliases for display only", () => {
    expect(expenditureVendorAccount("800-2002")).toBe("800-R023");
    expect(expenditureVendorAccount("800-H006")).toBe("800-H024");
    expect(expenditureVendorAccount("800-1001")).toBe("800-1001");
  });

  it("builds the old-style posting account code as GL-CostCentre and credits supplier control", () => {
    const rows = buildExpenditureAuditRows(report());
    const summary = buildExpenditurePostingSummary(rows, audit());
    expect(summary).toContainEqual({
      accountCode: "501203-50000028",
      accountName: "ADFPAY SALARY ADVANCE - NAVY",
      debit: 2000,
      credit: 0,
    });
    expect(summary).toContainEqual({
      accountCode: "800-R023",
      accountName: "RCB ADVANCE PAY",
      debit: 0,
      credit: 154989,
    });
    expect(expenditurePostingTotals(summary)).toEqual({ debit: 187489, credit: 187489 });
    expect(expenditureGrandTotal(rows)).toBe(187489);
  });

  it("deliberately uses before-tax amount under the current tax-free client contract", () => {
    const r = report();
    r.lines[0] = { ...r.lines[0], beforeTax: 100, taxAmount: 6, includingTax: 106 };
    const rows = buildExpenditureAuditRows(r);
    expect(rows[0].amount).toBe(100);
  });
});
