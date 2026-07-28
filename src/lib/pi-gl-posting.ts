// Phase 3B Correction E — document-level Account Journal normalizer.
//
// Consumes the successful QNE envelope from
//   GET /api/PurchaseInvoices/GLPosting?key=<invoiceId>
// and produces GLRow[] bound to a single target Purchase Invoice.
//
// The endpoint's `data` shape is not strongly typed in the OpenAPI document,
// so we accept every documented/defensive representation:
//   1. data is an array;
//   2. data is `{ value: [...] }`;
//   3. data is a JSON string which, after ONE safe JSON.parse, is either of
//      the above.
// Any other successful shape is a contract mismatch, never an empty success.
//
// Continuation/split rows may omit repeated accountCode/accountName. We
// walk each document in returned order and inherit the last EXPLICIT account
// context. The requested supplier or any other query key is never used to
// substitute for a real account.
//
// Rows preserve signed Debit/Credit as N3 returned them, including genuine
// zero on the opposite side. Nothing is derived from Purchase Invoice
// amounts; no tax is recalculated.

import type { AuditPIDocument, GLRow } from "./audit-trail";

export type PIGLPostingNormalizeResult =
  | { ok: true; rows: GLRow[] }
  | { ok: false; reason: PIGLPostingReason };

export type PIGLPostingReason =
  | "unsupported-shape"
  | "no-rows"
  | "no-account-context";

function nonBlank(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Pull the array of raw journal rows from the envelope, applying the three
 * accepted representations above. Returns `null` when the envelope really
 * has no data payload (caller can retry / mark incomplete), or a
 * `{ unsupported: true }` sentinel for any other successful-but-wrong shape.
 */
export function extractGLPostingRows(
  parsed: unknown,
): unknown[] | { unsupported: true } | null {
  if (!parsed || typeof parsed !== "object") return null;
  let data: unknown = (parsed as { data?: unknown }).data;
  if (data == null) return null;
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (!trimmed) return null;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return { unsupported: true };
    }
  }
  if (Array.isArray(data)) return data;
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { value?: unknown[] }).value)
  ) {
    return (data as { value: unknown[] }).value;
  }
  return { unsupported: true };
}

/**
 * Normalize the parsed QNE envelope for a single Purchase Invoice's Account
 * Journal. Every returned row is bound to `targetPI` (docCode from the PI;
 * docDate/supplierInvNo inherited from the PI when the row omits them).
 */
export function normalizeGLPostingForPI(
  parsed: unknown,
  targetPI: AuditPIDocument,
): PIGLPostingNormalizeResult {
  const rows = extractGLPostingRows(parsed);
  if (rows === null || (rows as { unsupported?: true }).unsupported === true) {
    return { ok: false, reason: "unsupported-shape" };
  }
  const list = rows as unknown[];
  if (list.length === 0) return { ok: false, reason: "no-rows" };

  const out: GLRow[] = [];
  let lastAcctCode = "";
  let lastAcctName = "";
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const explicitCode = nonBlank(rec.accountCode);
    const explicitName = nonBlank(rec.accountName);
    if (explicitCode) {
      lastAcctCode = explicitCode;
      lastAcctName = explicitName || lastAcctName;
    }
    const hasAmountField =
      Object.prototype.hasOwnProperty.call(rec, "debitLocal") ||
      Object.prototype.hasOwnProperty.call(rec, "creditLocal");
    const debit = num(rec.debitLocal);
    const credit = num(rec.creditLocal);
    if (!hasAmountField && !explicitCode) continue;
    const acctCode = explicitCode || lastAcctCode;
    const acctName = explicitCode ? explicitName : lastAcctName;
    if (!acctCode) {
      // First financial row with no account context we can safely establish.
      if (debit !== 0 || credit !== 0) {
        return { ok: false, reason: "no-account-context" };
      }
      continue;
    }
    out.push({
      accountCode: acctCode,
      accountName: acctName,
      debitLocal: debit,
      creditLocal: credit,
      docCode: targetPI.docCode,
      docDate: nonBlank(rec.docDate) || targetPI.docDate || "",
      supplierInvNo:
        nonBlank(rec.supplierInvNo) || targetPI.supplierInvNo || "",
      description: nonBlank(rec.description) || undefined,
      detailDescription: nonBlank(rec.detailDescription) || undefined,
      referenceNo: nonBlank(rec.referenceNo) || undefined,
      currencyCode: nonBlank(rec.currencyCode) || undefined,
      currencyRate:
        typeof rec.currencyRate === "number" && Number.isFinite(rec.currencyRate)
          ? rec.currencyRate
          : undefined,
      isBalanceBF: !!rec.isBalanceBF,
      isCancelled: !!rec.isCancelled,
      isTaxPosting: !!rec.isTaxPosting,
      projectCode: nonBlank(rec.projectCode) || undefined,
      projectName: nonBlank(rec.projectName) || undefined,
    });
  }
  if (out.length === 0) return { ok: false, reason: "no-rows" };
  return { ok: true, rows: out };
}
