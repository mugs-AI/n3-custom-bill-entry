// Per-user, per-tenant item-line layout preference stored in localStorage.
// The layout drives the two-row Item card in New Bill Entry. Storage is
// namespaced by immutable N3 tenant + user IDs parsed from the JWT so
// switching companies or accounts on the same browser doesn't leak
// layouts across contexts.
//
// Field ids are immutable — they never rename after ship. Row labels /
// display names come from FIELD_LABELS below.

import { decodeJwt, getToken } from "./auth-store";

export const FIELD_IDS = [
  "wbs",
  "itemDescription",
  "glAccount",
  "glAccountName",
  "costCentre",
  "hqTax",
  "orderNo",
  "qty",
  "unitPrice",
  "netAmount",
  "refNo",
] as const;
export type FieldId = (typeof FIELD_IDS)[number];

export const FIELD_LABELS: Record<FieldId, string> = {
  wbs: "WBS",
  itemDescription: "Item Description",
  glAccount: "GL Account",
  glAccountName: "GL Account Name",
  costCentre: "Cost Centre",
  hqTax: "HQ Tax",
  orderNo: "Order No.",
  qty: "Qty",
  unitPrice: "Unit Price",
  netAmount: "Net Amount",
  refNo: "Ref. No.",
};

export const READONLY_FIELDS: ReadonlySet<FieldId> = new Set<FieldId>([
  "glAccountName",
  "netAmount",
]);

export interface ItemLayout {
  schemaVersion: number;
  row1: FieldId[];
  row2: FieldId[];
}

export const LAYOUT_SCHEMA_VERSION = 1;
export const MAX_PER_ROW = 6;

export const DEFAULT_LAYOUT: ItemLayout = {
  schemaVersion: LAYOUT_SCHEMA_VERSION,
  row1: ["wbs", "itemDescription", "glAccount", "glAccountName", "costCentre"],
  row2: ["hqTax", "orderNo", "qty", "unitPrice", "netAmount", "refNo"],
};

export const LAYOUT_EVENT = "custom-bill-entry:item-layout-change";

function pickClaim(p: Record<string, unknown> | null, keys: string[]): string | null {
  if (!p) return null;
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** Immutable tenant + user ids from the current JWT (client-only). */
export function getLayoutScope(): { tenantId: string; userId: string } {
  const t = getToken();
  const payload = t ? decodeJwt(t) : null;
  const tenantId =
    pickClaim(payload, ["tid", "tenantId", "tenant_id", "dbcode", "dbCode", "dbId"]) ?? "unknown";
  const userId =
    pickClaim(payload, ["sub", "uid", "userId", "user_id", "nameid", "oid"]) ?? "unknown";
  return { tenantId, userId };
}

export function layoutStorageKey(scope = getLayoutScope()): string {
  return `custom-bill-entry:item-layout:${scope.tenantId}:${scope.userId}`;
}

// -------------------- validate + migrate --------------------

function isFieldId(v: unknown): v is FieldId {
  return typeof v === "string" && (FIELD_IDS as readonly string[]).includes(v);
}

/**
 * Coerce arbitrary parsed JSON into a valid layout. Unknown/obsolete field ids
 * are dropped; newly introduced fields are appended to the shorter row up to
 * MAX_PER_ROW. Never throws — corrupt input returns DEFAULT_LAYOUT.
 */
export function coerceLayout(raw: unknown): ItemLayout {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LAYOUT };
  const r = raw as Partial<ItemLayout>;
  const r1 = Array.isArray(r.row1) ? r.row1.filter(isFieldId) : [];
  const r2 = Array.isArray(r.row2) ? r.row2.filter(isFieldId) : [];
  // dedupe across both rows
  const seen = new Set<FieldId>();
  const row1: FieldId[] = [];
  const row2: FieldId[] = [];
  for (const id of r1)
    if (!seen.has(id) && row1.length < MAX_PER_ROW) {
      seen.add(id);
      row1.push(id);
    }
  for (const id of r2)
    if (!seen.has(id) && row2.length < MAX_PER_ROW) {
      seen.add(id);
      row2.push(id);
    }
  // append missing fields
  const defaults = [...DEFAULT_LAYOUT.row1, ...DEFAULT_LAYOUT.row2];
  for (const id of defaults) {
    if (seen.has(id)) continue;
    if (row2.length < MAX_PER_ROW) {
      row2.push(id);
      seen.add(id);
      continue;
    }
    if (row1.length < MAX_PER_ROW) {
      row1.push(id);
      seen.add(id);
      continue;
    }
    // both full — shouldn't happen with 11 fields / max 6 per row
  }
  if (row1.length === 0 || row2.length === 0) return { ...DEFAULT_LAYOUT };
  return { schemaVersion: LAYOUT_SCHEMA_VERSION, row1, row2 };
}

export interface LayoutValidation {
  ok: boolean;
  errors: string[];
}

export function validateLayout(l: ItemLayout): LayoutValidation {
  const errors: string[] = [];
  const all = [...l.row1, ...l.row2];
  const dupSet = new Set<string>();
  for (const id of all) {
    if (dupSet.has(id)) errors.push(`Duplicated field: ${FIELD_LABELS[id] ?? id}`);
    dupSet.add(id);
  }
  const missing = FIELD_IDS.filter((id) => !dupSet.has(id));
  if (missing.length) {
    errors.push(`Missing: ${missing.map((id) => FIELD_LABELS[id]).join(", ")}`);
  }
  if (l.row1.length === 0) errors.push("Row 1 needs at least one field");
  if (l.row2.length === 0) errors.push("Row 2 needs at least one field");
  if (l.row1.length > MAX_PER_ROW) errors.push(`Row 1 max ${MAX_PER_ROW} fields`);
  if (l.row2.length > MAX_PER_ROW) errors.push(`Row 2 max ${MAX_PER_ROW} fields`);
  return { ok: errors.length === 0, errors };
}

// -------------------- storage --------------------

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadLayout(): ItemLayout {
  const s = safeStorage();
  if (!s) return { ...DEFAULT_LAYOUT };
  try {
    const raw = s.getItem(layoutStorageKey());
    if (!raw) return { ...DEFAULT_LAYOUT };
    return coerceLayout(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(l: ItemLayout): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(layoutStorageKey(), JSON.stringify({ ...l, schemaVersion: LAYOUT_SCHEMA_VERSION }));
    window.dispatchEvent(new Event(LAYOUT_EVENT));
  } catch {
    /* ignore */
  }
}

export function resetLayout(): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(layoutStorageKey());
    window.dispatchEvent(new Event(LAYOUT_EVENT));
  } catch {
    /* ignore */
  }
}
