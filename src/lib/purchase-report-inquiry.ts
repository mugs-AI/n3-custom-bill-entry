// Phase 3B Correction F — shared helpers for the Purchase Report shell.
//
// Extracted from src/routes/reports_.purchase.$view.tsx so the "Print All 8
// Reports" route can reuse the same inquiry-restoration and audit-fetch
// contract without a fetch fork.

import { getAuthScope } from "@/lib/draft-store";
import { getToken } from "@/lib/auth-store";
import type {
  AuditPIDocument,
  GLRow,
} from "@/lib/audit-trail";
import type { ReportCriteria } from "@/lib/report-model";

export function loadInquiry(): { filter: ReportCriteria; ran: boolean } | null {
  if (typeof window === "undefined") return null;
  try {
    const scope = getAuthScope();
    const raw = window.sessionStorage.getItem(
      `custom-bill-entry:gl-analysis-inquiry:${scope.tenantId}:${scope.userId}`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { filter?: ReportCriteria; ran?: boolean };
    if (!parsed?.filter?.dateFrom || !parsed.filter.dateTo) return null;
    return { filter: parsed.filter, ran: !!parsed.ran };
  } catch {
    return null;
  }
}

export interface AuditFetchReply {
  ok: boolean;
  kind?: string;
  error?: string;
  gl?: GLRow[];
  meta?: {
    strategy?: "purchase-invoice-glposting" | "general-ledger-fallback";
    targetInvoiceCount?: number;
    upstreamRequestCount?: number;
    rowsMatched?: number;
    elapsedMs?: number;
    fallbackReason?: string;
    piDocumentCount: number;
    accountsFetched?: number;
    accountsFromApi?: number;
    accountsFromSuppliers?: number;
    accountsWithHits?: number;
    accountsWithNoRows?: string[];
    glRowsFetched?: number;
    glRowsMatched?: number;
    piDocSample: string[];
    unresolvedCount?: number;
    unresolvedRows?: Array<{
      accountCode: string;
      docDate: string;
      supplierInvNo: string;
      debit: number;
      credit: number;
      reason: "no-match" | "ambiguous";
    }>;
  };
}

export async function fetchAudit(
  filter: ReportCriteria,
  piDocuments: AuditPIDocument[],
): Promise<AuditFetchReply> {
  const token = getToken();
  if (!token) throw new Error("Not signed in to N3.");
  const res = await fetch("/api/reports/purchase-audit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      dateFrom: filter.dateFrom,
      dateTo: filter.dateTo,
      piDocuments,
    }),
  });
  const text = await res.text();
  let body: AuditFetchReply | null = null;
  try {
    body = text ? (JSON.parse(text) as AuditFetchReply) : null;
  } catch {
    body = null;
  }
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error || `Purchase Audit failed (${res.status})`);
  }
  return body;
}

/** Deterministic normalized filter for React Query keys. */
export function normalizeAuditFilter(filter: ReportCriteria) {
  return {
    dateFrom: filter.dateFrom,
    dateTo: filter.dateTo,
    supplierId: filter.supplierId ?? null,
    purchaserId: filter.purchaserId ?? null,
    projectId: filter.projectId ?? null,
    stockId: filter.stockId ?? null,
    taxCodeId: filter.taxCodeId ?? null,
    hqSequence: (filter.hqSequence ?? "").trim() || null,
  };
}

/**
 * Pure selection helper used by /reports/purchase/print-all. Returns the
 * plan derived from the checked view ids: which sections will render and
 * whether the (single) audit request is required at all.
 */
export function selectionPlan<TId extends string>(
  selected: readonly TId[],
  accountingIds: readonly TId[],
): {
  selected: TId[];
  count: number;
  hasAccounting: boolean;
  isValid: boolean;
} {
  const set = new Set(selected);
  const kept = selected.filter((id) => set.has(id));
  const hasAccounting = accountingIds.some((id) => set.has(id));
  return {
    selected: kept,
    count: kept.length,
    hasAccounting,
    isValid: kept.length > 0,
  };
}
