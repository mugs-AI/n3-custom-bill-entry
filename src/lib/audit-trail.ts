// Purchase Audit Trail reconciliation (Phase 3B Views 1-2).
//
// Pure helpers that take PurchaseBook, GL and the current Purchase Invoice
// audit doc-code set and:
//   1. Determine the final audit document set = intersection(PB, PI).
//   2. Group GL rows per document (exact docCode match) and per posting
//      account (accountCode).
//   3. Check per-document Debit/Credit balance, Grand Debit/Credit balance,
//      and — only when the PB doc set equals the PI doc set — check the
//      signed PB postingSummary against `glNet = debit - credit`.
//   4. Return a `PurchaseAuditResult` explicitly flagging incomplete/
//      incompleteReason instead of showing partial-looking totals.
//
// The final visible Debit/Credit numbers always come from GL, never from
// splitting a signed PB amount. This preserves accounts with mixed debit/
// credit activity.

import { round2, sumTo2dp } from "./money";
import type { PurchaseBookDetailItem, PurchaseBookPostingSummaryRow } from "./purchase-book";

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
  docCode: string;
  docDate: string;
  supplierCode: string;
  supplierName: string;
  termDescription: string;
  dueDate: string;
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

export interface PurchaseAuditResult {
  documents: AuditDocument[];
  postingAccounts: PostingAccountRow[];
  grandDebit: number;
  grandCredit: number;
  balanced: boolean;
  isComplete: boolean;
  incompleteReasons: string[];
  summaryCheck:
    | { kind: "matched"; convention: "positive-debit" | "positive-credit" }
    | { kind: "mismatch"; accounts: string[] }
    | { kind: "skipped"; reason: string };
  auditDocCodes: string[];
  glRowsUsed: number;
}

/** Normalize a docCode key: trim + case-insensitive compare. */
function normDoc(s: string | undefined): string {
  return (s ?? "").trim();
}

function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Compute the final audit doc-code set (intersection of PB and PI). */
export function computeAuditDocCodes(
  pbDetails: PurchaseBookDetailItem[],
  piDocCodes: string[],
): { audit: string[]; pbOnly: string[]; piOnly: string[]; identical: boolean } {
  const pb = new Set<string>();
  for (const d of pbDetails) {
    if (d.isCancelled) continue;
    const c = normDoc(d.docCode);
    if (c) pb.add(c);
  }
  const pi = new Set<string>(piDocCodes.map(normDoc).filter(Boolean));
  const audit = [...pi].filter((c) => pb.has(c)).sort();
  const pbOnly = [...pb].filter((c) => !pi.has(c));
  const piOnly = [...pi].filter((c) => !pb.has(c));
  return { audit, pbOnly, piOnly, identical: pbOnly.length === 0 && piOnly.length === 0 };
}

/** Filter GL rows to the final audit doc set, excluding cancelled and B/F. */
export function filterAuditGL(rows: GLRow[], auditDocCodes: string[]): GLRow[] {
  const set = new Set(auditDocCodes.map(normDoc));
  return rows.filter((r) => {
    if (r.isCancelled) return false;
    if (r.isBalanceBF) return false;
    const c = normDoc(r.docCode);
    return set.has(c);
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

/**
 * Build the per-document audit view. For each document the row whose
 * `accountCode` matches the supplier code (from PurchaseBook detailItems) is
 * the creditor line and appears on the header; every other row appears
 * nested. If no unique creditor line is found the document is marked
 * incomplete (rather than silently guessing).
 */
export function buildAuditDocuments(
  pbDetails: PurchaseBookDetailItem[],
  glRows: GLRow[],
  auditDocCodes: string[],
): AuditDocument[] {
  const glByDoc = new Map<string, GLRow[]>();
  for (const r of glRows) {
    const c = normDoc(r.docCode);
    if (!glByDoc.has(c)) glByDoc.set(c, []);
    glByDoc.get(c)!.push(r);
  }
  const pbByDoc = new Map<string, PurchaseBookDetailItem>();
  for (const d of pbDetails) {
    const c = normDoc(d.docCode);
    if (c && !pbByDoc.has(c)) pbByDoc.set(c, d);
  }
  const out: AuditDocument[] = [];
  for (const code of auditDocCodes) {
    const pb = pbByDoc.get(code);
    const rows = glByDoc.get(code) ?? [];
    const supplierCode = (pb?.supplierCode ?? "").trim();
    const creditorRows = supplierCode
      ? rows.filter((r) => (r.accountCode ?? "").trim() === supplierCode)
      : [];
    const otherRows = supplierCode
      ? rows.filter((r) => (r.accountCode ?? "").trim() !== supplierCode)
      : rows.slice();

    const debit = round2(sumTo2dp(rows.map((r) => safeNum(r.debitLocal))));
    const credit = round2(sumTo2dp(rows.map((r) => safeNum(r.creditLocal))));
    const balanced = Math.abs(debit - credit) < 0.011;

    let creditor: PostingRow | null = null;
    let postings: PostingRow[];
    let incomplete = rows.length === 0;
    let incompleteReason = rows.length === 0 ? "No matching GL postings found." : undefined;

    if (creditorRows.length === 1) {
      creditor = toPosting(creditorRows[0], true);
      postings = otherRows.map((r) => toPosting(r, false));
    } else {
      // Cannot uniquely identify the creditor line — surface every posting
      // and mark the document incomplete.
      postings = rows.map((r) => toPosting(r, false));
      if (rows.length > 0) {
        incomplete = true;
        incompleteReason = supplierCode
          ? `Could not uniquely identify creditor posting for ${supplierCode} (${creditorRows.length} matches).`
          : "PurchaseBook did not supply a supplier code for creditor matching.";
      }
    }

    out.push({
      docCode: code,
      docDate: pb?.docDate ?? "",
      supplierCode,
      supplierName: pb?.supplierName ?? "",
      termDescription: pb?.termDescription ?? pb?.termCode ?? "",
      dueDate: pb?.dueDate ?? "",
      creditor,
      postings,
      debit,
      credit,
      balanced,
      incomplete: incomplete || !balanced,
      incompleteReason:
        incompleteReason ?? (!balanced ? "Document Debit and Credit do not balance." : undefined),
    });
  }
  out.sort(
    (a, b) => a.docDate.localeCompare(b.docDate) || a.docCode.localeCompare(b.docCode),
  );
  return out;
}

/** Aggregate GL rows by account code → View 2 rows. */
export function summarizePostingAccounts(rows: GLRow[]): PostingAccountRow[] {
  const map = new Map<string, PostingAccountRow>();
  for (const r of rows) {
    const code = (r.accountCode ?? "").trim();
    if (!code) continue;
    let acc = map.get(code);
    if (!acc) {
      acc = { accountCode: code, accountName: r.accountName ?? "", debit: 0, credit: 0 };
      map.set(code, acc);
    } else if (!acc.accountName && r.accountName) acc.accountName = r.accountName;
    acc.debit = round2(acc.debit + safeNum(r.debitLocal));
    acc.credit = round2(acc.credit + safeNum(r.creditLocal));
  }
  return [...map.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

/**
 * Full audit reconciliation. `pbOnly` / `piOnly` in the doc-set comparison
 * decide whether the PB signed posting-summary check is meaningful.
 */
export function reconcileAudit(
  pbDetails: PurchaseBookDetailItem[],
  pbSummary: PurchaseBookPostingSummaryRow[],
  glRows: GLRow[],
  piDocCodes: string[],
): PurchaseAuditResult {
  const { audit, pbOnly, identical } = computeAuditDocCodes(pbDetails, piDocCodes);
  const filteredGL = filterAuditGL(glRows, audit);
  const documents = buildAuditDocuments(pbDetails, filteredGL, audit);
  const postingAccounts = summarizePostingAccounts(filteredGL);

  const grandDebit = sumTo2dp(documents.map((d) => d.debit));
  const grandCredit = sumTo2dp(documents.map((d) => d.credit));
  const grandBalanced = Math.abs(grandDebit - grandCredit) < 0.011;

  const incompleteReasons: string[] = [];
  const anyDocIncomplete = documents.some((d) => d.incomplete);
  if (audit.length === 0) incompleteReasons.push("No documents intersect between PurchaseBook and Purchase Invoice audit set.");
  if (anyDocIncomplete) incompleteReasons.push("One or more documents did not reconcile per-document.");
  if (!grandBalanced) incompleteReasons.push("Grand Debit and Grand Credit do not balance.");

  // Signed summary check — only meaningful when PB and PI doc sets are equal.
  let summaryCheck: PurchaseAuditResult["summaryCheck"];
  if (!identical) {
    summaryCheck = {
      kind: "skipped",
      reason:
        pbOnly.length > 0
          ? "PurchaseBook contains other purchase documents outside this app's Purchase Invoice audit set; signed posting-summary comparison skipped."
          : "PurchaseBook and Purchase Invoice document sets differ; signed posting-summary comparison skipped.",
    };
  } else if (pbSummary.length === 0) {
    // Empty posting rows are never proof of balance.
    summaryCheck = {
      kind: "mismatch",
      accounts: [],
    };
    incompleteReasons.push("PurchaseBook postingSummary is empty; cannot verify signed convention.");
  } else {
    const glNetByAccount = new Map<string, number>();
    for (const acc of postingAccounts) {
      glNetByAccount.set(acc.accountCode, round2(acc.debit - acc.credit));
    }
    const check = (posIsDebit: boolean) => {
      const mismatched: string[] = [];
      for (const s of pbSummary) {
        const code = (s.accountCode ?? "").trim();
        if (!code) continue;
        const amt = safeNum(s.amount);
        const signedAmt = posIsDebit ? amt : -amt;
        const glNet = glNetByAccount.get(code) ?? 0;
        if (Math.abs(round2(signedAmt - glNet)) > 0.011) mismatched.push(code);
      }
      return mismatched;
    };
    const a = check(true);
    const b = check(false);
    if (a.length === 0) summaryCheck = { kind: "matched", convention: "positive-debit" };
    else if (b.length === 0) summaryCheck = { kind: "matched", convention: "positive-credit" };
    else {
      summaryCheck = { kind: "mismatch", accounts: [...new Set([...a, ...b])].sort() };
      incompleteReasons.push("PurchaseBook postingSummary does not reconcile to GL net amounts under either sign convention.");
    }
  }

  return {
    documents,
    postingAccounts,
    grandDebit,
    grandCredit,
    balanced: grandBalanced,
    isComplete: incompleteReasons.length === 0,
    incompleteReasons,
    summaryCheck,
    auditDocCodes: audit,
    glRowsUsed: filteredGL.length,
  };
}
