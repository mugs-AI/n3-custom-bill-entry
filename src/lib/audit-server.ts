// Server-side helpers for /api/reports/purchase-audit (Phase 3B Correction D).
//
// Extracted so the request-body shape, account-union and continuation-row
// resolution rules can be unit-tested without spinning up the route.
//
// Correction D root causes addressed here:
//   1. `GetAccountRows` request body is a direct GeneralLedgerFilter — no
//      outer `filter` wrapper — with `includeZero=false, includeDACandCCAC=true`.
//   2. The final account-query set is the canonical (NFKC+trim+uppercase)
//      union of every non-blank GetAccountRows account plus every non-blank
//      target PI `supplierCode`. Supplier control accounts always ship.
//   3. `QueryTransactionLines` continuation/split rows can omit repeated
//      accountCode/accountName/docCode fields. We restore them from the
//      per-account query context and resolve missing docCodes by
//      (canonical supplierInvNo, calendar date, queried account) to at most
//      one target PI. Ambiguous matches are recorded as unresolved and
//      cause the whole audit to fail as incomplete.

import type { AuditPIDocument, GLRow } from "./audit-trail";
import { canonicalAccountCode, canonicalDocCode } from "./report-keys";

export interface AccountToQuery {
  accountCode: string;
  accountName: string;
  source: "get-account-rows" | "target-supplier";
}

export interface UnresolvedRow {
  accountCode: string;
  docDate: string;
  supplierInvNo: string;
  debit: number;
  credit: number;
  reason: "no-match" | "ambiguous";
}

/** Direct GeneralLedgerFilter body — no `filter` wrapper. */
export function buildGetAccountRowsBody(
  dateFrom: string,
  dateTo: string,
): {
  dateFrom: string;
  dateTo: string;
  accountFrom: null;
  accountTo: null;
  accountCodes: null;
  build: null;
  projectIds: number[];
  projOption: number;
  sortBy: null;
  includeZero: boolean;
  includeDACandCCAC: boolean;
} {
  return {
    dateFrom: `${dateFrom}T00:00:00`,
    dateTo: `${dateTo}T23:59:59`,
    accountFrom: null,
    accountTo: null,
    accountCodes: null,
    build: null,
    projectIds: [],
    projOption: -2,
    sortBy: null,
    includeZero: false,
    includeDACandCCAC: true,
  };
}

/** QueryTransactionLines still uses the documented `{ accountCode, filter }` wrapper. */
export function buildQueryTransactionLinesBody(
  accountCode: string,
  dateFrom: string,
  dateTo: string,
): {
  accountCode: string;
  filter: ReturnType<typeof buildGetAccountRowsBody>;
} {
  return {
    accountCode,
    filter: buildGetAccountRowsBody(dateFrom, dateTo),
  };
}

/**
 * Canonical union of the GetAccountRows results and every target PI
 * supplier code. Original casing is preserved for display and outgoing
 * API requests; canonical keys are only used for deduplication.
 */
export function unionAccountQueries(
  apiRows: Array<{ accountCode?: unknown; accountName?: unknown }>,
  piDocuments: Array<{ supplierCode?: unknown; supplierName?: unknown }>,
): AccountToQuery[] {
  const seen = new Map<string, AccountToQuery>();
  for (const r of apiRows) {
    const code = typeof r?.accountCode === "string" ? r.accountCode.trim() : "";
    if (!code) continue;
    const key = canonicalAccountCode(code);
    if (!key || seen.has(key)) continue;
    seen.set(key, {
      accountCode: code,
      accountName: typeof r.accountName === "string" ? r.accountName.trim() : "",
      source: "get-account-rows",
    });
  }
  for (const p of piDocuments) {
    const code = typeof p?.supplierCode === "string" ? p.supplierCode.trim() : "";
    if (!code) continue;
    const key = canonicalAccountCode(code);
    if (!key || seen.has(key)) continue;
    seen.set(key, {
      accountCode: code,
      accountName: typeof p.supplierName === "string" ? p.supplierName.trim() : "",
      source: "target-supplier",
    });
  }
  return [...seen.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

function normDate(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (t.length < 10) return "";
  return t.slice(0, 10);
}

function nonBlank(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Normalize the raw rows returned by QueryTransactionLines for a single
 * account. Restores the queried account's identity onto continuation rows
 * with blank accountCode/accountName, and resolves missing docCodes to a
 * unique target PI by (supplierInvNo, docDate, [supplierCode]).
 *
 * - Rows whose docCode canonically matches a target PI are kept as-is
 *   (with account context restored).
 * - Rows with a blank docCode go through the fallback resolver.
 * - Rows whose docCode is present but not in the target PI set are
 *   silently dropped — they belong to another document.
 * - Ambiguous fallback matches (>=1 candidate but not exactly 1) are
 *   surfaced as UnresolvedRow entries so the caller can fail incomplete.
 */
export function normalizeAccountRows(
  account: AccountToQuery,
  rawRows: GLRow[],
  piDocuments: AuditPIDocument[],
): { rows: GLRow[]; unresolved: UnresolvedRow[] } {
  const kept: GLRow[] = [];
  const unresolved: UnresolvedRow[] = [];
  const wantedAccountKey = canonicalAccountCode(account.accountCode);

  const piDocSet = new Set<string>();
  for (const p of piDocuments) {
    const k = canonicalDocCode(p.docCode);
    if (k) piDocSet.add(k);
  }

  // Correction E §4: the initial context is the requested account. Any
  // explicit account returned by N3 replaces it; blank-account continuation
  // rows inherit the last explicit context (never the supplier or any other
  // query key).
  let lastAcctCode = account.accountCode;
  let lastAcctName = account.accountName;

  for (const r of rawRows) {
    const explicitCode = nonBlank(r.accountCode);
    const explicitName = nonBlank(r.accountName);
    if (explicitCode) {
      lastAcctCode = explicitCode;
      lastAcctName = explicitName || lastAcctName;
    }
    const resolvedAccountCode = explicitCode || lastAcctCode;
    const resolvedAccountName = explicitCode ? explicitName : lastAcctName;
    const rowDocKey = canonicalDocCode(r.docCode);

    if (rowDocKey && piDocSet.has(rowDocKey)) {
      kept.push({
        ...r,
        accountCode: resolvedAccountCode,
        accountName: resolvedAccountName,
      });
      continue;
    }
    if (rowDocKey) {
      // Doc known but not one of the target PIs — silently out of scope.
      continue;
    }

    // rowDocKey is blank → fallback resolution.
    const debit = safeNum(r.debitLocal);
    const credit = safeNum(r.creditLocal);
    const isNonZero = Math.abs(debit) + Math.abs(credit) > 0;

    const sinvKey = canonicalDocCode(r.supplierInvNo);
    const dateKey = normDate(r.docDate);
    // Correction E §4.4: a blank date must not block a unique Supplier INV#
    // match. Supplier INV# is still required.
    if (!sinvKey) {
      if (isNonZero) {
        unresolved.push({
          accountCode: resolvedAccountCode,
          docDate: dateKey,
          supplierInvNo: nonBlank(r.supplierInvNo),
          debit,
          credit,
          reason: "no-match",
        });
      }
      continue;
    }

    let candidates = piDocuments.filter(
      (p) => canonicalDocCode(p.supplierInvNo) === sinvKey,
    );
    if (candidates.length > 1 && dateKey) {
      const narrowed = candidates.filter((p) => normDate(p.docDate) === dateKey);
      if (narrowed.length > 0) candidates = narrowed;
    }
    if (candidates.length > 1 && wantedAccountKey) {
      const narrowed = candidates.filter(
        (p) => canonicalAccountCode(p.supplierCode) === wantedAccountKey,
      );
      if (narrowed.length > 0) candidates = narrowed;
    }

    if (candidates.length === 1) {
      kept.push({
        ...r,
        accountCode: resolvedAccountCode,
        accountName: resolvedAccountName,
        docCode: candidates[0].docCode,
      });
      continue;
    }

    if (isNonZero) {
      unresolved.push({
        accountCode: resolvedAccountCode,
        docDate: dateKey,
        supplierInvNo: nonBlank(r.supplierInvNo),
        debit,
        credit,
        reason: candidates.length === 0 ? "no-match" : "ambiguous",
      });
    }
  }

  return { rows: kept, unresolved };
}

