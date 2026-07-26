// GL Analysis / Purchase Audit Trail — typed report model.
//
// This module owns the deterministic aggregation used by the GL Analysis
// dashboard (Phase 3A) and by any future Excel/PDF export (Phase 3B). It is
// deliberately isolated from I/O so it can be exercised entirely from tests.
//
// Amount rules (see Phase 3A brief §6):
//   - Read per-line accounting amounts persisted by N3.
//   - beforeTax = PurchaseInvoiceDetailDto.netAmount
//   - taxAmount = PurchaseInvoiceDetailDto.taxAmount
//   - includingTax = beforeTax + taxAmount (matches PurchaseInvoiceDetailDto.subAmount)
//     For Tax-Inclusive invoices N3 stores the same net/tax split, so we
//     never re-derive tax from the gross — we consume what N3 persisted.
//   - Signed values are preserved.
//
// Grouping rules (§7):
//   - Group by glAccountCode (business key).
//   - Lines with no accountId land in an "UNASSIGNED" group so overall
//     totals still reconcile.
//   - Different Name casings for the same Code do NOT split the group; we
//     show the first non-empty name seen.

import { round2, sumTo2dp } from "./money";
import { escapeODataString } from "./history-query";
import {
  extractPurchaseInvoiceDetails,
  PurchaseInvoiceMappingError,
  type PurchaseInvoice,
  type PurchaseInvoiceDetail,
} from "./purchase-invoice";

export const UNASSIGNED_CODE = "UNASSIGNED";
export const UNASSIGNED_NAME = "(No GL Account)";

export interface ReportCriteria {
  /** yyyy-mm-dd inclusive (required). */
  dateFrom: string;
  /** yyyy-mm-dd inclusive (required). */
  dateTo: string;
  /** Header filter: Supplier (immutable N3 ID). */
  supplierId?: number;
  /** Header filter: Purchaser / Payment Type (immutable N3 ID). */
  purchaserId?: number;
  /** Header filter: HQ Sequence — contains match on PurchaseInvoiceListDto.description. */
  hqSequence?: string;
  /** Line-level filter: Cost Centre / Project (immutable N3 ID). */
  projectId?: number;
  /** Line-level filter: WBS / Stock (immutable N3 ID). */
  stockId?: number;
  /** Line-level filter: HQ Tax / Input Tax Code (immutable N3 ID). */
  taxCodeId?: number;
}

export interface GLDrillDownLine {
  invoiceId: string;
  docCode: string;
  docDate: string;
  isCancelled: boolean;
  supplierId: number | null;
  supplierCode: string;
  supplierName: string;
  supplierInvNo: string;
  hqSequence: string;
  /** Immutable N3 Purchaser ID — Payment Type dimension groups on this. */
  purchaserId: number | null;
  purchaserCode: string;
  purchaserName: string;
  /** Legacy display of Term description/code. Never used for grouping. */
  paymentType: string;
  glAccountId: string | null;
  glAccountCode: string;
  glAccountName: string;
  projectId: number | null;
  projectCode: string;
  stockId: number | null;
  stockCode: string;
  itemDescription: string;
  taxCodeId: number | null;
  taxCodeCode: string;
  /** Immutable N3 Tariff Code ID — Order-Number dimension groups on this. */
  tariffCodeId: number | null;
  tariffCode: string;
  tariffDescription: string;
  qty: number;
  unitPrice: number;
  beforeTax: number;
  taxAmount: number;
  includingTax: number;
  referenceNo: string;
  pos: number;
}

export interface GLAccountSummary {
  glAccountId: string | null;
  glAccountCode: string;
  glAccountName: string;
  invoiceCount: number;
  lineCount: number;
  beforeTax: number;
  taxAmount: number;
  includingTax: number;
}

export interface ReportSummary {
  glAccountsCount: number;
  invoiceCount: number;
  lineCount: number;
  beforeTax: number;
  taxAmount: number;
  includingTax: number;
}

export interface ReportData {
  criteria: ReportCriteria;
  summary: ReportSummary;
  groups: GLAccountSummary[];
  lines: GLDrillDownLine[];
  /** Purchase Invoice header count returned by N3 for the header filter. */
  matchedInvoiceCount: number;
  /** Number of invoices whose details were fetched (== matchedInvoiceCount for now). */
  fetchedInvoiceCount: number;
  /** Whether N3's header-level Query capped out at the safety limit. */
  overLimit: boolean;
}

// ---------- Header filter (server-safe OData) ----------

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateCriteria(c: ReportCriteria): string | null {
  if (!ISO_RE.test(c.dateFrom)) return "Document Date From is required (yyyy-mm-dd).";
  if (!ISO_RE.test(c.dateTo)) return "Document Date To is required (yyyy-mm-dd).";
  if (c.dateFrom > c.dateTo) return "Document Date From must be on or before Document Date To.";
  for (const [k, v] of Object.entries({
    supplierId: c.supplierId,
    purchaserId: c.purchaserId,
    projectId: c.projectId,
    stockId: c.stockId,
    taxCodeId: c.taxCodeId,
  })) {
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return `Invalid ${k} — expected a positive integer.`;
    }
  }
  return null;
}

/**
 * Build the OData $filter applied at the PurchaseInvoices/Query call. Only
 * documented top-level PurchaseInvoiceListDto fields are referenced, and only
 * with immutable N3 IDs (no projected properties, no free-text global OR).
 */
export function buildReportHeaderFilter(c: ReportCriteria): string {
  const parts: string[] = [];
  parts.push(`docDate ge ${c.dateFrom}T00:00:00Z`);
  parts.push(`docDate le ${c.dateTo}T23:59:59Z`);
  // §5: exclude cancelled from every query, aggregation and drill-down.
  parts.push("isCancelled eq false");
  if (typeof c.supplierId === "number" && c.supplierId > 0) {
    parts.push(`supplierId eq ${c.supplierId}`);
  }
  if (typeof c.purchaserId === "number" && c.purchaserId > 0) {
    parts.push(`purchaserId eq ${c.purchaserId}`);
  }
  const hq = (c.hqSequence ?? "").trim();
  if (hq) {
    parts.push(`contains(tolower(description),tolower('${escapeODataString(hq)}'))`);
  }
  return parts.join(" and ");
}

// ---------- Aggregation (pure) ----------

export function filterLines(lines: GLDrillDownLine[], c: ReportCriteria): GLDrillDownLine[] {
  return lines.filter((l) => {
    if (l.isCancelled) return false;
    if (c.projectId != null && l.projectId !== c.projectId) return false;
    if (c.stockId != null && l.stockId !== c.stockId) return false;
    if (c.taxCodeId != null && l.taxCodeId !== c.taxCodeId) return false;
    return true;
  });
}

export function aggregateByGL(lines: GLDrillDownLine[]): GLAccountSummary[] {
  const groups = new Map<
    string,
    {
      glAccountId: string | null;
      glAccountCode: string;
      glAccountName: string;
      invoiceIds: Set<string>;
      lineCount: number;
      beforeTax: number[];
      taxAmount: number[];
      includingTax: number[];
    }
  >();
  for (const l of lines) {
    const key = l.glAccountCode || UNASSIGNED_CODE;
    let g = groups.get(key);
    if (!g) {
      g = {
        glAccountId: l.glAccountId,
        glAccountCode: key,
        glAccountName: l.glAccountName || (key === UNASSIGNED_CODE ? UNASSIGNED_NAME : ""),
        invoiceIds: new Set<string>(),
        lineCount: 0,
        beforeTax: [],
        taxAmount: [],
        includingTax: [],
      };
      groups.set(key, g);
    } else if (!g.glAccountName && l.glAccountName) {
      g.glAccountName = l.glAccountName;
    }
    g.invoiceIds.add(l.invoiceId);
    g.lineCount += 1;
    g.beforeTax.push(l.beforeTax);
    g.taxAmount.push(l.taxAmount);
    g.includingTax.push(l.includingTax);
  }
  const out: GLAccountSummary[] = [];
  for (const g of groups.values()) {
    out.push({
      glAccountId: g.glAccountId,
      glAccountCode: g.glAccountCode,
      glAccountName: g.glAccountName,
      invoiceCount: g.invoiceIds.size,
      lineCount: g.lineCount,
      beforeTax: sumTo2dp(g.beforeTax.map(round2)),
      taxAmount: sumTo2dp(g.taxAmount.map(round2)),
      includingTax: sumTo2dp(g.includingTax.map(round2)),
    });
  }
  out.sort((a, b) => b.includingTax - a.includingTax);
  return out;
}

export function buildSummary(
  lines: GLDrillDownLine[],
  groups: GLAccountSummary[],
): ReportSummary {
  const invoiceIds = new Set(lines.map((l) => l.invoiceId));
  return {
    glAccountsCount: groups.length,
    invoiceCount: invoiceIds.size,
    lineCount: lines.length,
    beforeTax: sumTo2dp(groups.map((g) => g.beforeTax)),
    taxAmount: sumTo2dp(groups.map((g) => g.taxAmount)),
    includingTax: sumTo2dp(groups.map((g) => g.includingTax)),
  };
}

// ---------- N3 -> GLDrillDownLine mapping ----------

// Back-compat aliases for existing consumers/tests.
export type RawN3Line = PurchaseInvoiceDetail;
export type RawN3Header = PurchaseInvoice;

/**
 * Map an N3 PurchaseInvoiceDto (with detail lines) to zero or more
 * GLDrillDownLine rows. Cancelled invoices produce no rows. If the
 * response is missing BOTH itemDetails and details arrays this throws a
 * sanitized `PurchaseInvoiceMappingError` — never silently returns []
 * (Task 2 + Task 4). An explicit empty array is handled separately and
 * returns [].
 */
export function mapInvoiceToLines(inv: PurchaseInvoice): GLDrillDownLine[] {
  if (inv.isCancelled) return [];
  const details = extractPurchaseInvoiceDetails(inv); // throws on missing schema
  const invoiceId = typeof inv.id === "string" ? inv.id : "";
  if (!invoiceId) {
    throw new PurchaseInvoiceMappingError(
      `Purchase Invoice ${inv.docCode ?? "(unknown)"} response has no id.`,
      inv.docCode ?? "(unknown)",
    );
  }
  const docDate = typeof inv.docDate === "string" ? inv.docDate.slice(0, 10) : "";
  const supplierCode = inv.supplier?.code ?? "";
  const supplierName = inv.supplier?.name ?? "";
  const purchaserCode = inv.purchaser?.code ?? "";
  const purchaserName = inv.purchaser?.name ?? "";
  const paymentType = inv.term?.description ?? inv.term?.code ?? "";
  const out: GLDrillDownLine[] = [];
  details.forEach((d, i) => {
    // Observed N3 PurchaseInvoiceDetailDto semantics (Phase 3B Prerequisite
    // Correction A): beforeTax <- subAmount, taxAmount <- taxAmount,
    // includingTax <- netAmount. Use nullish checks so a genuine 0 is kept.
    const sub =
      typeof d.subAmount === "number" && Number.isFinite(d.subAmount) ? d.subAmount : null;
    const net =
      typeof d.netAmount === "number" && Number.isFinite(d.netAmount) ? d.netAmount : null;
    const tax =
      typeof d.taxAmount === "number" && Number.isFinite(d.taxAmount) ? d.taxAmount : 0;
    const taxAmount = round2(tax);
    const beforeTax = round2(sub != null ? sub : net != null ? net - tax : 0);
    const including = round2(net != null ? net : sub != null ? sub + tax : 0);
    const glCode = d.account?.code ?? "";
    const glName = d.account?.name ?? d.accountName ?? "";
    out.push({
      invoiceId,
      docCode: inv.docCode ?? "",
      docDate,
      isCancelled: !!inv.isCancelled,
      supplierId: inv.supplierId ?? null,
      supplierCode,
      supplierName,
      supplierInvNo: inv.supplierInvNo ?? "",
      hqSequence: inv.description ?? "",
      purchaserId: inv.purchaserId ?? null,
      purchaserCode,
      purchaserName,
      paymentType,
      glAccountId: d.accountId ?? null,
      glAccountCode: glCode || (d.accountId ? "" : UNASSIGNED_CODE),
      glAccountName: glName || (d.accountId ? "" : UNASSIGNED_NAME),
      projectId: d.projectId ?? null,
      projectCode: d.project?.code ?? "",
      stockId: d.stockId ?? null,
      stockCode: d.stock?.code ?? "",
      itemDescription: d.description ?? d.stock?.name ?? "",
      taxCodeId: d.taxCodeId ?? null,
      taxCodeCode: d.taxCode?.code ?? "",
      tariffCodeId: d.tariffCodeId ?? null,
      tariffCode: d.tariffCode?.code ?? "",
      tariffDescription: d.tariffCode?.description ?? "",
      qty: typeof d.qty === "number" ? d.qty : 0,
      unitPrice: typeof d.unitPrice === "number" ? d.unitPrice : 0,
      beforeTax,
      taxAmount,
      includingTax: including,
      referenceNo: d.referenceNo ?? "",
      pos: typeof d.pos === "number" ? d.pos : i + 1,
    });
  });
  return out;
}

export { PurchaseInvoiceMappingError };

// ---------- Bounded concurrency helper (pure) ----------

/**
 * Run an async worker over `items` with at most `limit` in flight. Returns a
 * promise resolving to the ordered results. Never launches an unbounded
 * Promise.all. Any worker rejection rejects the whole run.
 */
export async function mapBounded<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const cap = Math.max(1, Math.min(limit | 0, 3));
  const out = new Array<R>(items.length);
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const run = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  };
  for (let i = 0; i < Math.min(cap, items.length); i++) runners.push(run());
  await Promise.all(runners);
  return out;
}
