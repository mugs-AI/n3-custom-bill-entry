// Purchase Audit Trail reconciliation (Phase 3B Views 1-2).
//
// Pure helpers that take PurchaseBook, GL and the current Purchase Invoice
// audit doc-code set and:
//   1. Determine the final audit document set = intersection(PB, PI) using
//      the shared canonical document-key rule (NFKC + trim + uppercase).
//   2. Group GL rows per document (canonical docCode match) and per posting
//      account (canonical accountCode).
//   3. Check per-document Debit/Credit balance, Grand Debit/Credit balance,
//      and — only when the PB doc set equals the PI doc set — check the
//      signed PB postingSummary against `glNet = debit - credit`.
//   4. Return a `PurchaseAuditResult` explicitly flagging incomplete/
//      incompleteReason and an explicit balanceStatus so the UI never shows
//      "Balanced: Yes" when nothing was evaluated.

import { round2, sumTo2dp } from "./money";
import {
  purchaseBookSupplierCode,
  type PurchaseBookDetailItem,
  type PurchaseBookPostingSummaryRow,
} from "./purchase-book";
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
  summaryCheck:
    | { kind: "matched"; convention: "positive-debit" | "positive-credit" }
    | { kind: "mismatch"; accounts: string[] }
    | { kind: "skipped"; reason: string };
  auditDocCodes: string[];
  glRowsUsed: number;
}

function safeNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Compute the audit doc-code set — the case-insensitive intersection of PB
 * (non-cancelled) and the current Purchase Invoice set. Returns original PI
 * casings so the UI displays the value N3's main API returned.
 */
export function computeAuditDocCodes(
  pbDetails: PurchaseBookDetailItem[],
  piDocCodes: string[],
): { audit: string[]; pbOnly: string[]; piOnly: string[]; identical: boolean } {
  const pb = new Map<string, string>();
  for (const d of pbDetails) {
    if (d.isCancelled) continue;
    const raw = typeof d.docCode === "string" ? d.docCode.trim() : "";
    if (!raw) continue;
    const key = canonicalDocCode(raw);
    if (!pb.has(key)) pb.set(key, raw);
  }
  const pi = new Map<string, string>();
  for (const raw of piDocCodes) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) continue;
    const key = canonicalDocCode(trimmed);
    if (!pi.has(key)) pi.set(key, trimmed);
  }
  const audit: string[] = [];
  for (const [key, raw] of pi) if (pb.has(key)) audit.push(raw);
  audit.sort((a, b) => a.localeCompare(b));
  const pbOnly: string[] = [];
  for (const [key, raw] of pb) if (!pi.has(key)) pbOnly.push(raw);
  const piOnly: string[] = [];
  for (const [key, raw] of pi) if (!pb.has(key)) piOnly.push(raw);
  return { audit, pbOnly, piOnly, identical: pbOnly.length === 0 && piOnly.length === 0 };
}

/** Filter GL rows to the final audit doc set, excluding cancelled and B/F. */
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

/**
 * Build the per-document audit view. Creditor line is identified by matching
 * the GL row's canonical `accountCode` against the PurchaseBook supplier code
 * (canonical), so PB-vs-GL casing differences never split the join.
 */
export function buildAuditDocuments(
  pbDetails: PurchaseBookDetailItem[],
  glRows: GLRow[],
  auditDocCodes: string[],
): AuditDocument[] {
  const glByDoc = new Map<string, GLRow[]>();
  for (const r of glRows) {
    const c = canonicalDocCode(r.docCode);
    if (!c) continue;
    if (!glByDoc.has(c)) glByDoc.set(c, []);
    glByDoc.get(c)!.push(r);
  }
  const pbByDoc = new Map<string, PurchaseBookDetailItem>();
  for (const d of pbDetails) {
    const c = canonicalDocCode(d.docCode);
    if (c && !pbByDoc.has(c)) pbByDoc.set(c, d);
  }
  const out: AuditDocument[] = [];
  for (const code of auditDocCodes) {
    const key = canonicalDocCode(code);
    const pb = pbByDoc.get(key);
    const rows = glByDoc.get(key) ?? [];
    const supplierCode = purchaseBookSupplierCode(pb);
    const supplierKey = canonicalAccountCode(supplierCode);
    const creditorRows = supplierKey
      ? rows.filter((r) => canonicalAccountCode(r.accountCode) === supplierKey)
      : [];
    const otherRows = supplierKey
      ? rows.filter((r) => canonicalAccountCode(r.accountCode) !== supplierKey)
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

/**
 * Aggregate GL rows by canonical account code → View 2 rows. The first
 * original casing seen is used for display so the operator sees the account
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
  if (audit.length === 0)
    incompleteReasons.push("No documents intersect between PurchaseBook and Purchase Invoice audit set.");
  if (audit.length > 0 && filteredGL.length === 0)
    incompleteReasons.push("No General Ledger rows were found for the intersected documents.");
  if (anyDocIncomplete) incompleteReasons.push("One or more documents did not reconcile per-document.");
  if (audit.length > 0 && filteredGL.length > 0 && !grandBalanced)
    incompleteReasons.push("Grand Debit and Grand Credit do not balance.");

  // Signed summary check — only meaningful when PB and PI doc sets are equal.
  let summaryCheck: PurchaseAuditResult["summaryCheck"];
  if (audit.length === 0 || filteredGL.length === 0) {
    summaryCheck = {
      kind: "skipped",
      reason: "Nothing evaluated; signed posting-summary comparison skipped.",
    };
  } else if (!identical) {
    summaryCheck = {
      kind: "skipped",
      reason:
        pbOnly.length > 0
          ? "PurchaseBook contains other purchase documents outside this app's Purchase Invoice audit set; signed posting-summary comparison skipped."
          : "PurchaseBook and Purchase Invoice document sets differ; signed posting-summary comparison skipped.",
    };
  } else if (pbSummary.length === 0) {
    summaryCheck = { kind: "mismatch", accounts: [] };
    incompleteReasons.push("PurchaseBook postingSummary is empty; cannot verify signed convention.");
  } else {
    const glNetByAccount = new Map<string, number>();
    for (const acc of postingAccounts) {
      glNetByAccount.set(canonicalAccountCode(acc.accountCode), round2(acc.debit - acc.credit));
    }
    const check = (posIsDebit: boolean) => {
      const mismatched: string[] = [];
      for (const s of pbSummary) {
        const raw = (s.accountCode ?? "").trim();
        if (!raw) continue;
        const key = canonicalAccountCode(raw);
        const amt = safeNum(s.amount);
        const signedAmt = posIsDebit ? amt : -amt;
        const glNet = glNetByAccount.get(key) ?? 0;
        if (Math.abs(round2(signedAmt - glNet)) > 0.011) mismatched.push(raw);
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

  const evaluated = audit.length > 0 && filteredGL.length > 0;
  let balanceStatus: BalanceStatus;
  if (!evaluated) balanceStatus = "not-evaluated";
  else if (grandBalanced && !anyDocIncomplete) balanceStatus = "balanced";
  else balanceStatus = "unbalanced";

  return {
    documents,
    postingAccounts,
    grandDebit,
    grandCredit,
    balanced: balanceStatus === "balanced",
    balanceStatus,
    isComplete: incompleteReasons.length === 0 && evaluated,
    incompleteReasons,
    summaryCheck,
    auditDocCodes: audit,
    glRowsUsed: filteredGL.length,
  };
}
