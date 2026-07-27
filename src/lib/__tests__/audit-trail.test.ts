import { describe, it, expect } from "vitest";
import {
  buildAuditDocuments,
  reconcileAudit,
  type AuditPIDocument,
  type GLRow,
} from "../audit-trail";

// Phase 3B Correction C — Purchase Audit is driven by the current Purchase
// Invoice list. PurchaseBook is no longer consulted.

const PIS: AuditPIDocument[] = [
  {
    invoiceId: "id-a",
    docCode: "PI-A",
    docDate: "2026-07-24",
    supplierCode: "S100",
    supplierName: "Acme Supplies",
    termDescription: "30 Days",
    dueDate: "2026-08-23",
  },
  {
    invoiceId: "id-b",
    docCode: "PI-B",
    docDate: "2026-07-25",
    supplierCode: "S200",
    supplierName: "Beta Corp",
  },
];

const GL_ROWS: GLRow[] = [
  { docCode: "PI-A", accountCode: "S100", accountName: "Acme Supplies", debitLocal: 0, creditLocal: 105 },
  { docCode: "PI-A", accountCode: "6110", accountName: "Materials", debitLocal: 100, creditLocal: 0 },
  { docCode: "PI-A", accountCode: "5210", accountName: "Input Tax", debitLocal: 5, creditLocal: 0 },
  { docCode: "PI-B", accountCode: "S200", accountName: "Beta Corp", debitLocal: 0, creditLocal: 200 },
  { docCode: "PI-B", accountCode: "6110", accountName: "Materials", debitLocal: 200, creditLocal: 0 },
  { docCode: "PI-Ignored", accountCode: "SX", debitLocal: 0, creditLocal: 999 },
];

describe("Purchase Audit reconciliation (PI-driven)", () => {
  it("builds one document per Purchase Invoice with balanced Debit/Credit", () => {
    const r = reconcileAudit(PIS, GL_ROWS);
    expect(r.documents).toHaveLength(2);
    for (const d of r.documents) {
      expect(d.debit).toBe(d.credit);
      expect(d.balanced).toBe(true);
      expect(d.creditor).not.toBeNull();
    }
    expect(r.grandDebit).toBe(305);
    expect(r.grandCredit).toBe(305);
    expect(r.balanceStatus).toBe("balanced");
    expect(r.isComplete).toBe(true);
    expect(r.glRowsUsed).toBe(5); // PI-Ignored filtered out
    expect(r.postingAccounts.map((p) => p.accountCode).sort()).toEqual([
      "5210",
      "6110",
      "S100",
      "S200",
    ]);
  });

  it("aggregates multiple GL creditor rows into a single creditor line", () => {
    const pis: AuditPIDocument[] = [
      { invoiceId: "x", docCode: "PI-X", supplierCode: "S100", supplierName: "Acme" },
    ];
    const gl: GLRow[] = [
      { docCode: "PI-X", accountCode: "S100", debitLocal: 0, creditLocal: 60 },
      { docCode: "PI-X", accountCode: "S100", debitLocal: 0, creditLocal: 40 },
      { docCode: "PI-X", accountCode: "6110", debitLocal: 100, creditLocal: 0 },
    ];
    const r = reconcileAudit(pis, gl);
    expect(r.documents[0].creditor?.credit).toBe(100);
    expect(r.documents[0].creditor?.debit).toBe(0);
    expect(r.documents[0].balanced).toBe(true);
    expect(r.balanceStatus).toBe("balanced");
  });

  it("keeps a PI with no GL rows and flags it incomplete", () => {
    const pis: AuditPIDocument[] = [
      ...PIS,
      { invoiceId: "z", docCode: "PI-Z", supplierCode: "S1" },
    ];
    const r = reconcileAudit(pis, GL_ROWS);
    const z = r.documents.find((d) => d.docCode === "PI-Z");
    expect(z).toBeDefined();
    expect(z!.incomplete).toBe(true);
    expect(z!.creditor).toBeNull();
    expect(z!.postings).toEqual([]);
    expect(r.docsWithoutGL).toContain("PI-Z");
    expect(r.balanceStatus).toBe("unbalanced");
    expect(r.isComplete).toBe(false);
  });

  it("case-insensitively joins PI and GL doc/account codes", () => {
    const pis: AuditPIDocument[] = [
      { invoiceId: "a", docCode: "pi-a", supplierCode: "s100" },
    ];
    const gl: GLRow[] = [
      { docCode: " PI-A ", accountCode: "S100", debitLocal: 0, creditLocal: 105 },
      { docCode: "pi-a", accountCode: "6110", debitLocal: 100, creditLocal: 0 },
      { docCode: "PI-A", accountCode: "5210", debitLocal: 5, creditLocal: 0 },
    ];
    const r = reconcileAudit(pis, gl);
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0].balanced).toBe(true);
    expect(r.documents[0].creditor?.accountCode).toBe("S100");
    expect(r.glRowsUsed).toBe(3);
  });

  it("returns 'not-evaluated' when no GL rows match any PI", () => {
    const r = reconcileAudit(PIS, []);
    expect(r.balanceStatus).toBe("not-evaluated");
    expect(r.balanced).toBe(false);
    expect(r.glRowsUsed).toBe(0);
    expect(r.docsWithoutGL.length).toBe(PIS.length);
  });

  it("excludes cancelled and balance-brought-forward GL rows", () => {
    const gl: GLRow[] = [
      { docCode: "PI-A", accountCode: "S100", debitLocal: 0, creditLocal: 100, isCancelled: true },
      { docCode: "PI-A", accountCode: "S100", debitLocal: 0, creditLocal: 100, isBalanceBF: true },
      { docCode: "PI-A", accountCode: "S100", debitLocal: 0, creditLocal: 100 },
      { docCode: "PI-A", accountCode: "6110", debitLocal: 100, creditLocal: 0 },
    ];
    const r = reconcileAudit([PIS[0]], gl);
    expect(r.glRowsUsed).toBe(2);
    expect(r.documents[0].balanced).toBe(true);
  });

  it("buildAuditDocuments alone preserves PI header metadata", () => {
    const docs = buildAuditDocuments(PIS, GL_ROWS);
    const a = docs.find((d) => d.docCode === "PI-A")!;
    expect(a.invoiceId).toBe("id-a");
    expect(a.supplierName).toBe("Acme Supplies");
    expect(a.termDescription).toBe("30 Days");
    expect(a.dueDate).toBe("2026-08-23");
  });
});
