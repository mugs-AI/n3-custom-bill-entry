import { describe, it, expect } from "vitest";
import {
  buildGetAccountRowsBody,
  buildQueryTransactionLinesBody,
  normalizeAccountRows,
  unionAccountQueries,
  type AccountToQuery,
} from "../audit-server";
import { reconcileAudit, type AuditPIDocument, type GLRow } from "../audit-trail";

// Phase 3B Correction D regression coverage.

describe("buildGetAccountRowsBody", () => {
  it("returns a direct GeneralLedgerFilter (no `filter` wrapper)", () => {
    const b = buildGetAccountRowsBody("2026-07-01", "2026-07-27") as unknown as Record<
      string,
      unknown
    >;
    expect(b).not.toHaveProperty("filter");
    expect(b.includeZero).toBe(false);
    expect(b.includeDACandCCAC).toBe(true);
    expect(b.dateFrom).toBe("2026-07-01T00:00:00");
    expect(b.dateTo).toBe("2026-07-27T23:59:59");
    expect(b.projOption).toBe(-2);
  });
});

describe("buildQueryTransactionLinesBody", () => {
  it("keeps the documented { accountCode, filter } wrapper", () => {
    const b = buildQueryTransactionLinesBody("800-C003", "2026-07-01", "2026-07-27");
    expect(b.accountCode).toBe("800-C003");
    expect(b.filter.includeZero).toBe(false);
    expect(b.filter.includeDACandCCAC).toBe(true);
  });
});

describe("unionAccountQueries", () => {
  it("unions API accounts with target PI supplier codes and dedupes canonically", () => {
    const api = [
      { accountCode: "100-0500", accountName: "OVERCHARGE" },
      { accountCode: "800-c003", accountName: "" }, // lower-case duplicate of a supplier
      { accountCode: "" }, // blank ignored
    ];
    const pis = [
      { supplierCode: "800-C003", supplierName: "CHEOW HOLDING SDN BHD" },
      { supplierCode: "800-E002", supplierName: "EASTCOM TECHNOLOGY" },
      { supplierCode: "800-e002", supplierName: "dup" }, // canonical dup
    ];
    const out = unionAccountQueries(api, pis);
    const codes = out.map((o) => o.accountCode);
    expect(codes).toContain("100-0500");
    expect(codes).toContain("800-c003"); // first-seen casing preserved
    expect(codes).toContain("800-E002"); // supplier-only account included
    expect(codes).toHaveLength(3);
    const sup = out.find((o) => o.accountCode === "800-E002")!;
    expect(sup.source).toBe("target-supplier");
    expect(sup.accountName).toBe("EASTCOM TECHNOLOGY");
  });
});

describe("normalizeAccountRows", () => {
  const account: AccountToQuery = {
    accountCode: "SST-4000",
    accountName: "SST EXPENSES SERVICE TAX",
    source: "get-account-rows",
  };

  it("restores account context for continuation rows with blank accountCode", () => {
    const pis: AuditPIDocument[] = [
      { docCode: "M1B2607003", docDate: "2026-07-26", supplierCode: "800-C003", supplierInvNo: "M1B2607003" },
    ];
    const raw: GLRow[] = [
      { docCode: "M1B2607003", accountCode: "", accountName: "", debitLocal: 0, creditLocal: 167.44 },
    ];
    const { rows, unresolved } = normalizeAccountRows(account, raw, pis);
    expect(unresolved).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountCode).toBe("SST-4000");
    expect(rows[0].accountName).toBe("SST EXPENSES SERVICE TAX");
  });

  it("resolves a blank-docCode SST-4000 credit row (167.44) to its unique PI", () => {
    const pis: AuditPIDocument[] = [
      { docCode: "M1B2607003", docDate: "2026-07-26", supplierCode: "800-C003", supplierInvNo: "M1B2607003" },
      { docCode: "M1B2607002", docDate: "2026-07-26", supplierCode: "800-C003", supplierInvNo: "M1B2607002" },
    ];
    const raw: GLRow[] = [
      {
        docCode: "",
        accountCode: "",
        supplierInvNo: "M1B2607003",
        docDate: "2026-07-26T00:00:00",
        debitLocal: 0,
        creditLocal: 167.44,
      },
    ];
    const { rows } = normalizeAccountRows(account, raw, pis);
    expect(rows).toHaveLength(1);
    expect(rows[0].docCode).toBe("M1B2607003");
    expect(rows[0].accountCode).toBe("SST-4000");
  });

  it("resolves the matching 95.68 credit row the same way", () => {
    const pis: AuditPIDocument[] = [
      { docCode: "M1B2607003", docDate: "2026-07-26", supplierCode: "800-C003", supplierInvNo: "M1B2607003" },
    ];
    const raw: GLRow[] = [
      {
        docCode: "",
        supplierInvNo: "M1B2607003",
        docDate: "2026-07-26",
        debitLocal: 0,
        creditLocal: 95.68,
      },
    ];
    const { rows } = normalizeAccountRows(account, raw, pis);
    expect(rows).toHaveLength(1);
    expect(rows[0].docCode).toBe("M1B2607003");
    expect(rows[0].creditLocal).toBe(95.68);
  });

  it("distinguishes two PIs sharing the same supplierInvNo by date and supplier", () => {
    const pis: AuditPIDocument[] = [
      { docCode: "M1B2607002Ikeyinn3", docDate: "2026-07-24", supplierCode: "800-E002", supplierInvNo: "M1B2607002" },
      { docCode: "M1B2607002", docDate: "2026-07-26", supplierCode: "800-C003", supplierInvNo: "M1B2607002" },
    ];
    // Blank-docCode credit at SST-4000 dated 2026-07-24 → belongs to the E002 PI.
    const e002 = normalizeAccountRows(account, [
      { docCode: "", supplierInvNo: "M1B2607002", docDate: "2026-07-24", debitLocal: 0, creditLocal: 10 },
    ], pis);
    expect(e002.rows.map((r) => r.docCode)).toEqual(["M1B2607002Ikeyinn3"]);

    // Same fingerprint but dated 2026-07-26 → belongs to the C003 PI.
    const c003 = normalizeAccountRows(account, [
      { docCode: "", supplierInvNo: "M1B2607002", docDate: "2026-07-26", debitLocal: 0, creditLocal: 20 },
    ], pis);
    expect(c003.rows.map((r) => r.docCode)).toEqual(["M1B2607002"]);
  });

  it("returns an ambiguous unresolved row when narrowing does not produce a unique match", () => {
    const pis: AuditPIDocument[] = [
      { docCode: "PI-A", docDate: "2026-07-24", supplierCode: "800-C003", supplierInvNo: "SHARED" },
      { docCode: "PI-B", docDate: "2026-07-24", supplierCode: "800-C003", supplierInvNo: "SHARED" },
    ];
    const { rows, unresolved } = normalizeAccountRows(account, [
      { docCode: "", supplierInvNo: "SHARED", docDate: "2026-07-24", debitLocal: 0, creditLocal: 50 },
    ], pis);
    expect(rows).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].reason).toBe("ambiguous");
    expect(unresolved[0].supplierInvNo).toBe("SHARED");
  });

  it("silently drops docCoded rows that do not belong to the target PI set", () => {
    const pis: AuditPIDocument[] = [
      { docCode: "PI-A", supplierCode: "S1" },
    ];
    const { rows, unresolved } = normalizeAccountRows(account, [
      { docCode: "SOME-OTHER-DOC", debitLocal: 0, creditLocal: 99 },
    ], pis);
    expect(rows).toHaveLength(0);
    expect(unresolved).toHaveLength(0);
  });
});

// ---- Full 24-row acceptance fixture ---------------------------------------
//
// Mirrors the six missing rows plus the eighteen already fetched, and drives
// the whole normalize → reconcile pipeline. Amounts are only asserted at the
// aggregate level.

describe("acceptance fixture: 4 PIs, 24 rows, balanced 28,673.12 each side", () => {
  const pis: AuditPIDocument[] = [
    { docCode: "M1B2607002Ikeyinn3", docDate: "2026-07-24", supplierCode: "800-E002", supplierName: "EASTCOM TECHNOLOGY", supplierInvNo: "M1B2607002" },
    { docCode: "M1B2607001", docDate: "2026-07-25", supplierCode: "800-C003", supplierName: "CHEOW HOLDING SDN BHD", supplierInvNo: "M1B2607001" },
    { docCode: "M1B2607002", docDate: "2026-07-26", supplierCode: "800-C003", supplierName: "CHEOW HOLDING SDN BHD", supplierInvNo: "M1B2607002" },
    { docCode: "M1B2607003", docDate: "2026-07-26", supplierCode: "800-C003", supplierName: "CHEOW HOLDING SDN BHD", supplierInvNo: "M1B2607003" },
  ];

  // Debits sourced from per-account query context, keyed by (accountCode).
  const debitRowsByAcct: Record<string, GLRow[]> = {
    "100-0500": [
      { docCode: "M1B2607002", accountCode: "100-0500", accountName: "OVERCHARGE", debitLocal: 3690, creditLocal: 0 },
      { docCode: "M1B2607002", accountCode: "100-0500", accountName: "OVERCHARGE", debitLocal: 3690, creditLocal: 0 },
    ],
    "150-0200": [{ docCode: "M1B2607001", accountCode: "150-0200", accountName: "DISCOUNT ALLOWED", debitLocal: 200, creditLocal: 0 }],
    "201-0002": [
      { docCode: "M1B2607002Ikeyinn3", accountCode: "201-0002", accountName: "PURCHASES - SOFTWARE", debitLocal: 985, creditLocal: 0 },
      { docCode: "M1B2607001", accountCode: "201-0002", accountName: "PURCHASES - SOFTWARE", debitLocal: 3915, creditLocal: 0 },
      { docCode: "M1B2607001", accountCode: "201-0002", accountName: "PURCHASES - SOFTWARE", debitLocal: 3900, creditLocal: 0 },
    ],
    "300-0400": [{ docCode: "M1B2607003", accountCode: "300-0400", accountName: "DIVIDEND RECEIVED", debitLocal: 2093, creditLocal: 0 }],
    "300-0500": [{ docCode: "M1B2607002", accountCode: "300-0500", accountName: "FIXED DEPOSIT INTEREST", debitLocal: 7380, creditLocal: 0 }],
    "300-2000": [{ docCode: "M1B2607003", accountCode: "300-2000", accountName: "OTHER INCOME", debitLocal: 1196, creditLocal: 0 }],
    "300-9000": [
      { docCode: "M1B2607001", accountCode: "300-9000", accountName: "ROUNDING ADJUSTMENT", debitLocal: 250, creditLocal: 0 },
      { docCode: "M1B2607001", accountCode: "300-9000", accountName: "ROUNDING ADJUSTMENT", debitLocal: 250, creditLocal: 0 },
      { docCode: "M1B2607003", accountCode: "300-9000", accountName: "ROUNDING ADJUSTMENT", debitLocal: 200, creditLocal: 0 },
    ],
    "SST-3000": [
      { docCode: "M1B2607001", accountCode: "SST-3000", accountName: "SST PURCHASE TAX", debitLocal: 234.5, creditLocal: 0 },
      { docCode: "M1B2607001", accountCode: "SST-3000", accountName: "SST PURCHASE TAX", debitLocal: 234.5, creditLocal: 0 },
      { docCode: "M1B2607003", accountCode: "SST-3000", accountName: "SST PURCHASE TAX", debitLocal: 96, creditLocal: 0 },
    ],
    "SST-4000": [
      // Three debit rows summing to 359.12 plus two blank-docCode
      // continuation credits (167.44 + 95.68 = 263.12) that must resolve
      // to M1B2607003 via supplierInvNo + docDate.
      { docCode: "M1B2607001", accountCode: "SST-4000", accountName: "SST EXPENSES SERVICE TAX", debitLocal: 100, creditLocal: 0 },
      { docCode: "M1B2607002", accountCode: "SST-4000", accountName: "SST EXPENSES SERVICE TAX", debitLocal: 100, creditLocal: 0 },
      { docCode: "M1B2607003", accountCode: "SST-4000", accountName: "SST EXPENSES SERVICE TAX", debitLocal: 159.12, creditLocal: 0 },
      { docCode: "", accountCode: "", supplierInvNo: "M1B2607003", docDate: "2026-07-26", debitLocal: 0, creditLocal: 167.44 },
      { docCode: "", accountCode: "", supplierInvNo: "M1B2607003", docDate: "2026-07-26", debitLocal: 0, creditLocal: 95.68 },
    ],
    "800-C003": [
      { docCode: "M1B2607001", accountCode: "800-C003", accountName: "CHEOW HOLDING SDN BHD", debitLocal: 0, creditLocal: 9376 },
      { docCode: "M1B2607002", accountCode: "800-C003", accountName: "CHEOW HOLDING SDN BHD", debitLocal: 0, creditLocal: 7380 },
      { docCode: "M1B2607003", accountCode: "800-C003", accountName: "CHEOW HOLDING SDN BHD", debitLocal: 0, creditLocal: 10669 },
    ],
    "800-E002": [
      { docCode: "M1B2607002Ikeyinn3", accountCode: "800-E002", accountName: "EASTCOM TECHNOLOGY", debitLocal: 0, creditLocal: 985 },
    ],
  };

  it("normalizes and reconciles to the expected acceptance figures", () => {
    const glAll: GLRow[] = [];
    for (const [code, rows] of Object.entries(debitRowsByAcct)) {
      const acct: AccountToQuery = {
        accountCode: code,
        accountName: rows[0]?.accountName ?? "",
        source: code.startsWith("800-") ? "target-supplier" : "get-account-rows",
      };
      const { rows: norm, unresolved } = normalizeAccountRows(acct, rows, pis);
      expect(unresolved).toHaveLength(0);
      glAll.push(...norm);
    }

    // 24 rows in the acceptance fixture: 18 previously-fetched debits/credits
    // plus the four supplier control-account credits and two SST-4000
    // continuation credits that Correction D restores.
    expect(glAll).toHaveLength(24);

    const r = reconcileAudit(pis, glAll);
    expect(r.grandDebit).toBeCloseTo(28673.12, 2);
    expect(r.grandCredit).toBeCloseTo(28673.12, 2);
    expect(r.balanceStatus).toBe("balanced");
    expect(r.documents).toHaveLength(4);
    for (const d of r.documents) expect(d.balanced).toBe(true);

    const byAcct = new Map(r.postingAccounts.map((p) => [p.accountCode, p]));
    expect(byAcct.get("SST-4000")!.credit).toBeCloseTo(263.12, 2);
    expect(byAcct.get("800-C003")!.credit).toBeCloseTo(27425, 2);
    expect(byAcct.get("800-E002")!.credit).toBeCloseTo(985, 2);
  });
});
