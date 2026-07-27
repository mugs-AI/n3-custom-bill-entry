// Purchase Audit Trail reconciliation — Phase 3B Correction C.
//
// PurchaseBook is no longer a gate or filter. The authoritative audit
// document set is the Purchase Invoice list already produced by the current
// GL Analysis inquiry. For every PI in that list we:
//
//   1. Match GL rows by canonical docCode (NFKC + trim + uppercase).
//   2. Identify the creditor line(s) where canonical(accountCode) equals
//      canonical(pi.supplierCode). Multiple creditor rows are aggregated
//      into a single displayed creditor line.
//   3. Compute per-document Debit/Credit and Grand Debit/Credit from the
//      matched GL rows only. A document with zero GL rows is retained but
//      flagged incomplete — it never disappears from the report.
//
// No comparison is made between GL Grand Debit and the PI Including-Tax
// totals from GL Analysis, and no PurchaseBook postingSummary check is
// performed. Both are legitimately different figures.

import { round2, sumTo2dp } from "./money";
import { canonicalAccountCode, canonicalDocCode } from "./report-keys";

export interface GLRow {
  accountCode?: string;
  accountName?: string;
  debitLocal?: number;
  creditLocal?: number;
  docCode?: string;
  docDate?: string;
  description?: string;
  detailDescription?: string;
  referenceNo?: string;
  supplierInvNo?: string;
  currencyCode?: string;
  currencyRate?: number;
  docType?: string;
  isBalanceBF?: boolean;
  isTaxPosting?: boolean;
  isCancelled?: boolean;
  projectCode?: string;
  projectName?: string;
}

/**
 * Purchase Invoice header projection consumed by the audit reconciliation.
 * Sourced from the current GL Analysis inquiry — no PurchaseBook needed.
 * Term/Currency fields are display-only and safe to leave blank.
 */
export interface AuditPIDocument {
  invoiceId?: string;
  docCode: string;
  docDate?: string;
  dueDate?: string;
  supplierCode?: string;
  supplierName?: string;
  /** Supplier invoice number — required to resolve continuation GL rows
   *  whose docCode was omitted by N3. */
  supplierInvNo?: string;
  termCode?: string;
  termDescription?: string;
  currencyCode?: string;
  currencyRate?: number;
}

export interface PostingRow {
  accountCode: string;
  accountName: string;
  currencyCode: string;
  currencyRate: number;
  debit: number;
  credit: number;
  isSupplierCreditor: boolean;
  isTaxPosting: boolean;
}

export interface AuditDocument {
  invoiceId: string;
  docCode: string;
  docDate: string;
  supplierCode: string;
  supplierName: string;
  termDescription: string;
  dueDate: string;
  currencyCode: string;
  currencyRate: number;
  creditor: PostingRow | null;
  postings: PostingRow[];
  debit: number;
  credit: number;
  balanced: boolean;
  incomplete: boolean;
  incompleteReason?: string;
}

export interface PostingAccountRow {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

export type BalanceStatus = "balanced" | "unbalanced" | "not-evaluated";

export interface PurchaseAuditResult {
  documents: AuditDocument[];
  postingAccounts: PostingAccountRow[];
  grandDebit: number;
  grandCredit: number;
  balanced: boolean;
  balanceStatus: BalanceStatus;
  isComplete: boolean;
  incompleteReasons: string[];
  auditDocCodes: string[];
  glRowsUsed: number;
  /** PI docCodes that produced zero matching GL rows. */
  docsWithoutGL: string[];
}

function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Filter GL rows down to the audit doc set, excluding cancelled and B/F.
 * Match is case/whitespace-insensitive on docCode.
 */
export function filterAuditGL(rows: GLRow[], auditDocCodes: string[]): GLRow[] {
  const set = new Set(auditDocCodes.map(canonicalDocCode));
  return rows.filter((r) => {
    if (r.isCancelled) return false;
    if (r.isBalanceBF) return false;
    return set.has(canonicalDocCode(r.docCode));
  });
}

function toPosting(r: GLRow, isCreditor: boolean): PostingRow {
  return {
    accountCode: (r.accountCode ?? "").trim(),
    accountName: r.accountName ?? "",
    currencyCode: r.currencyCode ?? "MYR",
    currencyRate: safeNum(r.currencyRate) || 1,
    debit: round2(safeNum(r.debitLocal)),
    credit: round2(safeNum(r.creditLocal)),
    isSupplierCreditor: isCreditor,
    isTaxPosting: !!r.isTaxPosting,
  };
}

function aggregateCreditor(rows: GLRow[]): PostingRow | null {
  if (rows.length === 0) return null;
  const first = rows[0];
  const debit = round2(sumTo2dp(rows.map((r) => safeNum(r.debitLocal))));
  const credit = round2(sumTo2dp(rows.map((r) => safeNum(r.creditLocal))));
  return {
    accountCode: (first.accountCode ?? "").trim(),
    accountName: first.accountName ?? "",
    currencyCode: first.currencyCode ?? "MYR",
    currencyRate: safeNum(first.currencyRate) || 1,
    debit,
    credit,
    isSupplierCreditor: true,
    isTaxPosting: false,
  };
}

/**
 * Build one AuditDocument per Purchase Invoice. Documents with no matching
 * GL rows are retained and flagged incomplete.
 */
export function buildAuditDocuments(
  piDocuments: AuditPIDocument[],
  glRows: GLRow[],
): AuditDocument[] {
  const glByDoc = new Map<string, GLRow[]>();
  for (const r of glRows) {
    const c = canonicalDocCode(r.docCode);
    if (!c) continue;
    if (!glByDoc.has(c)) glByDoc.set(c, []);
    glByDoc.get(c)!.push(r);
  }
  const out: AuditDocument[] = [];
  const seen = new Set<string>();
  for (const pi of piDocuments) {
    const key = canonicalDocCode(pi.docCode);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rows = glByDoc.get(key) ?? [];
    const supplierKey = canonicalAccountCode(pi.supplierCode ?? "");
    const creditorRows = supplierKey
      ? rows.filter((r) => canonicalAccountCode(r.accountCode) === supplierKey)
      : [];
    const otherRows = supplierKey
      ? rows.filter((r) => canonicalAccountCode(r.accountCode) !== supplierKey)
      : rows.slice();
    const creditor = aggregateCreditor(creditorRows);
    const postings = otherRows.map((r) => toPosting(r, false));
    const debit = round2(sumTo2dp(rows.map((r) => safeNum(r.debitLocal))));
    const credit = round2(sumTo2dp(rows.map((r) => safeNum(r.creditLocal))));
    const hasRows = rows.length > 0;
    const balanced = hasRows && Math.abs(debit - credit) < 0.011;
    const incomplete = !hasRows || !balanced;
    const incompleteReason = !hasRows
      ? "No matching GL postings found for this Purchase Invoice."
      : !balanced
        ? "Document Debit and Credit do not balance."
        : undefined;
    out.push({
      invoiceId: pi.invoiceId ?? "",
      docCode: pi.docCode,
      docDate: pi.docDate ?? "",
      supplierCode: pi.supplierCode ?? "",
      supplierName: pi.supplierName ?? "",
      termDescription: pi.termDescription ?? pi.termCode ?? "",
      dueDate: pi.dueDate ?? "",
      currencyCode: pi.currencyCode ?? "MYR",
      currencyRate:
        typeof pi.currencyRate === "number" && Number.isFinite(pi.currencyRate)
          ? pi.currencyRate
          : 1,
      creditor,
      postings,
      debit,
      credit,
      balanced,
      incomplete,
      incompleteReason,
    });
  }
  out.sort(
    (a, b) => a.docDate.localeCompare(b.docDate) || a.docCode.localeCompare(b.docCode),
  );
  return out;
}

/**
 * Aggregate GL rows by canonical account code → View 2 rows. The first
 * original casing seen is displayed so the operator sees the account
 * exactly as N3 stored it.
 */
export function summarizePostingAccounts(rows: GLRow[]): PostingAccountRow[] {
  const map = new Map<string, PostingAccountRow>();
  for (const r of rows) {
    const raw = (r.accountCode ?? "").trim();
    if (!raw) continue;
    const key = canonicalAccountCode(raw);
    let acc = map.get(key);
    if (!acc) {
      acc = { accountCode: raw, accountName: r.accountName ?? "", debit: 0, credit: 0 };
      map.set(key, acc);
    } else if (!acc.accountName && r.accountName) acc.accountName = r.accountName;
    acc.debit = round2(acc.debit + safeNum(r.debitLocal));
    acc.credit = round2(acc.credit + safeNum(r.creditLocal));
  }
  return [...map.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

/**
 * Reconcile the PI-driven audit set against the matched GL rows.
 */
export function reconcileAudit(
  piDocuments: AuditPIDocument[],
  glRows: GLRow[],
): PurchaseAuditResult {
  const auditDocCodes: string[] = [];
  const seen = new Set<string>();
  for (const pi of piDocuments) {
    const key = canonicalDocCode(pi.docCode);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    auditDocCodes.push(pi.docCode);
  }
  const filteredGL = filterAuditGL(glRows, auditDocCodes);
  const documents = buildAuditDocuments(piDocuments, filteredGL);
  const postingAccounts = summarizePostingAccounts(filteredGL);

  const grandDebit = round2(sumTo2dp(filteredGL.map((r) => safeNum(r.debitLocal))));
  const grandCredit = round2(sumTo2dp(filteredGL.map((r) => safeNum(r.creditLocal))));
  const grandBalanced = Math.abs(grandDebit - grandCredit) < 0.011;

  const docsWithoutGL = documents
    .filter((d) => d.creditor === null && d.postings.length === 0)
    .map((d) => d.docCode);
  const anyDocIncomplete = documents.some((d) => d.incomplete);

  const evaluated = filteredGL.length > 0;
  const incompleteReasons: string[] = [];
  if (docsWithoutGL.length > 0) {
    incompleteReasons.push(
      `${docsWithoutGL.length} Purchase Invoice${docsWithoutGL.length === 1 ? "" : "s"} have no matching GL postings.`,
    );
  }
  if (evaluated && !grandBalanced) {
    incompleteReasons.push("Grand Debit and Grand Credit do not balance.");
  } else if (evaluated && anyDocIncomplete && docsWithoutGL.length === 0) {
    incompleteReasons.push("One or more documents did not reconcile per-document.");
  }

  const balanceStatus: BalanceStatus = !evaluated
    ? "not-evaluated"
    : grandBalanced && !anyDocIncomplete
      ? "balanced"
      : "unbalanced";

  return {
    documents,
    postingAccounts,
    grandDebit,
    grandCredit,
    balanced: balanceStatus === "balanced",
    balanceStatus,
    isComplete: incompleteReasons.length === 0 && evaluated,
    incompleteReasons,
    auditDocCodes,
    glRowsUsed: filteredGL.length,
    docsWithoutGL,
  };
}
