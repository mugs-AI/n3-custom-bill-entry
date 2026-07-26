import { describe, it, expect } from "vitest";
import {
  buildAuditDocuments,
  computeAuditDocCodes,
  reconcileAudit,
  type GLRow,
} from "../audit-trail";
import type { PurchaseBookDetailItem, PurchaseBookPostingSummaryRow } from "../purchase-book";

// Phase 3B item 6 — per-document Debit/Credit balance and grand-total balance.
// Also covers items 5 (amount mapping semantics preserved via straight passthrough)
// and the sign-convention detection in the posting-summary reconciliation.

const PB_DETAILS: PurchaseBookDetailItem[] = [
  {
    docCode: "PI-A",
    docDate: "2026-07-24",
    isCancelled: false,
    supplierCode: "S100",
    supplierName: "Acme Supplies",
    termDescription: "30 Days",
    dueDate: "2026-08-23",
  },
  {
    docCode: "PI-B",
    docDate: "2026-07-25",
    isCancelled: false,
    supplierCode: "S200",
    supplierName: "Beta Corp",
  },
  { docCode: "PI-C", docDate: "2026-07-26", isCancelled: true, supplierCode: "S300" },
];

const GL_ROWS: GLRow[] = [
  // PI-A: creditor (S100), materials, tax — balances 105/105
  { docCode: "PI-A", accountCode: "S100", accountName: "Acme Supplies", debitLocal: 0, creditLocal: 105 },
  { docCode: "PI-A", accountCode: "6110", accountName: "Materials", debitLocal: 100, creditLocal: 0 },
  { docCode: "PI-A", accountCode: "5210", accountName: "Input Tax", debitLocal: 5, creditLocal: 0 },
  // PI-B: creditor (S200), materials — balances 200/200
  { docCode: "PI-B", accountCode: "S200", accountName: "Beta Corp", debitLocal: 0, creditLocal: 200 },
  { docCode: "PI-B", accountCode: "6110", accountName: "Materials", debitLocal: 200, creditLocal: 0 },
  // cancelled must be ignored:
  { docCode: "PI-C", accountCode: "S300", debitLocal: 0, creditLocal: 500, isCancelled: true },
];

const PB_SUMMARY: PurchaseBookPostingSummaryRow[] = [
  { accountCode: "S100", amount: -105 },
  { accountCode: "S200", amount: -200 },
  { accountCode: "6110", amount: 300 },
  { accountCode: "5210", amount: 5 },
];

describe("Purchase Audit Trail reconciliation", () => {
  it("computes the intersection of PB and PI doc sets, ignoring cancelled PB rows", () => {
    const r = computeAuditDocCodes(PB_DETAILS, ["PI-A", "PI-B", "PI-Z"]);
    expect(r.audit).toEqual(["PI-A", "PI-B"]);
    expect(r.piOnly).toEqual(["PI-Z"]);
    expect(r.pbOnly).toEqual([]);
    expect(r.identical).toBe(false);
  });

  it("buildAuditDocuments balances Debit and Credit per document", () => {
    const docs = buildAuditDocuments(PB_DETAILS, GL_ROWS, ["PI-A", "PI-B"]);
    expect(docs).toHaveLength(2);
    for (const d of docs) {
      expect(d.debit).toBe(d.credit);
      expect(d.balanced).toBe(true);
      expect(d.incomplete).toBe(false);
    }
    // Creditor line is identified and separated.
    const a = docs.find((d) => d.docCode === "PI-A")!;
    expect(a.creditor?.accountCode).toBe("S100");
    expect(a.postings.map((p) => p.accountCode).sort()).toEqual(["5210", "6110"]);
  });

  it("reconcileAudit reports Grand balance, matched convention, and completeness", () => {
    const r = reconcileAudit(PB_DETAILS, PB_SUMMARY, GL_ROWS, ["PI-A", "PI-B"]);
    expect(r.grandDebit).toBe(305);
    expect(r.grandCredit).toBe(305);
    expect(r.balanced).toBe(true);
    // PI-C in PB is cancelled and PI-Z isn't in PI: PB active vs PI both = {PI-A, PI-B} → identical.
    expect(r.summaryCheck.kind).toBe("matched");
    if (r.summaryCheck.kind === "matched") {
      expect(r.summaryCheck.convention).toBe("positive-debit");
    }
    expect(r.isComplete).toBe(true);
    expect(r.incompleteReasons).toEqual([]);
  });

  it("skips the signed posting-summary check when PB and PI doc sets differ", () => {
    const r = reconcileAudit(PB_DETAILS, PB_SUMMARY, GL_ROWS, ["PI-A"]);
    expect(r.summaryCheck.kind).toBe("skipped");
  });

  it("flags an unbalanced document as incomplete", () => {
    const bad: GLRow[] = [
      { docCode: "PI-X", accountCode: "SX", debitLocal: 0, creditLocal: 100 },
      { docCode: "PI-X", accountCode: "6110", debitLocal: 90, creditLocal: 0 },
    ];
    const pb: PurchaseBookDetailItem[] = [{ docCode: "PI-X", supplierCode: "SX" }];
    const r = reconcileAudit(pb, [], bad, ["PI-X"]);
    expect(r.balanced).toBe(false);
    expect(r.isComplete).toBe(false);
    expect(r.documents[0].balanced).toBe(false);
    expect(r.documents[0].incomplete).toBe(true);
  });

  it("case-insensitively joins PB, PI and GL doc codes (Phase 3B Correction B)", () => {
    // PB, PI and GL each use a different casing / whitespace shape for the
    // same document. Canonical joins must fold all three onto one audit doc.
    const pb: PurchaseBookDetailItem[] = [
      { docCode: "pi-a", supplierCode: "s100", supplierName: "Acme" },
    ];
    const gl: GLRow[] = [
      { docCode: " PI-A ", accountCode: "S100", debitLocal: 0, creditLocal: 105 },
      { docCode: "pi-a", accountCode: "6110", debitLocal: 100, creditLocal: 0 },
      { docCode: "PI-A", accountCode: "5210", debitLocal: 5, creditLocal: 0 },
    ];
    const r = reconcileAudit(pb, [], gl, ["PI-A"]);
    expect(r.auditDocCodes).toEqual(["PI-A"]);
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0].balanced).toBe(true);
    expect(r.documents[0].creditor?.accountCode).toBe("S100");
    expect(r.glRowsUsed).toBe(3);
    expect(r.balanceStatus).toBe("balanced");
  });

  it("returns balanceStatus 'not-evaluated' when the audit intersection is empty", () => {
    // PB and PI have zero overlap → nothing to evaluate. The UI must NOT
    // show "Balanced: Yes" in this state.
    const r = reconcileAudit(PB_DETAILS, PB_SUMMARY, GL_ROWS, ["PI-ZZZ"]);
    expect(r.auditDocCodes).toEqual([]);
    expect(r.balanceStatus).toBe("not-evaluated");
    expect(r.balanced).toBe(false);
    expect(r.isComplete).toBe(false);
    expect(r.summaryCheck.kind).toBe("skipped");
  });

  it("returns balanceStatus 'not-evaluated' when GL has no rows for the intersection", () => {
    const r = reconcileAudit(PB_DETAILS, PB_SUMMARY, [], ["PI-A", "PI-B"]);
    expect(r.auditDocCodes).toEqual(["PI-A", "PI-B"]);
    expect(r.glRowsUsed).toBe(0);
    expect(r.balanceStatus).toBe("not-evaluated");
    expect(r.balanced).toBe(false);
  });
});
