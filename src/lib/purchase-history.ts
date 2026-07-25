// Purchase History (Reporting API) reconciliation helper.
//
// The reporting endpoint `POST /api/reporting/PurchaseHistory/Inquiry` is
// used ONLY for targeted read-only reconciliation of GL Analysis totals
// (Phase 3A Correction A, Task 1). It intentionally does not drive the
// dashboard because it lacks GL Account, GL Account Name and HQ Sequence.
//
// This module is pure so tests can feed live-shaped fixtures without I/O.

import { round2, sumTo2dp } from "./money";

export interface PurchaseHistoryRow {
  documentId?: string;
  docCode?: string;
  docDate?: string;
  docType?: string;
  pos?: number;
  isCancelled?: boolean;
  supplierCode?: string;
  supplierName?: string;
  purchaserCode?: string;
  purchaserName?: string;
  taxExclusiveAmountLocal?: number;
  taxAmountLocal?: number;
  amountLocal?: number;
}

/**
 * Standard reporting envelope for array responses:
 * `{ success, code, message, data: [] }`.
 */
export interface PurchaseHistoryArrayApiResponse {
  success?: boolean;
  code?: string;
  message?: string;
  data?: PurchaseHistoryRow[] | null;
}

export function unwrapPurchaseHistory(
  resp: PurchaseHistoryArrayApiResponse | undefined | null,
): PurchaseHistoryRow[] {
  if (!resp || typeof resp !== "object") return [];
  const ok = resp.success === true || resp.code === "0000";
  if (!ok) return [];
  return Array.isArray(resp.data) ? resp.data : [];
}

export interface PurchaseHistoryInquiryRequest {
  filter: {
    dateFrom: string;
    dateTo: string;
    docType: string[];
    includeCancelled: boolean;
  };
  options: null;
}

export function buildPurchaseHistoryRequest(
  dateFrom: string,
  dateTo: string,
): PurchaseHistoryInquiryRequest {
  return {
    filter: {
      dateFrom: `${dateFrom}T00:00:00`,
      dateTo: `${dateTo}T23:59:59`,
      docType: ["PINV"],
      includeCancelled: false,
    },
    options: null,
  };
}

export interface InvoiceReconciliation {
  docCode: string;
  lineCount: number;
  beforeTax: number;
  taxAmount: number;
  includingTax: number;
}

/**
 * Reconcile per-line totals for a single Purchase Invoice against the
 * PurchaseHistory rows returned for the same period. Line identity is
 * `documentId + pos`. Cancelled rows are skipped.
 */
export function reconcileInvoiceTotals(
  rows: PurchaseHistoryRow[],
  docCode: string,
): InvoiceReconciliation {
  const seen = new Set<string>();
  let beforeTax: number[] = [];
  let taxAmount: number[] = [];
  let including: number[] = [];
  for (const r of rows) {
    if (r.docCode !== docCode) continue;
    if (r.isCancelled) continue;
    const key = `${r.documentId ?? ""}|${r.pos ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    beforeTax.push(round2(r.taxExclusiveAmountLocal ?? 0));
    taxAmount.push(round2(r.taxAmountLocal ?? 0));
    including.push(round2(r.amountLocal ?? 0));
  }
  return {
    docCode,
    lineCount: seen.size,
    beforeTax: sumTo2dp(beforeTax),
    taxAmount: sumTo2dp(taxAmount),
    includingTax: sumTo2dp(including),
  };
}
