// Phase 3B Correction F Task 5 — "Print All 8 Reports" preview & print
// interface.
//
// Two-step flow:
//   1. Selection step (default on entry): all 8 reports pre-checked. The
//      user can uncheck any and click "Prepare Print Preview".
//   2. Preview step: renders every selected report, in the canonical order,
//      as continuous flow content — no forced page break per report. The
//      browser Print dialog fills each A4 sheet before starting a new one.
//
// Data flow:
//   - Reuses the same GL Analysis snapshot rehydration path as the single-
//     report shell (loadReportSnapshot → queryClient.setQueryData).
//   - Reuses the same Purchase Audit query key contract (fingerprint +
//     normalized filter + auth scope) so a warm cache from an accounting
//     view is served instantly and, when cold, at most ONE request is made
//     for the entire preview.
//   - When no accounting view is selected, the audit query is disabled and
//     no /api/reports/purchase-audit request is made at all.

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { useAuthToken, useHydrated } from "@/hooks/use-auth";
import { getAuthScope } from "@/lib/draft-store";
import { computeAuditFingerprint } from "@/lib/audit-fingerprint";
import { canonicalDocCode } from "@/lib/report-keys";
import {
  reconcileAudit,
  type AuditPIDocument,
  type PurchaseAuditResult,
} from "@/lib/audit-trail";
import { loadReportSnapshot, reportCacheKey } from "@/lib/report-cache";
import type { ReportData } from "@/lib/report-model";
import {
  fetchAudit,
  loadInquiry,
  normalizeAuditFilter,
  selectionPlan,
  type AuditFetchReply,
} from "@/lib/purchase-report-inquiry";
import {
  AuditTrailView,
  CompactReportHeader,
  DimensionView,
  isAccountingView,
  PostingAccountView,
  VIEW_IDS,
  VIEW_META,
  type ViewId,
} from "./reports_.purchase.$view";

export const Route = createFileRoute("/reports_/purchase/print-all")({
  head: () => ({
    meta: [
      { title: "Print All 8 Purchase Reports · Custom Bill Entry" },
      {
        name: "description",
        content:
          "Print all 8 Purchase Reports for the current GL Analysis inquiry as one continuous document.",
      },
      { property: "og:title", content: "Print All 8 Purchase Reports · Custom Bill Entry" },
      {
        property: "og:description",
        content:
          "Print all 8 Purchase Reports for the current GL Analysis inquiry as one continuous document.",
      },
    ],
  }),
  component: PrintAllPage,
});

const ACCOUNTING_IDS: ViewId[] = ["audit-trail", "posting-account"];

function PrintAllPage() {
  const hydrated = useHydrated();
  const token = useAuthToken();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<ViewId>>(() => new Set(VIEW_IDS));
  const [step, setStep] = useState<"select" | "preview">("select");

  const inquiry = useMemo(() => (hydrated ? loadInquiry() : null), [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const snap = loadReportSnapshot();
    if (snap) {
      queryClient.setQueryData(reportCacheKey(snap.filter), snap.report);
    }
  }, [hydrated, queryClient]);

  const cachedQ = useQuery<ReportData | null>({
    queryKey: inquiry ? reportCacheKey(inquiry.filter) : ["report", "gl-analysis", "none"],
    queryFn: () => Promise.resolve(null as unknown as ReportData),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const cached = cachedQ.data ?? null;

  const piDocuments = useMemo<AuditPIDocument[]>(() => {
    if (!cached) return [];
    const seen = new Map<string, AuditPIDocument>();
    for (const l of cached.lines) {
      if (!l.docCode) continue;
      const key = canonicalDocCode(l.docCode);
      if (!key || seen.has(key)) continue;
      seen.set(key, {
        invoiceId: l.invoiceId,
        docCode: l.docCode,
        docDate: l.docDate,
        supplierCode: l.supplierCode,
        supplierName: l.supplierName,
        supplierInvNo: l.supplierInvNo,
        termDescription: l.paymentType,
      });
    }
    return [...seen.values()];
  }, [cached]);

  const docCodeToInvoiceId = useMemo(() => {
    const m = new Map<string, string>();
    if (!cached) return m;
    for (const l of cached.lines) {
      if (!l.invoiceId) continue;
      const key = canonicalDocCode(l.docCode);
      if (key && !m.has(key)) m.set(key, l.invoiceId);
    }
    return m;
  }, [cached]);

  const plan = useMemo(
    () => selectionPlan(Array.from(selected), ACCOUNTING_IDS),
    [selected],
  );

  // Same key contract as the single-report shell — cache is shared.
  const auditFingerprint = useMemo(() => computeAuditFingerprint(cached), [cached]);
  const authScope = useMemo(
    () => (hydrated ? getAuthScope() : { tenantId: "", userId: "" }),
    [hydrated],
  );
  const normalizedFilter = useMemo(
    () => (inquiry ? normalizeAuditFilter(inquiry.filter) : null),
    [inquiry],
  );

  const auditEnabled =
    step === "preview" &&
    hydrated &&
    !!token &&
    !!cached &&
    plan.hasAccounting &&
    piDocuments.length > 0;

  const auditQ = useQuery<AuditFetchReply, Error>({
    queryKey: [
      "purchase-audit",
      authScope.tenantId,
      authScope.userId,
      normalizedFilter,
      auditFingerprint,
    ],
    enabled: auditEnabled,
    queryFn: () => fetchAudit(inquiry!.filter, piDocuments),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: false,
  });

  const auditResult: PurchaseAuditResult | null = useMemo(() => {
    const data = auditQ.data;
    if (!data?.ok || !data.gl) return null;
    return reconcileAudit(piDocuments, data.gl);
  }, [auditQ.data, piDocuments]);

  function toggle(id: ViewId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function checkAll() {
    setSelected(new Set(VIEW_IDS));
  }
  function clearAll() {
    setSelected(new Set());
  }

  if (!hydrated || !token) {
    return (
      <AppShell>
        <div className="app-card p-6 text-sm text-muted-foreground">
          Sign in to N3 to print Purchase Reports.
        </div>
      </AppShell>
    );
  }
  if (!inquiry || !inquiry.ran || !cached) {
    return (
      <AppShell>
        <div className="app-card p-6 text-sm">
          <p className="text-muted-foreground">
            No GL Analysis inquiry is currently loaded. Run an inquiry first, then return here.
          </p>
          <div className="mt-3">
            <Link to="/reports" className="app-btn app-btn-primary">
              Go to GL Analysis
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  if (step === "select") {
    return (
      <AppShell>
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Print All 8 Reports</h1>
              <p className="text-sm text-muted-foreground">
                Choose which reports to include. Unchecked reports are absent from the
                preview and are never printed.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/reports" className="app-btn">
                ← Back to GL Analysis
              </Link>
            </div>
          </div>

          <div className="app-card p-4">
            <div className="mb-2 flex items-center gap-2 text-[12px]">
              <button type="button" className="app-btn" onClick={checkAll}>
                Check all
              </button>
              <button type="button" className="app-btn" onClick={clearAll}>
                Clear all
              </button>
              <span className="text-muted-foreground">
                {plan.count} of {VIEW_IDS.length} selected
              </span>
            </div>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {VIEW_IDS.map((id) => (
                <li key={id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded border border-border/60 bg-surface px-2 py-1.5 text-sm hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={selected.has(id)}
                      onChange={() => toggle(id)}
                    />
                    <span className="font-medium">{VIEW_META[id].title}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className="app-btn app-btn-primary"
                disabled={!plan.isValid}
                onClick={() => setStep("preview")}
              >
                Prepare Print Preview
              </button>
              {!plan.isValid && (
                <span className="text-[12px] text-destructive">
                  Select at least one report to continue.
                </span>
              )}
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  const orderedSelection = VIEW_IDS.filter((id) => selected.has(id));

  const auditLoading =
    plan.hasAccounting && auditQ.isPending && auditQ.fetchStatus !== "idle";
  const auditError = plan.hasAccounting ? auditQ.error : null;

  return (
    <AppShell>
      <div className="space-y-3 print-all-container report-container">
        <div className="no-print flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Print Preview — {orderedSelection.length} Report
              {orderedSelection.length === 1 ? "" : "s"}
            </h1>
            <p className="text-sm text-muted-foreground">
              Reports flow continuously; the browser paginates each A4 sheet only when
              the previous is full.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="app-btn" onClick={() => setStep("select")}>
              ← Change selection
            </button>
            <button
              type="button"
              className="app-btn app-btn-primary"
              onClick={() => window.print()}
              disabled={plan.hasAccounting && (auditLoading || !!auditError)}
            >
              Print
            </button>
          </div>
        </div>

        {plan.hasAccounting && auditLoading && (
          <div className="app-card p-6 text-sm text-muted-foreground">
            Loading Account Journals for {piDocuments.length} Purchase Invoice
            {piDocuments.length === 1 ? "" : "s"}…
          </div>
        )}
        {plan.hasAccounting && auditError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Purchase Audit failed: {auditError.message}
            <div className="mt-2">
              <button
                type="button"
                className="app-btn"
                onClick={() => auditQ.refetch()}
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {orderedSelection.map((id, idx) => {
          const meta = VIEW_META[id];
          const isFirst = idx === 0;
          return (
            <section
              key={id}
              className={`print-report-section ${isFirst ? "" : "mt-6"}`}
              aria-label={meta.title}
            >
              <div className="print-keep-with-next">
                <h2 className="report-title text-lg font-semibold tracking-tight">
                  {meta.title}
                </h2>
                <p className="report-subtitle text-sm text-muted-foreground">
                  {meta.blurb}
                </p>
              </div>
              <div className="mt-2">
                <CompactReportHeader
                  filter={inquiry.filter}
                  report={cached}
                  audit={
                    isAccountingView(id)
                      ? { data: auditQ.data ?? null, result: auditResult }
                      : undefined
                  }
                />
              </div>
              <div className="mt-2">
                {id === "audit-trail" && (
                  <AuditTrailView
                    loading={auditLoading}
                    error={auditError ?? null}
                    data={auditQ.data ?? null}
                    result={auditResult}
                    docCodeToInvoiceId={docCodeToInvoiceId}
                    piCount={piDocuments.length}
                    onRetry={() => auditQ.refetch()}
                  />
                )}
                {id === "posting-account" && (
                  <PostingAccountView
                    loading={auditLoading}
                    error={auditError ?? null}
                    data={auditQ.data ?? null}
                    result={auditResult}
                    piCount={piDocuments.length}
                    onRetry={() => auditQ.refetch()}
                  />
                )}
                {!isAccountingView(id) && (
                  <DimensionView view={id} report={cached} />
                )}
              </div>
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
