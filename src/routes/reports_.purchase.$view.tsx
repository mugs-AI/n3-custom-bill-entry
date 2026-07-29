// Phase 3B Purchase Audit Reports — shared report shell for all 8 views.
//
// Flat-sibling route (trailing underscore on `reports_`) so it renders on
// its own — reports.tsx is a leaf and has no <Outlet />.
//
// Data flow:
//   Views 3-8 (dimensions) read from the shared GL Analysis React Query
//   cache — zero extra N3 calls. If no cached inquiry is found the page
//   directs the user back to /reports to run one.
//
//   Views 1-2 (Purchase Audit Trail + Posting Account Summary) additionally
//   need PurchaseBook + GL data; those are fetched on demand via
//   /api/reports/purchase-audit, cached per inquiry via useQuery, and shared
//   between the two accounting views.

import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { useAuthToken, useHydrated } from "@/hooks/use-auth";
import { getAuthScope } from "@/lib/draft-store";
import { isoToMy } from "@/lib/date-my";
import { round2, sumTo2dp } from "@/lib/money";
import { n3ListAll } from "@/lib/n3-client";
import {
  DIMENSION_SPECS,
  BLANK_KEY,
  BLANK_LABEL,
  groupByDimension,
  linesForRow,
  totalOf,
  type DimensionKey,
  type DimensionRow,
} from "@/lib/dimensions";
import type { GLDrillDownLine, ReportCriteria, ReportData } from "@/lib/report-model";
import { loadReportSnapshot, reportCacheKey } from "@/lib/report-cache";
import {
  reconcileAudit,
  type AuditDocument,
  type AuditPIDocument,
  type PostingAccountRow,
  type PurchaseAuditResult,
} from "@/lib/audit-trail";
import { canonicalDocCode } from "@/lib/report-keys";
import { computeAuditFingerprint } from "@/lib/audit-fingerprint";
import {
  fetchAudit,
  loadInquiry,
  normalizeAuditFilter,
  type AuditFetchReply,
} from "@/lib/purchase-report-inquiry";


// ----- Route --------------------------------------------------------------

export type ViewId =
  | "audit-trail"
  | "posting-account"
  | DimensionKey;

export const VIEW_META: Record<ViewId, { title: string; navLabel: string; blurb: string }> = {
  "audit-trail": {
    title: "Purchase Audit Trail",
    navLabel: "Purchase Audit Trail",
    blurb:
      "Every Purchase Invoice with its supplier creditor line and every reconciled GL posting per document.",
  },
  "posting-account": {
    title: "Posting Account Summary",
    navLabel: "Posting Account Summary",
    blurb: "GL Debit and Credit totals per posting account for the current audit set.",
  },
  wbs: {
    title: "Summary of WBS — N3 Stock Codes",
    navLabel: "WBS",
    blurb: "Live totals grouped by WBS / Stock.",
  },
  "hq-sequence": {
    title: "Summary of HQ Sequence — N3 Purchase Description",
    navLabel: "HQ Sequence",
    blurb: "Live totals grouped by HQ Sequence (Purchase Invoice description).",
  },
  "cost-centre": {
    title: "Summary of Cost Centre — N3 Project Codes",
    navLabel: "Cost Centre",
    blurb: "Live totals grouped by Cost Centre / Project.",
  },
  "order-number": {
    title: "Summary of Order Number — N3 Tariff Codes",
    navLabel: "Order Number",
    blurb: "Live totals grouped by Order No. / Tariff Code.",
  },
  "payment-type": {
    title: "Summary of Payment Type — N3 Purchaser",
    navLabel: "Payment Type",
    blurb: "Live totals grouped by Payment Type / Purchaser.",
  },
  "hq-tax": {
    title: "Summary of HQ Tax — N3 SST Tax Codes",
    navLabel: "HQ Tax",
    blurb: "Live totals grouped by HQ Tax / Input Tax Code.",
  },
};

export const VIEW_IDS: ViewId[] = [
  "audit-trail",
  "posting-account",
  "wbs",
  "hq-sequence",
  "cost-centre",
  "order-number",
  "payment-type",
  "hq-tax",
];

export function isAccountingView(v: ViewId): boolean {
  return v === "audit-trail" || v === "posting-account";
}

export const Route = createFileRoute("/reports_/purchase/$view")({
  head: ({ params }) => {
    const meta = VIEW_META[(params.view as ViewId) ?? "audit-trail"] ?? VIEW_META["audit-trail"];
    return {
      meta: [
        { title: `${meta.title} · Custom Bill Entry` },
        { name: "description", content: meta.blurb },
        { property: "og:title", content: `${meta.title} · Custom Bill Entry` },
        { property: "og:description", content: meta.blurb },
      ],
    };
  },
  component: PurchaseReportPage,
});

// ----- Format helpers -----------------------------------------------------

const MYR = new Intl.NumberFormat("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmt(n: number): string {
  return MYR.format(Number.isFinite(n) ? n : 0);
}


// ----- Component ---------------------------------------------------------

function PurchaseReportPage() {
  const params = useParams({ from: "/reports_/purchase/$view" });
  const viewId = (VIEW_IDS.includes(params.view as ViewId) ? (params.view as ViewId) : "audit-trail") as ViewId;
  const meta = VIEW_META[viewId];
  const hydrated = useHydrated();
  const token = useAuthToken();
  const queryClient = useQueryClient();

  const inquiry = useMemo(() => (hydrated ? loadInquiry() : null), [hydrated]);

  // Correction A Task 2: rehydrate the completed inquiry into the shared
  // React Query cache on mount, so a refresh or direct-open of this route
  // sees the previous inquiry even after GL Analysis unmounted and its
  // default gcTime elapsed.
  useEffect(() => {
    if (!hydrated) return;
    const snap = loadReportSnapshot();
    if (snap) {
      queryClient.setQueryData(reportCacheKey(snap.filter), snap.report);
    }
  }, [hydrated, queryClient]);

  // Observer keeps the cache entry alive as long as this page is mounted.
  const cachedQ = useQuery<ReportData | null>({
    queryKey: inquiry ? reportCacheKey(inquiry.filter) : ["report", "gl-analysis", "none"],
    queryFn: () => Promise.resolve(null as unknown as ReportData),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Correction A Task 4: tariff master (client-side hydration) so lines
  // captured before Detail hydration still show Tariff Code + Description.
  const tariffQ = useQuery({
    queryKey: ["n3", "tariffCodes"],
    enabled: hydrated && !!token,
    queryFn: ({ signal }) =>
      n3ListAll<{ id: number; code?: string; description?: string }>(
        "api/TariffCodes/Query",
        { pageSize: 500, signal },
      ),
    staleTime: 5 * 60_000,
    retry: (c) => c < 1,
  });
  const tariffMap = useMemo(() => {
    const m = new Map<number, { code: string; description: string }>();
    for (const r of tariffQ.data ?? []) {
      m.set(r.id, { code: r.code ?? "", description: r.description ?? "" });
    }
    return m;
  }, [tariffQ.data]);

  const rawCached = cachedQ.data ?? null;
  const cached = useMemo<ReportData | null>(() => {
    if (!rawCached) return null;
    if (tariffMap.size === 0) return rawCached;
    // Enrich only lines missing Tariff Code / Description but carrying an ID.
    let mutated = false;
    const lines = rawCached.lines.map((l) => {
      if (l.tariffCodeId != null && (!l.tariffCode || !l.tariffDescription)) {
        const hit = tariffMap.get(l.tariffCodeId);
        if (hit) {
          mutated = true;
          return {
            ...l,
            tariffCode: l.tariffCode || hit.code,
            tariffDescription: l.tariffDescription || hit.description,
          };
        }
      }
      return l;
    });
    return mutated ? { ...rawCached, lines } : rawCached;
  }, [rawCached, tariffMap]);

  // Correction C: Purchase Audit reads the current GL Analysis inquiry as
  // its authoritative document set. One AuditPIDocument per Purchase
  // Invoice, deduplicated by canonical docCode. Term/currency default to
  // display-only values when not surfaced through GLDrillDownLine.
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

  // Canonical doc-code -> immutable N3 invoice id, built once from the
  // current GL Analysis report. Audit Trail PI numbers use this map to
  // link into /purchase-invoices/{invoiceId}/edit without an extra fetch.
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


  const isAccountingView = viewId === "audit-trail" || viewId === "posting-account";

  // Correction E §6: a stable audit fingerprint drawn from the current GL
  // Analysis data. Any change in an invoice's identity or accounting amount
  // changes the fingerprint and therefore the cache key.
  const auditFingerprint = useMemo(() => computeAuditFingerprint(cached), [cached]);
  const authScope = useMemo(() => (hydrated ? getAuthScope() : { tenantId: "", userId: "" }), [hydrated]);
  const normalizedFilter = useMemo(
    () => (inquiry ? normalizeAuditFilter(inquiry.filter) : null),
    [inquiry],
  );

  const auditQ = useQuery<AuditFetchReply, Error>({
    queryKey: [
      "purchase-audit",
      authScope.tenantId,
      authScope.userId,
      normalizedFilter,
      auditFingerprint,
    ],
    enabled: hydrated && !!token && !!cached && isAccountingView && piDocuments.length > 0,
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

  // Header
  return (
    <AppShell>
      <div className="space-y-3 report-container">
        {/* Title stays visible in print (Task 1). */}
        <div className="print-keep-with-next">
          <h1 className="report-title text-xl font-semibold tracking-tight">
            {meta.title}
          </h1>
          <p className="report-subtitle text-sm text-muted-foreground">{meta.blurb}</p>
        </div>

        <div className="no-print flex flex-wrap items-end justify-end gap-2">
          <Link to="/reports" className="app-btn">
            ← Back to GL Analysis
          </Link>
          {cached && (
            <>
              <Link to="/reports/purchase/print-all" className="app-btn">
                Print All 8 Reports
              </Link>
              <button
                type="button"
                className="app-btn app-btn-primary"
                onClick={() => window.print()}
              >
                Print
              </button>
            </>
          )}
        </div>

        <ReportNav current={viewId} />

        {!hydrated || !token ? (
          <div className="app-card p-6 text-sm text-muted-foreground">
            Sign in to N3 to view Purchase Reports.
          </div>
        ) : !inquiry || !inquiry.ran || !cached ? (
          <div className="app-card p-6 text-sm">
            <p className="text-muted-foreground">
              No GL Analysis inquiry is currently loaded. Run an inquiry first, then return
              to this report.
            </p>
            <div className="mt-3">
              <Link to="/reports" className="app-btn app-btn-primary">
                Go to GL Analysis
              </Link>
            </div>
          </div>
        ) : (
          <>
            <CompactReportHeader
              filter={inquiry.filter}
              report={cached}
              audit={isAccountingView ? { data: auditQ.data ?? null, result: auditResult } : undefined}
            />
            {viewId === "audit-trail" && (
              <AuditTrailView
                loading={auditQ.isPending && auditQ.fetchStatus !== "idle"}
                error={auditQ.error ?? null}
                data={auditQ.data ?? null}
                result={auditResult}
                docCodeToInvoiceId={docCodeToInvoiceId}
                piCount={piDocuments.length}
                onRetry={() => auditQ.refetch()}
              />
            )}
            {viewId === "posting-account" && (
              <PostingAccountView
                loading={auditQ.isPending && auditQ.fetchStatus !== "idle"}
                error={auditQ.error ?? null}
                data={auditQ.data ?? null}
                result={auditResult}
                piCount={piDocuments.length}
                onRetry={() => auditQ.refetch()}
              />
            )}
            {!isAccountingView && <DimensionView view={viewId} report={cached} />}
          </>
        )}
      </div>
    </AppShell>
  );
}

// ----- Report navigation --------------------------------------------------

function ReportNav({ current }: { current: ViewId }) {
  return (
    <div className="no-print flex flex-wrap gap-1.5 rounded-md border border-border bg-surface-2 p-1.5 text-[12px]">
      {VIEW_IDS.map((id) => (
        <Link
          key={id}
          to="/reports/purchase/$view"
          params={{ view: id }}
          className={`rounded px-2 py-1 font-medium ${
            current === id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-surface hover:text-foreground"
          }`}
        >
          {VIEW_META[id].navLabel}
        </Link>
      ))}
    </div>
  );
}

/**
 * Combined single-card header (Task 2). Replaces the earlier InquiryStamp +
 * AuditReconcileHeader stack so print pages don't waste vertical space on
 * duplicate framing. Accounting views pass `audit` to include the extra
 * mini-stats and warnings; dimension views omit it.
 */
export function CompactReportHeader({
  filter,
  report,
  audit,
}: {
  filter: ReportCriteria;
  report: ReportData;
  audit?: { data: AuditFetchReply | null; result: PurchaseAuditResult | null };
}) {
  const auditData = audit?.data;
  const auditResult = audit?.result;
  const targetPIs =
    auditData?.meta?.targetInvoiceCount ?? auditData?.meta?.piDocumentCount ?? 0;
  return (
    <div className="app-card compact-report-header p-3 text-[12px] print-keep-with-next">
      <div className="grid gap-2 md:grid-cols-3">
        <div>
          <div className="crh-label text-[10px] font-semibold uppercase text-muted-foreground">
            Period
          </div>
          <div className="crh-value text-foreground">
            {isoToMy(filter.dateFrom)} → {isoToMy(filter.dateTo)}
          </div>
        </div>
        <div>
          <div className="crh-label text-[10px] font-semibold uppercase text-muted-foreground">
            Coverage
          </div>
          <div className="crh-value text-foreground">
            {report.fetchedInvoiceCount} Purchase Invoice
            {report.fetchedInvoiceCount === 1 ? "" : "s"} · {report.summary.lineCount} line
            {report.summary.lineCount === 1 ? "" : "s"}
          </div>
        </div>
        <div>
          <div className="crh-label text-[10px] font-semibold uppercase text-muted-foreground">
            GL Analysis totals (MYR)
          </div>
          <div className="crh-value tabular text-foreground">
            Before {fmt(report.summary.beforeTax)} · Tax {fmt(report.summary.taxAmount)} · Incl{" "}
            {fmt(report.summary.includingTax)}
          </div>
        </div>
      </div>
      {audit && auditData && auditResult && (
        <>
          <div className="mt-2 grid gap-2 border-t border-border/60 pt-2 md:grid-cols-4">
            <MiniStat label="Target PIs" value={String(targetPIs)} />
            <MiniStat
              label="Upstream requests"
              value={String(auditData.meta?.upstreamRequestCount ?? 0)}
            />
            <MiniStat label="GL rows matched" value={String(auditResult.glRowsUsed)} />
            <MiniStat
              label="Documents reconciled"
              value={String(auditResult.documents.length)}
            />
          </div>
          {auditResult.docsWithoutGL.length > 0 && (
            <div className="crh-warn mt-1.5 text-destructive">
              {auditResult.docsWithoutGL.length} Purchase Invoice
              {auditResult.docsWithoutGL.length === 1 ? "" : "s"} had no matching GL postings:{" "}
              <span className="tabular">
                {auditResult.docsWithoutGL.slice(0, 6).join(", ")}
                {auditResult.docsWithoutGL.length > 6 ? "…" : ""}
              </span>
            </div>
          )}
          {auditResult.incompleteReasons.length > 0 && (
            <ul className="crh-warn mt-1.5 list-disc pl-5 text-destructive">
              {auditResult.incompleteReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// ----- Dimension views (3-8) ----------------------------------------------

function DimensionView({ view, report }: { view: DimensionKey; report: ReportData }) {
  const spec = DIMENSION_SPECS[view];
  const rows = useMemo(() => groupByDimension(report.lines, view), [report.lines, view]);
  const totals = useMemo(() => totalOf(rows), [rows]);
  const glTotals = report.summary;
  const reconciles =
    round2(Math.abs(totals.beforeTax - glTotals.beforeTax)) < 0.011 &&
    round2(Math.abs(totals.taxAmount - glTotals.taxAmount)) < 0.011 &&
    round2(Math.abs(totals.includingTax - glTotals.includingTax)) < 0.011;

  // Correction A Task 5: one row can be expanded at a time; the drilled-in
  // detail panel renders directly below the summary table and is hidden in
  // print via the .no-print utility so hard copies stay one clean summary.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const drillLines = useMemo(
    () => (expandedKey ? linesForRow(report.lines, view, expandedKey) : []),
    [expandedKey, report.lines, view],
  );
  const drillRow = expandedKey ? rows.find((r) => r.key === expandedKey) ?? null : null;

  return (
    <div className="app-card p-3">
      <div className="mb-2 text-[11px] text-muted-foreground">
        Source: {spec.source}. {rows.length} row{rows.length === 1 ? "" : "s"}.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="bg-surface-2 text-[11px] uppercase text-muted-foreground">
            <tr>
              <Th>{spec.codeHeader}</Th>
              <Th>{spec.descriptionHeader}</Th>
              <Th className="text-right">Invoices</Th>
              <Th className="text-right">Lines</Th>
              <Th className="text-right">Before Tax</Th>
              <Th className="text-right">Tax</Th>
              <Th className="text-right">Including Tax</Th>
              <Th className="no-print" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <Td colSpan={8} className="text-center text-muted-foreground">
                  No data.
                </Td>
              </tr>
            ) : (
              rows.map((r) => (
                <DimensionRowView
                  key={r.key}
                  row={r}
                  expanded={expandedKey === r.key}
                  onDrill={() =>
                    setExpandedKey((cur) => (cur === r.key ? null : r.key))
                  }
                />
              ))
            )}
          </tbody>
          <tfoot className="bg-surface-2 text-[12px]">
            <tr>
              <Td colSpan={4} className="text-right font-semibold">
                Total
              </Td>
              <Td className="tabular text-right font-semibold">{fmt(totals.beforeTax)}</Td>
              <Td className="tabular text-right font-semibold">{fmt(totals.taxAmount)}</Td>
              <Td className="tabular text-right font-semibold">{fmt(totals.includingTax)}</Td>
              <Td className="no-print" />
            </tr>
          </tfoot>
        </table>
      </div>
      <div
        className={`mt-2 text-[11px] ${reconciles ? "text-success" : "text-destructive"}`}
      >
        {reconciles
          ? "Reconciles with GL Analysis totals."
          : "Does not reconcile with GL Analysis totals — please re-run the inquiry."}
      </div>
      {drillRow && (
        <div className="no-print mt-3">
          <DimensionDrillPanel
            spec={{
              codeHeader: spec.codeHeader,
              descriptionHeader: spec.descriptionHeader,
            }}
            row={drillRow}
            lines={drillLines}
            onClose={() => setExpandedKey(null)}
          />
        </div>
      )}
    </div>
  );
}

function DimensionRowView({
  row,
  expanded,
  onDrill,
}: {
  row: DimensionRow;
  expanded: boolean;
  onDrill: () => void;
}) {
  const isBlank = row.key === BLANK_KEY;
  return (
    <tr
      className={`border-t border-border/60 ${expanded ? "bg-primary/5" : ""}`}
    >
      <Td className="font-medium">{isBlank ? "" : row.code}</Td>
      <Td>{isBlank ? BLANK_LABEL : row.description}</Td>
      <Td className="tabular text-right">{row.invoiceCount}</Td>
      <Td className="tabular text-right">{row.lineCount}</Td>
      <Td className="tabular text-right">{fmt(row.beforeTax)}</Td>
      <Td className="tabular text-right">{fmt(row.taxAmount)}</Td>
      <Td className="tabular text-right">{fmt(row.includingTax)}</Td>
      <Td className="no-print">
        <button type="button" className="app-btn" onClick={onDrill}>
          {expanded ? "Hide" : "Drill"}
        </button>
      </Td>
    </tr>
  );
}

function DimensionDrillPanel({
  spec,
  row,
  lines,
  onClose,
}: {
  spec: { codeHeader: string; descriptionHeader: string };
  row: DimensionRow;
  lines: GLDrillDownLine[];
  onClose: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase text-muted-foreground">
            {spec.codeHeader} · {spec.descriptionHeader}
          </div>
          <div className="text-sm font-semibold">
            {row.key === BLANK_KEY
              ? BLANK_LABEL
              : `${row.code || "—"} · ${row.description || ""}`}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {row.invoiceCount} invoices · {row.lineCount} lines · Incl {fmt(row.includingTax)}
          </div>
        </div>
        <button type="button" className="app-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="bg-surface-2 text-[11px] uppercase text-muted-foreground">
            <tr>
              <Th>Date</Th>
              <Th>PI No.</Th>
              <Th>Supplier</Th>
              <Th>GL Account</Th>
              <Th>Item Description</Th>
              <Th className="text-right">Qty</Th>
              <Th className="text-right">Before Tax</Th>
              <Th className="text-right">Tax</Th>
              <Th className="text-right">Including Tax</Th>
              <Th>Ref No.</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={`${l.invoiceId}:${l.pos}`} className="border-t border-border/60">
                <Td>{isoToMy(l.docDate)}</Td>
                <Td><PILink invoiceId={l.invoiceId} docCode={l.docCode} /></Td>
                <Td>
                  <div className="tabular text-[12px] text-muted-foreground">
                    {l.supplierCode}
                  </div>
                  <div>{l.supplierName}</div>
                </Td>
                <Td>
                  <div className="tabular text-[12px] text-muted-foreground">
                    {l.glAccountCode}
                  </div>
                  <div>{l.glAccountName}</div>
                </Td>
                <Td className="max-w-[280px] truncate">
                  {l.itemDescription}
                </Td>
                <Td className="tabular text-right">{fmt(l.qty)}</Td>
                <Td className="tabular text-right">{fmt(l.beforeTax)}</Td>
                <Td className="tabular text-right">{fmt(l.taxAmount)}</Td>
                <Td className="tabular text-right">{fmt(l.includingTax)}</Td>
                <Td>{l.referenceNo}</Td>
              </tr>
            ))}
            {lines.length === 0 && (
              <tr>
                <Td colSpan={10} className="text-center text-muted-foreground">
                  No contributing lines.
                </Td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ----- View 1: Purchase Audit Trail ---------------------------------------

function AuditTrailView({
  loading,
  error,
  data,
  result,
  docCodeToInvoiceId,
  piCount,
  onRetry,
}: {
  loading: boolean;
  error: Error | null;
  data: AuditFetchReply | null;
  result: PurchaseAuditResult | null;
  docCodeToInvoiceId: Map<string, string>;
  piCount: number;
  onRetry: () => void;
}) {
  if (loading)
    return (
      <div className="app-card p-6 text-sm text-muted-foreground">
        Loading Account Journals for {piCount} Purchase Invoice
        {piCount === 1 ? "" : "s"}…
      </div>
    );
  if (error)
    return (
      <ErrorCard
        title="Incomplete Purchase Audit Trail"
        message={error.message}
        onRetry={onRetry}
      />
    );

  if (!data || !result) return null;
  return (
    <div className="space-y-3">
      {result.documents.length === 0 ? (
        <div className="app-card p-6 text-sm text-muted-foreground">
          No documents in the audit set.
        </div>
      ) : (
        result.documents.map((doc) => (
          <AuditDocumentCard
            key={doc.docCode}
            doc={doc}
            invoiceId={docCodeToInvoiceId.get(canonicalDocCode(doc.docCode)) ?? ""}
          />
        ))
      )}
      <div className="app-card p-3">
        <div className="grid gap-2 md:grid-cols-3">
          <TotalBox label="Grand Debit (MYR)" value={fmt(result.grandDebit)} />
          <TotalBox label="Grand Credit (MYR)" value={fmt(result.grandCredit)} />
          <BalanceStatusBox status={result.balanceStatus} />
        </div>
      </div>
    </div>
  );
}

function AuditDocumentCard({ doc, invoiceId }: { doc: AuditDocument; invoiceId: string }) {
  return (
    <div
      className={`app-card overflow-hidden ${
        doc.incomplete ? "border-l-4 border-l-destructive" : "border-l-4 border-l-success"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border bg-surface-2 px-3 py-2">
        <div>
          <div className="text-sm font-semibold">
            <PILink invoiceId={invoiceId} docCode={doc.docCode} /> · {doc.supplierCode || "—"} {doc.supplierName || ""}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {isoToMy(doc.docDate)} · Term {doc.termDescription || "—"}
            {doc.dueDate ? ` · Due ${isoToMy(doc.dueDate)}` : ""}
          </div>
        </div>
        <div className="text-[11px]">
          <span className="tabular font-semibold">
            Dr {fmt(doc.debit)} · Cr {fmt(doc.credit)}
          </span>{" "}
          {doc.balanced ? (
            <span className="text-success">balanced</span>
          ) : (
            <span className="text-destructive">unbalanced</span>
          )}
        </div>
      </div>
      {doc.incomplete && doc.incompleteReason && (
        <div className="bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {doc.incompleteReason}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-surface-2 text-[11px] uppercase text-muted-foreground">
            <tr>
              <Th>Account</Th>
              <Th>Description</Th>
              <Th className="text-right">Debit</Th>
              <Th className="text-right">Credit</Th>
            </tr>
          </thead>
          <tbody>
            {doc.creditor && (
              <tr className="border-t border-border/60 bg-primary/5">
                <Td className="font-medium">
                  {doc.creditor.accountCode}{" "}
                  <span className="text-[10px] uppercase text-muted-foreground">creditor</span>
                </Td>
                <Td>{doc.creditor.accountName}</Td>
                <Td className="tabular text-right">{fmt(doc.creditor.debit)}</Td>
                <Td className="tabular text-right">{fmt(doc.creditor.credit)}</Td>
              </tr>
            )}
            {doc.postings.map((p, i) => (
              <tr key={`${p.accountCode}:${i}`} className="border-t border-border/60">
                <Td>{p.accountCode}</Td>
                <Td>{p.accountName}</Td>
                <Td className="tabular text-right">{fmt(p.debit)}</Td>
                <Td className="tabular text-right">{fmt(p.credit)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuditReconcileHeader({
  result,
  data,
}: {
  result: PurchaseAuditResult;
  data: AuditFetchReply;
}) {
  const strategy = data.meta?.strategy;
  const elapsed =
    typeof data.meta?.elapsedMs === "number"
      ? Math.max(1, Math.round(data.meta.elapsedMs / 100) / 10)
      : null;
  const targetPIs = data.meta?.targetInvoiceCount ?? data.meta?.piDocumentCount ?? 0;
  const rowsMatched = data.meta?.rowsMatched ?? result.glRowsUsed;
  return (
    <div className="app-card p-3 text-[12px]">
      <div className="grid gap-2 md:grid-cols-4">
        <MiniStat label="Target PIs" value={String(targetPIs)} />
        <MiniStat
          label="Upstream requests"
          value={String(data.meta?.upstreamRequestCount ?? 0)}
        />
        <MiniStat label="GL rows matched" value={String(result.glRowsUsed)} />
        <MiniStat
          label="Documents reconciled"
          value={String(result.documents.length)}
        />
      </div>
      {strategy && (
        <div className="no-print mt-2 text-muted-foreground">
          {strategy === "purchase-invoice-glposting" ? (
            <>
              Source: N3 Purchase Invoice Account Journal · {targetPIs} invoice
              {targetPIs === 1 ? "" : "s"} · {rowsMatched} row
              {rowsMatched === 1 ? "" : "s"}
              {elapsed != null ? ` · ${elapsed}s` : ""}
            </>
          ) : (
            <>
              Source: N3 General Ledger fallback
              {data.meta?.fallbackReason ? ` — ${data.meta.fallbackReason}` : ""}
            </>
          )}
        </div>
      )}
      {result.docsWithoutGL.length > 0 && (
        <div className="mt-2 text-destructive">
          {result.docsWithoutGL.length} Purchase Invoice
          {result.docsWithoutGL.length === 1 ? "" : "s"} had no matching GL
          postings:{" "}
          <span className="tabular">
            {result.docsWithoutGL.slice(0, 6).join(", ")}
            {result.docsWithoutGL.length > 6 ? "…" : ""}
          </span>
        </div>
      )}
      {result.incompleteReasons.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-destructive">
          {result.incompleteReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ----- View 2: Posting Account Summary ------------------------------------

function PostingAccountView({
  loading,
  error,
  data,
  result,
  piCount,
  onRetry,
}: {
  loading: boolean;
  error: Error | null;
  data: AuditFetchReply | null;
  result: PurchaseAuditResult | null;
  piCount: number;
  onRetry: () => void;
}) {
  if (loading)
    return (
      <div className="app-card p-6 text-sm text-muted-foreground">
        Loading Account Journals for {piCount} Purchase Invoice
        {piCount === 1 ? "" : "s"}…
      </div>
    );

  if (error)
    return (
      <ErrorCard
        title="Incomplete Posting Account Summary"
        message={error.message}
        onRetry={onRetry}
      />
    );
  if (!data || !result) return null;
  const notEvaluated = result.balanceStatus === "not-evaluated";
  return (
    <div className="space-y-3">
      <AuditReconcileHeader result={result} data={data} />
      {notEvaluated && (
        <div className="app-card border-l-4 border-l-destructive p-3 text-sm">
          Posting Account Summary was not evaluated: no GL rows matched the current Purchase Invoice set.
        </div>
      )}
      <div className="app-card overflow-x-auto p-3">
        <table className="w-full min-w-[600px] text-left text-sm">
          <thead className="bg-surface-2 text-[11px] uppercase text-muted-foreground">
            <tr>
              <Th>Account Code</Th>
              <Th>Account Name</Th>
              <Th className="text-right">Debit (MYR)</Th>
              <Th className="text-right">Credit (MYR)</Th>
              <Th className="text-right">Net (Dr - Cr)</Th>
            </tr>
          </thead>
          <tbody>
            {result.postingAccounts.length === 0 ? (
              <tr>
                <Td colSpan={5} className="text-center text-muted-foreground">
                  No posting rows.
                </Td>
              </tr>
            ) : (
              result.postingAccounts.map((r: PostingAccountRow) => (
                <tr key={r.accountCode} className="border-t border-border/60">
                  <Td className="font-medium">{r.accountCode}</Td>
                  <Td>{r.accountName}</Td>
                  <Td className="tabular text-right">{fmt(r.debit)}</Td>
                  <Td className="tabular text-right">{fmt(r.credit)}</Td>
                  <Td className="tabular text-right">{fmt(round2(r.debit - r.credit))}</Td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot className="bg-surface-2 text-[12px]">
            <tr>
              <Td colSpan={2} className="text-right font-semibold">
                Total
              </Td>
              <Td className="tabular text-right font-semibold">
                {fmt(sumTo2dp(result.postingAccounts.map((r) => r.debit)))}
              </Td>
              <Td className="tabular text-right font-semibold">
                {fmt(sumTo2dp(result.postingAccounts.map((r) => r.credit)))}
              </Td>
              <Td className="tabular text-right font-semibold">
                {fmt(round2(result.grandDebit - result.grandCredit))}
              </Td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ----- Little widgets -----------------------------------------------------

function TotalBox({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "bad";
}) {
  return (
    <div className="app-card p-3">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div
        className={`tabular text-lg font-semibold ${
          tone === "ok" ? "text-success" : tone === "bad" ? "text-destructive" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="tabular font-semibold">{value}</div>
    </div>
  );
}

function ErrorCard({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <div>
        <strong>{title}:</strong> {message}
      </div>
      <button type="button" className="app-btn mt-2" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <th className={`px-3 py-2 font-semibold ${className ?? ""}`}>{children}</th>;
}

function Td({
  children,
  className,
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className={`px-3 py-2 align-top ${className ?? ""}`}>
      {children}
    </td>
  );
}

// PI Number link. When we know the immutable N3 invoice id, render a link
// into /purchase-invoices/{id}/edit. Otherwise show the number as plain
// text with a tooltip so the operator understands why it isn't clickable.
function PILink({ invoiceId, docCode }: { invoiceId: string; docCode: string }) {
  if (!invoiceId) {
    return (
      <span title="Edit link unavailable (no N3 invoice id in the current inquiry)">
        {docCode}
      </span>
    );
  }
  return (
    <Link
      to="/purchase-invoices/$id/edit"
      params={{ id: invoiceId }}
      className="text-primary underline-offset-2 hover:underline"
    >
      {docCode}
    </Link>
  );
}

function BalanceStatusBox({ status }: { status: import("@/lib/audit-trail").BalanceStatus }) {
  const { label, tone } =
    status === "balanced"
      ? { label: "Yes", tone: "ok" as const }
      : status === "unbalanced"
        ? { label: "No", tone: "bad" as const }
        : { label: "Not evaluated", tone: undefined };
  return <TotalBox label="Balanced" value={label} tone={tone} />;
}
