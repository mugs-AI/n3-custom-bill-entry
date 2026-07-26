// Shared React Query cache key for GL Analysis report data.
//
// The GL Analysis screen (reports.tsx) writes the successful ReportData into
// this key so Phase 3B report views can read it without a second inquiry.

import type { QueryClient } from "@tanstack/react-query";
import type { ReportCriteria, ReportData } from "./report-model";
import { getAuthScope } from "./draft-store";

/**
 * Stable, tenant/user-scoped query key. The criteria object is normalized so
 * different member orders produce the same key.
 */
export function reportCacheKey(filter: ReportCriteria): unknown[] {
  const scope = getAuthScope();
  const norm = {
    dateFrom: filter.dateFrom,
    dateTo: filter.dateTo,
    supplierId: filter.supplierId ?? null,
    purchaserId: filter.purchaserId ?? null,
    projectId: filter.projectId ?? null,
    stockId: filter.stockId ?? null,
    taxCodeId: filter.taxCodeId ?? null,
    hqSequence: (filter.hqSequence ?? "").trim() || null,
  };
  return ["report", "gl-analysis", scope.tenantId, scope.userId, norm];
}

/** Best-effort read of the last successful GL Analysis report. */
export function readReportFromCache(
  queryClient: QueryClient,
  filter: ReportCriteria,
): ReportData | undefined {
  return queryClient.getQueryData<ReportData>(reportCacheKey(filter));
}
