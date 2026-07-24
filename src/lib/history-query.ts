// Shared query key + OData filter builders for the Purchase Invoice History
// screen. Kept in a small module so New Bill Entry and Edit PI can invalidate
// the history cache after a save without importing UI code.
//
// Correction C repair (2026-07): the previous global "OR contains" filter
// used projected properties like `SupplierCode`/`billFrom` that the N3
// EF-backed Query endpoint could not translate — it returned 500 and the
// history page silently died. The new API is *structured*: callers pass a
// typed `HistoryFilter` and we emit a filter built only from
// PurchaseInvoiceListDto fields that we've validated to be OData-safe.

export const HISTORY_QUERY_KEY = ["n3", "purchaseInvoices"] as const;

/** Escape a value for safe inclusion inside an OData v4 string literal. */
export function escapeODataString(v: string): string {
  return v.replace(/'/g, "''");
}

export interface HistoryFilter {
  /** yyyy-mm-dd inclusive lower bound on docDate. */
  dateFrom?: string;
  /** yyyy-mm-dd inclusive upper bound on docDate. */
  dateTo?: string;
  /** Substring match on docCode. */
  docCode?: string;
  /** Substring match on supplierInvNo. */
  supplierInvNo?: string;
  /** Substring match on description (HQ Sequence). */
  description?: string;
  /** Substring match on referenceNo. */
  referenceNo?: string;
  /** Exact supplier id (resolved from Supplier lookup). */
  supplierId?: number;
  /** Exact purchaser id (resolved from Purchaser lookup). */
  purchaserId?: number;
  /** "active" hides cancelled rows, "cancelled" hides active, "all" no filter. */
  status?: "active" | "cancelled" | "all";
  /** Inclusive Net Total minimum. */
  netMin?: number;
  /** Inclusive Net Total maximum. */
  netMax?: number;
}

function pushContains(out: string[], field: string, value?: string) {
  if (!value) return;
  const v = value.trim();
  if (!v) return;
  const safe = `'${escapeODataString(v)}'`;
  // OData v4: no property projection inside the string — call on the
  // top-level DTO field directly. tolower() is universally supported.
  out.push(`contains(tolower(${field}),tolower(${safe}))`);
}

/**
 * Build a strict OData $filter from a structured HistoryFilter. Returns null
 * when the filter is empty. Only well-known top-level PurchaseInvoiceListDto
 * fields are ever referenced.
 */
export function buildHistoryFilter(f: HistoryFilter): string | null {
  const parts: string[] = [];
  if (f.dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(f.dateFrom)) {
    parts.push(`docDate ge ${f.dateFrom}T00:00:00Z`);
  }
  if (f.dateTo && /^\d{4}-\d{2}-\d{2}$/.test(f.dateTo)) {
    parts.push(`docDate le ${f.dateTo}T23:59:59Z`);
  }
  pushContains(parts, "docCode", f.docCode);
  pushContains(parts, "supplierInvNo", f.supplierInvNo);
  pushContains(parts, "description", f.description);
  pushContains(parts, "referenceNo", f.referenceNo);
  if (typeof f.supplierId === "number" && Number.isFinite(f.supplierId) && f.supplierId > 0) {
    parts.push(`supplierId eq ${f.supplierId}`);
  }
  if (typeof f.purchaserId === "number" && Number.isFinite(f.purchaserId) && f.purchaserId > 0) {
    parts.push(`purchaserId eq ${f.purchaserId}`);
  }
  if (f.status === "active") parts.push("isCancelled eq false");
  else if (f.status === "cancelled") parts.push("isCancelled eq true");
  if (typeof f.netMin === "number" && Number.isFinite(f.netMin)) {
    parts.push(`netTotalAmount ge ${f.netMin}`);
  }
  if (typeof f.netMax === "number" && Number.isFinite(f.netMax)) {
    parts.push(`netTotalAmount le ${f.netMax}`);
  }
  return parts.length ? parts.join(" and ") : null;
}

/** Return true iff the caller supplied any narrowing criterion. */
export function isEmptyFilter(f: HistoryFilter): boolean {
  return buildHistoryFilter(f) === null;
}
