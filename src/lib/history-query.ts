// Shared query-key + helpers for the Purchase Invoice History screen.
//
// Keeping the key in a small module lets New Bill Entry invalidate the
// history cache after a successful save without importing UI code.

export const HISTORY_QUERY_KEY = ["n3", "purchaseInvoices"] as const;

/** Escape a value for safe inclusion inside an OData v4 string literal. */
export function escapeODataString(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * Build a documented OData $filter for the Purchase Invoice Query endpoint.
 * The API is OData v4, so string matching uses `contains(field, 'value')`.
 * Fields are limited to a small documented allow-list to avoid over-broad
 * scans.
 */
export function buildInvoiceFilter(search: string): string | null {
  const q = search.trim();
  if (!q) return null;
  const safe = `'${escapeODataString(q)}'`;
  const fields = [
    "docCode",
    "supplierInvNo",
    "description",
    "referenceNo",
    "supplierCode",
    "billFrom",
  ];
  return fields.map((f) => `contains(tolower(${f}),tolower(${safe}))`).join(" or ");
}
