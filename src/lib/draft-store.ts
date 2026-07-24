// Session-scoped preservation of an unfinished New Bill Entry.
//
// - Storage: sessionStorage (survives Settings navigation and same-tab refresh;
//   does NOT leak to other tabs or persist after tab close).
// - Namespaced by immutable N3 tenant + user IDs from the JWT so switching
//   companies/accounts on the same browser never restores foreign data.
// - Never stores tokens, API keys, or credentials — only the form values the
//   user typed and the immutable N3 IDs they selected.
// - Schema-versioned; corrupt or old drafts are safely discarded.

import { decodeJwt, getToken } from "./auth-store";

export const DRAFT_SCHEMA_VERSION = 1;
export const DRAFT_EVENT = "custom-bill-entry:draft-change";

export interface DraftLine {
  key: string;
  stockId: number | null;
  stockCode: string;
  stockName: string;
  itemDescription: string;
  itemDescriptionTouched: boolean;
  uomId: number | null;
  uomCode: string;
  glAccountId: string | null;
  glAccountCode: string;
  glAccountName: string;
  projectId: number | null;
  projectCode: string;
  projectName: string;
  taxCodeId: number | null;
  taxCodeCode: string;
  taxCodeName: string;
  tariffCodeId: number | null;
  tariffCodeCode: string;
  tariffCodeName: string;
  qty: string;
  unitPrice: string;
  refNo: string;
}

export interface BillDraft {
  schemaVersion: number;
  savedAt: number;
  docDate: string;
  supplierId: number | null;
  supplierLabel: string;
  purchaserId: number | null;
  purchaserLabel: string;
  termId: number | null;
  termLabel: string;
  termTouched: boolean;
  description: string;
  referenceNo: string;
  supplierInvNo: string;
  isTaxInclusive: boolean;
  lines: DraftLine[];
}

function pickClaim(p: Record<string, unknown> | null, keys: string[]): string | null {
  if (!p) return null;
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

export function getAuthScope(): { tenantId: string; userId: string } {
  const t = getToken();
  const payload = t ? decodeJwt(t) : null;
  const tenantId =
    pickClaim(payload, ["tid", "tenantId", "tenant_id", "dbcode", "dbCode", "dbId"]) ?? "unknown";
  const userId =
    pickClaim(payload, ["sub", "uid", "userId", "user_id", "nameid", "oid"]) ?? "unknown";
  return { tenantId, userId };
}

export function draftStorageKey(scope = getAuthScope()): string {
  return `custom-bill-entry:draft:${scope.tenantId}:${scope.userId}`;
}

function safeSession(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isNumOrNull(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}
function isStrOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function coerceLine(raw: unknown): DraftLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isStr(r.key)) return null;
  return {
    key: r.key,
    stockId: isNumOrNull(r.stockId) ? r.stockId : null,
    stockCode: isStr(r.stockCode) ? r.stockCode : "",
    stockName: isStr(r.stockName) ? r.stockName : "",
    itemDescription: isStr(r.itemDescription) ? r.itemDescription : "",
    itemDescriptionTouched: !!r.itemDescriptionTouched,
    uomId: isNumOrNull(r.uomId) ? r.uomId : null,
    uomCode: isStr(r.uomCode) ? r.uomCode : "",
    glAccountId: isStrOrNull(r.glAccountId) ? r.glAccountId : null,
    glAccountCode: isStr(r.glAccountCode) ? r.glAccountCode : "",
    glAccountName: isStr(r.glAccountName) ? r.glAccountName : "",
    projectId: isNumOrNull(r.projectId) ? r.projectId : null,
    projectCode: isStr(r.projectCode) ? r.projectCode : "",
    projectName: isStr(r.projectName) ? r.projectName : "",
    taxCodeId: isNumOrNull(r.taxCodeId) ? r.taxCodeId : null,
    taxCodeCode: isStr(r.taxCodeCode) ? r.taxCodeCode : "",
    taxCodeName: isStr(r.taxCodeName) ? r.taxCodeName : "",
    tariffCodeId: isNumOrNull(r.tariffCodeId) ? r.tariffCodeId : null,
    tariffCodeCode: isStr(r.tariffCodeCode) ? r.tariffCodeCode : "",
    tariffCodeName: isStr(r.tariffCodeName) ? r.tariffCodeName : "",
    qty: isStr(r.qty) ? r.qty : "",
    unitPrice: isStr(r.unitPrice) ? r.unitPrice : "",
    refNo: isStr(r.refNo) ? r.refNo : "",
  };
}

export function coerceDraft(raw: unknown): BillDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== DRAFT_SCHEMA_VERSION) return null;
  const lines = Array.isArray(r.lines) ? r.lines.map(coerceLine).filter((x): x is DraftLine => !!x) : [];
  if (lines.length === 0) return null;
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    savedAt: typeof r.savedAt === "number" ? r.savedAt : Date.now(),
    docDate: isStr(r.docDate) ? r.docDate : "",
    supplierId: isNumOrNull(r.supplierId) ? r.supplierId : null,
    supplierLabel: isStr(r.supplierLabel) ? r.supplierLabel : "",
    purchaserId: isNumOrNull(r.purchaserId) ? r.purchaserId : null,
    purchaserLabel: isStr(r.purchaserLabel) ? r.purchaserLabel : "",
    termId: isNumOrNull(r.termId) ? r.termId : null,
    termLabel: isStr(r.termLabel) ? r.termLabel : "",
    termTouched: !!r.termTouched,
    description: isStr(r.description) ? r.description : "",
    referenceNo: isStr(r.referenceNo) ? r.referenceNo : "",
    supplierInvNo: isStr(r.supplierInvNo) ? r.supplierInvNo : "",
    isTaxInclusive: isBool(r.isTaxInclusive) ? r.isTaxInclusive : false,
    lines,
  };
}

export function loadDraft(): BillDraft | null {
  const s = safeSession();
  if (!s) return null;
  try {
    const raw = s.getItem(draftStorageKey());
    if (!raw) return null;
    return coerceDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveDraft(d: BillDraft): void {
  const s = safeSession();
  if (!s) return;
  try {
    const payload: BillDraft = { ...d, schemaVersion: DRAFT_SCHEMA_VERSION, savedAt: Date.now() };
    s.setItem(draftStorageKey(), JSON.stringify(payload));
    window.dispatchEvent(new Event(DRAFT_EVENT));
  } catch {
    // ignore quota / access errors
  }
}

export function clearDraft(scope?: { tenantId: string; userId: string }): void {
  const s = safeSession();
  if (!s) return;
  try {
    s.removeItem(draftStorageKey(scope));
    window.dispatchEvent(new Event(DRAFT_EVENT));
  } catch {
    // ignore
  }
}

/** Best-effort clear of every draft key (used on Sign Out). */
export function clearAllDrafts(): void {
  const s = safeSession();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith("custom-bill-entry:draft:")) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
    window.dispatchEvent(new Event(DRAFT_EVENT));
  } catch {
    // ignore
  }
}
