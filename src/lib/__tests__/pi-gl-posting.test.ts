// Phase 3B Correction E — focused regression tests for the document-level
// GL Posting normalizer and the full 4-PI acceptance fixture.

import { describe, it, expect } from "vitest";
import { normalizeGLPostingForPI } from "../pi-gl-posting";
import { reconcileAudit, type AuditPIDocument, type GLRow } from "../audit-trail";
import { computeAuditFingerprint } from "../audit-fingerprint";
import type { GLDrillDownLine, ReportData } from "../report-model";

const PI_M3: AuditPIDocument = {
  invoiceId: "id-3",
  docCode: "M1B2607003",
  docDate: "2026-07-26",
  supplierCode: "800-C003",
  supplierName: "CHEOW HOLDING SDN BHD",
  supplierInvNo: "M1B2607003",
};

function envelope(data: unknown) {
  return { success: true, code: "0000", message: "OK", data };
}

describe("normalizeGLPostingForPI — payload shapes", () => {
  const rows = [
    { accountCode: "800-C003", accountName: "CREDITOR", debitLocal: 0, creditLocal: 10669 },
    { accountCode: "201-0002", accountName: "PURCHASES", debitLocal: 10000, creditLocal: 0 },
    { accountCode: "SST-4000", accountName: "SST", debitLocal: 63.12, creditLocal: 0 },
  ];

  it("accepts data as an array", () => {
    const out = normalizeGLPostingForPI(envelope(rows), PI_M3);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rows).toHaveLength(3);
      expect(out.rows[0].docCode).toBe("M1B2607003");
    }
  });

  it("accepts data.value as an array", () => {
    const out = normalizeGLPostingForPI(envelope({ value: rows }), PI_M3);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows).toHaveLength(3);
  });

  it("accepts data as a JSON string", () => {
    const out = normalizeGLPostingForPI(envelope(JSON.stringify(rows)), PI_M3);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows).toHaveLength(3);
  });

  it("returns unsupported-shape contract mismatch for an unknown successful shape", () => {
    const out = normalizeGLPostingForPI(envelope({ notRows: rows }), PI_M3);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("unsupported-shape");
  });
});

describe("normalizeGLPostingForPI — continuation rows", () => {
  it("continuation rows inherit the last explicit account context", () => {
    const rows = [
      { accountCode: "800-C003", accountName: "CREDITOR", debitLocal: 0, creditLocal: 10669 },
      // Two continuation credits with blank account fields — must inherit
      // the trade-creditor account, NOT get filled with SST or a query key.
      { accountCode: "", accountName: "", debitLocal: 0, creditLocal: 167.44 },
      { accountCode: "", accountName: "", debitLocal: 0, creditLocal: 95.68 },
    ];
    const out = normalizeGLPostingForPI(envelope(rows), PI_M3);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rows.map((r) => r.accountCode)).toEqual([
        "800-C003",
        "800-C003",
        "800-C003",
      ]);
      expect(out.rows.map((r) => r.creditLocal)).toEqual([10669, 167.44, 95.68]);
    }
  });
});

describe("acceptance: M1B2607003 balances 10,932.12 / 10,932.12", () => {
  it("credits its continuation rows into the supplier control account", () => {
    const rows = [
      { accountCode: "800-C003", debitLocal: 0, creditLocal: 10669 },
      { accountCode: "", debitLocal: 0, creditLocal: 167.44 },
      { accountCode: "", debitLocal: 0, creditLocal: 95.68 },
      { accountCode: "300-0400", debitLocal: 2093, creditLocal: 0 },
      { accountCode: "300-0500", debitLocal: 3690, creditLocal: 0 },
      { accountCode: "300-0500", debitLocal: 3690, creditLocal: 0 },
      { accountCode: "300-2000", debitLocal: 1196, creditLocal: 0 },
      { accountCode: "300-9000", debitLocal: 200, creditLocal: 0 },
      { accountCode: "SST-4000", debitLocal: 63.12, creditLocal: 0 },
    ];
    const out = normalizeGLPostingForPI(envelope(rows), PI_M3);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = reconcileAudit([PI_M3], out.rows);
    const doc = r.documents[0]!;
    expect(doc.debit).toBeCloseTo(10932.12, 2);
    expect(doc.credit).toBeCloseTo(10932.12, 2);
    expect(doc.balanced).toBe(true);
    const acct = new Map(r.postingAccounts.map((p) => [p.accountCode, p]));
    expect(acct.get("800-C003")!.credit).toBeCloseTo(10932.12, 2);
    expect(acct.get("SST-4000")!.debit).toBeCloseTo(63.12, 2);
  });
});

describe("acceptance: full 4-PI fixture balances 28,673.12 / 28,673.12", () => {
  const pis: AuditPIDocument[] = [
    { invoiceId: "1", docCode: "M1B2607002Ikeyinn3", docDate: "2026-07-24", supplierCode: "800-E002", supplierInvNo: "M1B2607002" },
    { invoiceId: "2", docCode: "M1B2607001", docDate: "2026-07-25", supplierCode: "800-C003", supplierInvNo: "M1B2607001" },
    { invoiceId: "3", docCode: "M1B2607002", docDate: "2026-07-26", supplierCode: "800-C003", supplierInvNo: "M1B2607002" },
    PI_M3,
  ];

  const journals: Record<string, unknown[]> = {
    M1B2607002Ikeyinn3: [
      { accountCode: "800-E002", debitLocal: 0, creditLocal: 985 },
      { accountCode: "201-0002", debitLocal: 985, creditLocal: 0 },
    ],
    M1B2607001: [
      { accountCode: "800-C003", debitLocal: 0, creditLocal: 9376 },
      { accountCode: "150-0200", debitLocal: 200, creditLocal: 0 },
      { accountCode: "201-0002", debitLocal: 3915, creditLocal: 0 },
      { accountCode: "201-0002", debitLocal: 3900, creditLocal: 0 },
      { accountCode: "300-9000", debitLocal: 500, creditLocal: 0 },
      { accountCode: "SST-3000", debitLocal: 200, creditLocal: 0 },
      { accountCode: "SST-3000", debitLocal: 200, creditLocal: 0 },
      { accountCode: "SST-3000", debitLocal: 165, creditLocal: 0 },
      { accountCode: "SST-4000", debitLocal: 200, creditLocal: 0 },
      { accountCode: "SST-4000", debitLocal: 96, creditLocal: 0 },
    ],
    M1B2607002: [
      { accountCode: "800-C003", debitLocal: 0, creditLocal: 7380 },
      { accountCode: "100-0500", debitLocal: 3690, creditLocal: 0 },
      { accountCode: "100-0500", debitLocal: 3690, creditLocal: 0 },
    ],
    M1B2607003: [
      { accountCode: "800-C003", debitLocal: 0, creditLocal: 10669 },
      { accountCode: "", debitLocal: 0, creditLocal: 167.44 },
      { accountCode: "", debitLocal: 0, creditLocal: 95.68 },
      { accountCode: "300-0400", debitLocal: 2093, creditLocal: 0 },
      { accountCode: "300-0500", debitLocal: 3690, creditLocal: 0 },
      { accountCode: "300-0500", debitLocal: 3690, creditLocal: 0 },
      { accountCode: "300-2000", debitLocal: 1196, creditLocal: 0 },
      { accountCode: "300-9000", debitLocal: 200, creditLocal: 0 },
      { accountCode: "SST-4000", debitLocal: 63.12, creditLocal: 0 },
    ],
  };

  it("normalizes and reconciles each PI to a balanced grand total", () => {
    const all: GLRow[] = [];
    for (const pi of pis) {
      const out = normalizeGLPostingForPI(envelope(journals[pi.docCode]), pi);
      expect(out.ok).toBe(true);
      if (out.ok) all.push(...out.rows);
    }
    const r = reconcileAudit(pis, all);
    expect(r.grandDebit).toBeCloseTo(28673.12, 2);
    expect(r.grandCredit).toBeCloseTo(28673.12, 2);
    expect(r.balanceStatus).toBe("balanced");
    const acct = new Map(r.postingAccounts.map((p) => [p.accountCode, p]));
    expect(acct.get("SST-4000")!.debit).toBeCloseTo(359.12, 2);
    expect(acct.get("SST-4000")!.credit).toBeCloseTo(0, 2);
  });
});

// ---- fingerprint stability ------------------------------------------------

function makeLine(over: Partial<GLDrillDownLine>): GLDrillDownLine {
  return {
    invoiceId: "id-1",
    docCode: "PI-A",
    docDate: "2026-07-24",
    isCancelled: false,
    supplierId: 1,
    supplierCode: "S100",
    supplierName: "Acme",
    supplierInvNo: "SI-1",
    hqSequence: "",
    purchaserId: null,
    purchaserCode: "",
    purchaserName: "",
    paymentType: "",
    glAccountId: null,
    glAccountCode: "6110",
    glAccountName: "Materials",
    projectId: null,
    projectCode: "",
    stockId: null,
    stockCode: "",
    itemDescription: "",
    taxCodeId: 1,
    taxCodeCode: "SR",
    tariffCodeId: null,
    tariffCode: "",
    tariffDescription: "",
    qty: 1,
    unitPrice: 100,
    beforeTax: 100,
    taxAmount: 6,
    includingTax: 106,
    referenceNo: "",
    pos: 1,
    ...over,
  };
}

function makeReport(lines: GLDrillDownLine[]): ReportData {
  return {
    criteria: { dateFrom: "2026-07-01", dateTo: "2026-07-31" },
    summary: {
      glAccountsCount: 1,
      invoiceCount: 1,
      lineCount: lines.length,
      beforeTax: 0,
      taxAmount: 0,
      includingTax: 0,
    },
    groups: [],
    lines,
    matchedInvoiceCount: 1,
    fetchedInvoiceCount: 1,
    overLimit: false,
  };
}

describe("computeAuditFingerprint", () => {
  it("changes when an invoice identity or an accounting amount changes", () => {
    const base = computeAuditFingerprint(makeReport([makeLine({})]));
    const diffId = computeAuditFingerprint(makeReport([makeLine({ invoiceId: "id-2" })]));
    const diffAmt = computeAuditFingerprint(makeReport([makeLine({ beforeTax: 200 })]));
    expect(diffId).not.toBe(base);
    expect(diffAmt).not.toBe(base);
  });

  it("is stable under line reorder within the same invoice", () => {
    const a = makeLine({ pos: 1, glAccountCode: "6110", beforeTax: 50 });
    const b = makeLine({ pos: 2, glAccountCode: "5210", beforeTax: 5 });
    expect(computeAuditFingerprint(makeReport([a, b]))).toBe(
      computeAuditFingerprint(makeReport([b, a])),
    );
  });
});
