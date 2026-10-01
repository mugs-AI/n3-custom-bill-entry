import { getAuthScope } from "./draft-store";

export interface PurchaseReportPrintLayout<TId extends string = string> {
  schemaVersion: 1;
  order: TId[];
  selected: TId[];
}

export const PURCHASE_REPORT_LAYOUT_SCHEMA_VERSION = 1 as const;
export const PURCHASE_REPORT_LAYOUT_EVENT = "custom-bill-entry:purchase-report-layout-change";

/**
 * Intentionally tenant-only, per client request. This keeps the same Print All
 * order/ticks for all N3 logins using this browser for the tenant.
 */
export function purchaseReportLayoutStorageKey(
  scope = getAuthScope(),
): string {
  return `custom-bill-entry:purchase-report-layout:${scope.tenantId}`;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function normalizePurchaseReportPrintLayout<TId extends string>(
  raw: unknown,
  ids: readonly TId[],
): PurchaseReportPrintLayout<TId> {
  const known = new Set<string>(ids);
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const rawOrder = r && Array.isArray(r.order) ? r.order : [];
  const rawSelected = r && Array.isArray(r.selected) ? r.selected : [];

  const order: TId[] = [];
  for (const value of rawOrder) {
    if (typeof value !== "string" || !known.has(value) || order.includes(value as TId)) continue;
    order.push(value as TId);
  }
  for (const id of ids) {
    if (!order.includes(id)) order.push(id);
  }

  // No saved layout means every report starts selected. When a saved layout
  // exists, retain its ticks while automatically selecting newly introduced
  // report ids so upgrades do not silently omit a new report.
  const hasSavedSelection = !!r && Array.isArray(r.selected);
  const selected: TId[] = [];
  if (hasSavedSelection) {
    for (const value of rawSelected) {
      if (typeof value === "string" && known.has(value) && !selected.includes(value as TId)) {
        selected.push(value as TId);
      }
    }
    for (const id of ids) {
      if (!rawOrder.includes(id) && !selected.includes(id)) selected.push(id);
    }
  } else {
    selected.push(...ids);
  }

  return {
    schemaVersion: PURCHASE_REPORT_LAYOUT_SCHEMA_VERSION,
    order,
    selected,
  };
}

export function loadPurchaseReportPrintLayout<TId extends string>(
  ids: readonly TId[],
): PurchaseReportPrintLayout<TId> {
  const s = storage();
  if (!s) return normalizePurchaseReportPrintLayout(null, ids);
  try {
    const raw = s.getItem(purchaseReportLayoutStorageKey());
    return normalizePurchaseReportPrintLayout(raw ? JSON.parse(raw) : null, ids);
  } catch {
    return normalizePurchaseReportPrintLayout(null, ids);
  }
}

export function savePurchaseReportPrintLayout<TId extends string>(
  layout: PurchaseReportPrintLayout<TId>,
  ids: readonly TId[],
): PurchaseReportPrintLayout<TId> {
  const safe = normalizePurchaseReportPrintLayout(layout, ids);
  const s = storage();
  if (s) {
    try {
      s.setItem(purchaseReportLayoutStorageKey(), JSON.stringify(safe));
      window.dispatchEvent(new Event(PURCHASE_REPORT_LAYOUT_EVENT));
    } catch {
      /* local preference failure must not block printing */
    }
  }
  return safe;
}
