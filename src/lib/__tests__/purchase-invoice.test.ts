import { describe, expect, it } from "vitest";
import {
  extractPurchaseInvoiceDetails,
  PurchaseInvoiceMappingError,
  unwrapPurchaseInvoice,
  type PurchaseInvoice,
} from "../purchase-invoice";
import { mapInvoiceToLines } from "../report-model";
import {
  buildPurchaseHistoryRequest,
  reconcileInvoiceTotals,
  unwrapPurchaseHistory,
  type PurchaseHistoryArrayApiResponse,
} from "../purchase-history";

// -------- Fixtures shaped exactly like live N3 payloads (Task 1 + Task 2) --------
// Reporting API — PurchaseHistoryArrayApiResponse for docCode M1B2607002Ikeyinn3.
const PH_FIXTURE: PurchaseHistoryArrayApiResponse = {
  success: true,
  code: "0000",
  data: [
    {
      documentId: "inv-uuid",
      docCode: "M1B2607002Ikeyinn3",
      docType: "PINV",
      docDate: "2026-07-24T00:00:00",
      pos: 1,
      isCancelled: false,
      taxExclusiveAmountLocal: 100,
      taxAmountLocal: 5,
      amountLocal: 105,
    },
    {
      documentId: "inv-uuid",
      docCode: "M1B2607002Ikeyinn3",
      docType: "PINV",
      docDate: "2026-07-24T00:00:00",
      pos: 2,
      isCancelled: false,
      taxExclusiveAmountLocal: 100,
      taxAmountLocal: 10,
      amountLocal: 110,
    },
    {
      documentId: "inv-uuid",
      docCode: "M1B2607002Ikeyinn3",
      docType: "PINV",
      docDate: "2026-07-24T00:00:00",
      pos: 3,
      isCancelled: false,
      taxExclusiveAmountLocal: 400,
      taxAmountLocal: 40,
      amountLocal: 440,
    },
  ],
};

// Main API — PurchaseInvoiceDto envelope for the same invoice (itemDetails).
const MAIN_INVOICE_ENVELOPE = {
  success: true,
  code: "0000",
  data: {
    id: "inv-uuid",
    docCode: "M1B2607002Ikeyinn3",
    docDate: "2026-07-24T00:00:00",
    isCancelled: false,
    supplierId: 1,
    supplier: { code: "S001", name: "Alpha" },
    itemDetails: [
      {
        id: "l1",
        pos: 1,
        accountId: "gl-uuid",
        account: { code: "300-9000", name: "Purchases" },
        description: "Line 1",
        qty: 1,
        unitPrice: 100,
        subAmount: 100,
        taxAmount: 5,
        netAmount: 105,
      },
      {
        id: "l2",
        pos: 2,
        accountId: "gl-uuid",
        account: { code: "300-9000", name: "Purchases" },
        description: "Line 2",
        qty: 1,
        unitPrice: 100,
        subAmount: 100,
        taxAmount: 10,
        netAmount: 110,
      },
      {
        id: "l3",
        pos: 3,
        accountId: "gl-uuid",
        account: { code: "300-9000", name: "Purchases" },
        description: "Line 3",
        qty: 1,
        unitPrice: 400,
        netAmount: 40,
        taxAmount: 440,
        subAmount: 400,
      },
    ],
    details: [], // BillDetailDto side is empty — this used to cause "0 lines"
  },
};

describe("unwrapPurchaseHistory + reconcileInvoiceTotals", () => {
  it("unwraps rows from the standard data[] envelope", () => {
    expect(unwrapPurchaseHistory(PH_FIXTURE)).toHaveLength(3);
  });
  it("sends docType:[PINV] and includeCancelled:false", () => {
    const req = buildPurchaseHistoryRequest("2026-07-24", "2026-07-24");
    expect(req.filter.docType).toEqual(["PINV"]);
    expect(req.filter.includeCancelled).toBe(false);
    expect(req.options).toBeNull();
  });
  it("reconciles three rows to 600.00 / 55.00 / 655.00", () => {
    const rows = unwrapPurchaseHistory(PH_FIXTURE);
    const r = reconcileInvoiceTotals(rows, "M1B2607002Ikeyinn3");
    expect(r.lineCount).toBe(3);
    expect(r.beforeTax).toBe(600);
    expect(r.taxAmount).toBe(55);
    expect(r.includingTax).toBe(655);
  });
});

describe("unwrapPurchaseInvoice + extractPurchaseInvoiceDetails", () => {
  it("unwraps the main envelope once and preserves invoice id", () => {
    const inv = unwrapPurchaseInvoice(MAIN_INVOICE_ENVELOPE);
    expect(inv.id).toBe("inv-uuid");
    expect(inv.docCode).toBe("M1B2607002Ikeyinn3");
  });
  it("prefers itemDetails (PurchaseInvoiceDetailDto) over empty details", () => {
    const inv = unwrapPurchaseInvoice(MAIN_INVOICE_ENVELOPE);
    const details = extractPurchaseInvoiceDetails(inv);
    expect(details).toHaveLength(3);
    expect(details.every((d) => d.account?.code === "300-9000")).toBe(true);
  });
  it("treats an explicit empty itemDetails+details as a genuinely empty invoice", () => {
    const inv: PurchaseInvoice = { id: "x", docCode: "X", itemDetails: [], details: [] };
    expect(extractPurchaseInvoiceDetails(inv)).toEqual([]);
  });
  it("throws a sanitized error when both arrays are missing", () => {
    const inv: PurchaseInvoice = { id: "x", docCode: "M1B2607002Ikeyinn3" };
    expect(() => extractPurchaseInvoiceDetails(inv)).toThrow(PurchaseInvoiceMappingError);
    try {
      extractPurchaseInvoiceDetails(inv);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("M1B2607002Ikeyinn3");
      expect(msg).not.toMatch(/token|Bearer|http/i);
    }
  });
  it("falls back to details when itemDetails is empty but details has rows", () => {
    const inv: PurchaseInvoice = {
      id: "x",
      docCode: "X",
      itemDetails: [],
      details: [{ id: "d1", pos: 1, netAmount: 10, taxAmount: 0, subAmount: 10 }],
    };
    expect(extractPurchaseInvoiceDetails(inv)).toHaveLength(1);
  });
});

describe("mapInvoiceToLines via shared extractor (acceptance invoice)", () => {
  it("maps three lines all posted to GL 300-9000 with reconciled totals", () => {
    const inv = unwrapPurchaseInvoice(MAIN_INVOICE_ENVELOPE);
    const rows = mapInvoiceToLines(inv);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.glAccountCode === "300-9000")).toBe(true);
    const sum = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(sum(rows.map((r) => r.beforeTax))).toBe(600);
    expect(sum(rows.map((r) => r.taxAmount))).toBe(55);
    expect(sum(rows.map((r) => r.includingTax))).toBe(655);
  });
  it("throws instead of returning [] when the invoice is missing detail arrays", () => {
    expect(() =>
      mapInvoiceToLines({ id: "inv-1", docCode: "M1B2607002Ikeyinn3" }),
    ).toThrow(PurchaseInvoiceMappingError);
  });
});
