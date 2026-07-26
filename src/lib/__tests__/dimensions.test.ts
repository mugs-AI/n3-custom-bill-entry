import { describe, it, expect } from "vitest";
import { DIMENSION_SPECS, groupByDimension, totalOf, type DimensionKey } from "../dimensions";
import type { GLDrillDownLine } from "../report-model";

// Phase 3B item 7 — one parameterized test for all six dimension groupers.
// Uses a tiny hand-crafted line set with known totals per grouping so the
// same fixture proves reconciliation for every dimension.

function line(overrides: Partial<GLDrillDownLine>): GLDrillDownLine {
  return {
    invoiceId: "I1",
    docCode: "PI001",
    docDate: "2026-07-24",
    isCancelled: false,
    supplierId: 1,
    supplierCode: "S1",
    supplierName: "Sup 1",
    supplierInvNo: "",
    hqSequence: "HQA",
    purchaserId: 1,
    purchaserCode: "P1",
    purchaserName: "Buyer 1",
    paymentType: "CASH",
    glAccountId: "g1",
    glAccountCode: "6110",
    glAccountName: "Materials",
    projectId: 10,
    projectCode: "PJX",
    stockId: 100,
    stockCode: "WBS-A",
    itemDescription: "Cement",
    taxCodeId: 5,
    taxCodeCode: "PT-5%",
    tariffCodeId: 1,
    tariffCode: "TC-1",
    tariffDescription: "Tariff 1",
    qty: 1,
    unitPrice: 100,
    beforeTax: 100,
    taxAmount: 5,
    includingTax: 105,
    referenceNo: "ORD-9",
    pos: 1,
    ...overrides,
  };
}

const LINES: GLDrillDownLine[] = [
  line({}),
  line({ invoiceId: "I1", pos: 2, stockId: 100, stockCode: "WBS-A", beforeTax: 200, taxAmount: 10, includingTax: 210 }),
  line({
    invoiceId: "I2",
    docCode: "PI002",
    stockId: 200,
    stockCode: "WBS-B",
    hqSequence: "HQB",
    projectId: 20,
    projectCode: "PJY",
    referenceNo: "ORD-10",
    purchaserId: 2,
    purchaserCode: "P2",
    purchaserName: "Buyer 2",
    paymentType: "CREDIT",
    tariffCodeId: 2,
    tariffCode: "TC-2",
    tariffDescription: "Tariff 2",
    taxCodeId: 6,
    taxCodeCode: "PT-10%",
    beforeTax: 600,
    taxAmount: 60,
    includingTax: 660,
  }),
  // cancelled line — must be excluded from every dimension.
  line({ invoiceId: "I3", isCancelled: true, beforeTax: 9999, taxAmount: 9999, includingTax: 9999 }),
  // blank-key line for hq-sequence & order-number & payment-type.
  line({
    invoiceId: "I4",
    docCode: "PI003",
    hqSequence: "",
    referenceNo: "",
    stockId: null,
    stockCode: "",
    projectId: null,
    projectCode: "",
    purchaserId: null,
    purchaserCode: "",
    purchaserName: "",
    paymentType: "",
    tariffCodeId: null,
    tariffCode: "",
    tariffDescription: "",
    taxCodeId: null,
    taxCodeCode: "",
    beforeTax: 50,
    taxAmount: 5,
    includingTax: 55,
  }),
];

const dims: DimensionKey[] = [
  "wbs",
  "hq-sequence",
  "cost-centre",
  "order-number",
  "payment-type",
  "hq-tax",
];

describe.each(dims)("groupByDimension(%s)", (dim) => {
  it("reconciles to the same grand totals as the raw non-cancelled lines", () => {
    const rows = groupByDimension(LINES, dim);
    const totals = totalOf(rows);
    // Expected: sum of every non-cancelled line.
    const alive = LINES.filter((l) => !l.isCancelled);
    const expected = {
      beforeTax: alive.reduce((a, l) => a + l.beforeTax, 0),
      taxAmount: alive.reduce((a, l) => a + l.taxAmount, 0),
      includingTax: alive.reduce((a, l) => a + l.includingTax, 0),
    };
    expect(totals.beforeTax).toBeCloseTo(expected.beforeTax, 2);
    expect(totals.taxAmount).toBeCloseTo(expected.taxAmount, 2);
    expect(totals.includingTax).toBeCloseTo(expected.includingTax, 2);
    // Sorted descending by includingTax.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].includingTax).toBeGreaterThanOrEqual(rows[i].includingTax);
    }
  });

  it("exposes a DimensionSpec with the required labels", () => {
    const spec = DIMENSION_SPECS[dim];
    expect(spec.title).toBeTruthy();
    expect(spec.source).toBeTruthy();
    expect(spec.codeHeader).toBeTruthy();
    expect(spec.descriptionHeader).toBeTruthy();
  });
});
