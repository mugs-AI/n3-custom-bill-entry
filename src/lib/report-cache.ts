// Shared React Query cache key + sessionStorage snapshot for GL Analysis
// report data.
//
// Correction A Task 2 root cause: after `queryClient.setQueryData` primes the
// key, no component observes it, so once React Query's default `gcTime`
// (5 min) elapses the entry is collected and later report views wrongly show
// "No GL Analysis inquiry is currently loaded".
//
// Fix: (1) keep an "observer" `useQuery` on both pages with
// `staleTime: Infinity` + `gcTime: Infinity`, and (2) additionally persist the
// completed immutable snapshot into sessionStorage under a tenant/user-scoped
// key so a real page refresh restores it. The token is never persisted.

import type { QueryClient } from "@tanstack/react-query";
import type { ReportCriteria, ReportData } from "./report-model";
import { getAuthScope } from "./draft-store";

export const REPORT_SNAPSHOT_SCHEMA = 1;

function normFilter(filter: ReportCriteria) {
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

/** Stable, tenant/user-scoped React Query key. */
export function reportCacheKey(filter: ReportCriteria): unknown[] {
  const scope = getAuthScope();
  return ["report", "gl-analysis", scope.tenantId, scope.userId, normFilter(filter)];
}

/** Best-effort read of the last successful GL Analysis report. */
export function readReportFromCache(
  queryClient: QueryClient,
  filter: ReportCriteria,
): ReportData | undefined {
  return queryClient.getQueryData<ReportData>(reportCacheKey(filter));
}

// ---------- sessionStorage snapshot ----------

interface Snapshot {
  schemaVersion: number;
  savedAt: number;
  tenantId: string;
  userId: string;
  filterHash: string;
  filter: ReportCriteria;
  report: ReportData;
}

function snapshotKey(scope: { tenantId: string; userId: string }): string {
  return `custom-bill-entry:gl-analysis:${scope.tenantId}:${scope.userId}`;
}

function hashFilter(filter: ReportCriteria): string {
  return JSON.stringify(normFilter(filter));
}

function safeSession(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveReportSnapshot(filter: ReportCriteria, report: ReportData): void {
  const s = safeSession();
  if (!s) return;
  try {
    const scope = getAuthScope();
    const snap: Snapshot = {
      schemaVersion: REPORT_SNAPSHOT_SCHEMA,
      savedAt: Date.now(),
      tenantId: scope.tenantId,
      userId: scope.userId,
      filterHash: hashFilter(filter),
      filter,
      report,
    };
    s.setItem(snapshotKey(scope), JSON.stringify(snap));
  } catch {
    /* ignore quota */
  }
}

/** Return the latest snapshot for this signed-in tenant/user, or null. */
export function loadReportSnapshot(): {
  filter: ReportCriteria;
  report: ReportData;
} | null {
  const s = safeSession();
  if (!s) return null;
  try {
    const scope = getAuthScope();
    const raw = s.getItem(snapshotKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Snapshot;
    if (!parsed || parsed.schemaVersion !== REPORT_SNAPSHOT_SCHEMA) return null;
    // Reject snapshots minted under a different tenant/user.
    if (parsed.tenantId !== scope.tenantId || parsed.userId !== scope.userId) return null;
    if (!parsed.filter || !parsed.report) return null;
    return { filter: parsed.filter, report: parsed.report };
  } catch {
    return null;
  }
}

/** Best-effort clear (Sign Out, tenant/user change, explicit Clear). */
export function clearReportSnapshot(): void {
  const s = safeSession();
  if (!s) return;
  try {
    const scope = getAuthScope();
    s.removeItem(snapshotKey(scope));
  } catch {
    /* ignore */
  }
}

/** Remove every gl-analysis snapshot on the tab. Used on Sign Out. */
export function clearAllReportSnapshots(): void {
  const s = safeSession();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith("custom-bill-entry:gl-analysis:")) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    /* ignore */
  }
}
