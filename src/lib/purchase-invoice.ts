// Shared Purchase Invoice extractor (Phase 3A Correction A, Task 2).
//
// The N3 main `purchase-v1` swagger defines TWO detail arrays on
// PurchaseInvoiceDto:
//
//   - `itemDetails: PurchaseInvoiceDetailDto[]` — canonical, keyboard-entered
//     item lines with GL Account, WBS/Stock, tax code, project, qty, unit
//     price, netAmount, taxAmount, subAmount. This is the array the edit
//     screen and Create/Update payloads round-trip.
//   - `details: BillDetailDto[]` — the "bill" (expense-only) detail projection.
//     Has account/description/amounts but no stock/uom.
//
// The Phase 3A first cut aggregated `inv.details ?? inv.itemDetails` — that
// order is wrong. Live invoices posted through New Bill Entry populate
// `itemDetails`, so preferring `details` (an empty array) silently produced
// "17 headers, 0 lines". Task 1 of the correction confirms this against
// invoice M1B2607002Ikeyinn3.
//
// This module is I/O-free so both the report route and the edit-invoice
// mapper can consume it, and so it can be exercised entirely from tests.

/** Minimal detail shape common to both DTOs, used by every consumer. */
export interface PurchaseInvoiceDetail {
  id?: string | null;
  pos?: number;
  stockId?: number | null;
  stock?: { id?: number; code?: string; name?: string; description?: string } | null;
  uomId?: number | null;
  uom?: { id?: number; code?: string } | null;
  accountId?: string | null;
  account?: { id?: string; code?: string; name?: string } | null;
  accountName?: string;
  projectId?: number | null;
  project?: { id?: number; code?: string; name?: string } | null;
  taxCodeId?: number | null;
  taxCode?: { id?: number; code?: string; fullName?: string; name?: string; description?: string } | null;
  tariffCodeId?: number | null;
  tariffCode?: { id?: number; code?: string; description?: string } | null;
  description?: string;
  qty?: number;
  unitPrice?: number;
  netAmount?: number;
  taxAmount?: number;
  subAmount?: number;
  referenceNo?: string;
}

/**
 * PurchaseInvoiceDto — only the fields consumed anywhere in this project.
 * Kept intentionally partial because the live DTO carries 120+ fields.
 */
export interface PurchaseInvoice {
  id?: string;
  docCode?: string;
  docDate?: string;
  isCancelled?: boolean;
  description?: string;
  referenceNo?: string;
  supplierInvNo?: string;
  isTaxInclusive?: boolean;
  supplierId?: number | null;
  supplier?: { id?: number; code?: string; name?: string } | null;
  purchaserId?: number | null;
  purchaser?: { id?: number; code?: string; name?: string } | null;
  termId?: number | null;
  term?: { id?: number; code?: string; description?: string } | null;
  /** Canonical PurchaseInvoiceDetailDto array. Preferred when present. */
  itemDetails?: PurchaseInvoiceDetail[] | null;
  /** BillDetailDto array. Fallback only. */
  details?: PurchaseInvoiceDetail[] | null;
}

export class PurchaseInvoiceMappingError extends Error {
  docCode: string;
  constructor(message: string, docCode: string) {
    super(message);
    this.name = "PurchaseInvoiceMappingError";
    this.docCode = docCode;
  }
}

/**
 * Normalise a live Open API response into a `PurchaseInvoice`. `n3Call`
 * already unwraps the QNE `{ success, code, data }` envelope, so this
 * mostly asserts the shape and returns it. If the envelope was passed
 * through raw (older call sites), unwrap `data` here as a safety net.
 */
export function unwrapPurchaseInvoice(resp: unknown): PurchaseInvoice {
  if (!resp || typeof resp !== "object") {
    throw new PurchaseInvoiceMappingError(
      "Purchase Invoice response was not an object.",
      "(unknown)",
    );
  }
  const asEnv = resp as { data?: unknown; success?: unknown; code?: unknown };
  const body =
    asEnv && ("data" in asEnv || "success" in asEnv) && asEnv.data && typeof asEnv.data === "object"
      ? (asEnv.data as PurchaseInvoice)
      : (resp as PurchaseInvoice);
  if (!body || typeof body !== "object") {
    throw new PurchaseInvoiceMappingError(
      "Purchase Invoice response envelope had no data object.",
      "(unknown)",
    );
  }
  return body;
}

/**
 * Return the canonical PurchaseInvoiceDetailDto[] for an invoice.
 *
 * Precedence: `itemDetails` (PurchaseInvoiceDetailDto) > `details`
 * (BillDetailDto). Rules per Task 2 + Task 4:
 *
 *   - Explicit empty array is a legitimate "no lines" answer.
 *   - Missing property on BOTH sides is a schema failure → throw a sanitized
 *     mapping error carrying only the safe document number.
 *   - Never silently return [] for an unrecognised response.
 */
export function extractPurchaseInvoiceDetails(
  inv: PurchaseInvoice,
): PurchaseInvoiceDetail[] {
  const hasItem = Array.isArray(inv.itemDetails);
  const hasDet = Array.isArray(inv.details);
  if (!hasItem && !hasDet) {
    const doc = typeof inv.docCode === "string" && inv.docCode ? inv.docCode : "(unknown)";
    throw new PurchaseInvoiceMappingError(
      `Purchase Invoice ${doc} response is missing both itemDetails and details arrays.`,
      doc,
    );
  }
  // Prefer itemDetails when it is present. If itemDetails is an empty array
  // but details has rows, N3 has posted the invoice as a Bill (expense-only):
  // fall through to details so the report is not blank.
  if (hasItem && inv.itemDetails!.length > 0) return inv.itemDetails!;
  if (hasDet && inv.details!.length > 0) return inv.details!;
  // Both present but empty → genuinely empty invoice.
  return hasItem ? inv.itemDetails! : (inv.details as PurchaseInvoiceDetail[]);
}
