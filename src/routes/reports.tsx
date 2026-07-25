import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { SearchableSelect, type ComboOption } from "@/components/SearchableSelect";
import { useAuthToken, useHydrated } from "@/hooks/use-auth";
import { getToken } from "@/lib/auth-store";
import { n3ListAll } from "@/lib/n3-client";
import { getAuthScope } from "@/lib/draft-store";
import { isoToMy, todayISOInKL } from "@/lib/date-my";
import type {
  GLAccountSummary,
  ReportCriteria,
  ReportData,
} from "@/lib/report-model";

// GL Analysis / Purchase Audit Trail — Phase 3A.
//
// Inquiry-driven read-only dashboard. Zero requests until the user clicks
// "Run inquiry". Persists inquiry state (filters + selected drill-down) per
// tenant/user in sessionStorage so a round-trip through the edit route
// restores the exact view without a re-fetch.

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "GL Analysis · Custom Bill Entry" },
      {
        name: "description",
        content:
          "Live GL Purchase Analysis over N3 Purchase Invoices — group by GL Account with drill-down.",
      },
      { property: "og:title", content: "GL Analysis · Custom Bill Entry" },
      {
        property: "og:description",
        content: "Live GL Purchase Analysis over N3 Purchase Invoices.",
      },
    ],
  }),
  component: ReportsPage,
});

// -------------- Number formatting (comma + 2dp, keep sign) --------------
const MYR = new Intl.NumberFormat("en-MY", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
function fmt(n: number): string {
  return MYR.format(Number.isFinite(n) ? n : 0);
}

// -------------- Sessionstorage persistence --------------
const INQUIRY_EVENT = "custom-bill-entry:gl-analysis-inquiry-change";

type Preset = "this-month" | "prev-month" | "this-year" | "custom";
type SortKey = "code" | "invoiceCount" | "beforeTax" | "taxAmount" | "includingTax";

interface InquiryState {
  preset: Preset;
  filter: ReportCriteria;
  supplierLabel?: string;
  purchaserLabel?: string;
  projectLabel?: string;
  stockLabel?: string;
  taxCodeLabel?: string;
  ran: boolean;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  drillCode: string | null;
  drillPage: number;
  drillPageSize: 20 | 50 | 100;
}

function firstOfMonthKL(): string {
  const today = todayISOInKL();
  return `${today.slice(0, 8)}01`;
}

function defaultsForPreset(preset: Preset): { dateFrom: string; dateTo: string } {
  const today = todayISOInKL();
  if (preset === "this-month") return { dateFrom: firstOfMonthKL(), dateTo: today };
  if (preset === "prev-month") {
    const [y, m] = today.split("-").map(Number);
    const prevMonth = m === 1 ? 12 : m - 1;
    const prevYear = m === 1 ? y - 1 : y;
    const daysInPrev = new Date(prevYear, prevMonth, 0).getDate();
    const mm = String(prevMonth).padStart(2, "0");
    return {
      dateFrom: `${prevYear}-${mm}-01`,
      dateTo: `${prevYear}-${mm}-${String(daysInPrev).padStart(2, "0")}`,
    };
  }
  if (preset === "this-year") {
    const y = today.slice(0, 4);
    return { dateFrom: `${y}-01-01`, dateTo: today };
  }
  return { dateFrom: firstOfMonthKL(), dateTo: today };
}

function defaultInquiry(): InquiryState {
  const d = defaultsForPreset("this-month");
  return {
    preset: "this-month",
    filter: { dateFrom: d.dateFrom, dateTo: d.dateTo },
    ran: false,
    sortKey: "includingTax",
    sortDir: "desc",
    drillCode: null,
    drillPage: 1,
    drillPageSize: 50,
  };
}

function storageKey(): string {
  const s = getAuthScope();
  return `custom-bill-entry:gl-analysis-inquiry:${s.tenantId}:${s.userId}`;
}

function loadInquiry(): InquiryState {
  if (typeof window === "undefined") return defaultInquiry();
  try {
    const raw = window.sessionStorage.getItem(storageKey());
    if (!raw) return defaultInquiry();
    const parsed = JSON.parse(raw) as Partial<InquiryState>;
    return { ...defaultInquiry(), ...parsed };
  } catch {
    return defaultInquiry();
  }
}

function saveInquiry(s: InquiryState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey(), JSON.stringify(s));
    window.dispatchEvent(new Event(INQUIRY_EVENT));
  } catch {
    /* ignore */
  }
}

// -------------- Master data (shared with New Bill via identical query keys) --------------
interface Named {
  id: number;
  code?: string;
  name?: string;
  description?: string;
}

const noRetryOn401 = (count: number) => count < 1;

// -------------- Server call --------------
async function fetchReport(criteria: ReportCriteria): Promise<ReportData> {
  const token = getToken();
  if (!token) throw new Error("Not signed in to N3.");
  const res = await fetch("/api/reports/gl-analysis", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(criteria),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok || !body || typeof body !== "object" || !(body as { ok?: boolean }).ok) {
    const b = body as { error?: string; kind?: string; matchedInvoiceCount?: number } | null;
    const msg = b?.error || `Report failed (${res.status})`;
    const err = new Error(msg) as Error & { kind?: string; matchedInvoiceCount?: number };
    err.kind = b?.kind;
    err.matchedInvoiceCount = b?.matchedInvoiceCount;
    throw err;
  }
  return (body as { report: ReportData }).report;
}

// -------------- Component --------------
function ReportsPage() {
  const hydrated = useHydrated();
  const token = useAuthToken();

  const [inquiry, setInquiry] = useState<InquiryState>(defaultInquiry);
  useEffect(() => setInquiry(loadInquiry()), []);
  useEffect(() => saveInquiry(inquiry), [inquiry]);

  const setFilter = useCallback((patch: Partial<ReportCriteria>) => {
    setInquiry((s) => ({ ...s, filter: { ...s.filter, ...patch } }));
  }, []);

  const setPreset = useCallback((preset: Preset) => {
    setInquiry((s) => {
      if (preset === "custom") return { ...s, preset };
      const d = defaultsForPreset(preset);
      return { ...s, preset, filter: { ...s.filter, dateFrom: d.dateFrom, dateTo: d.dateTo } };
    });
  }, []);

  // Master queries — reuse identical query keys as New Bill Entry so React
  // Query dedupes the tenant's master cache.
  const suppliersQ = useQuery({
    queryKey: ["n3", "suppliers"],
    enabled: hydrated && !!token,
    queryFn: ({ signal }) => n3ListAll<Named>("api/Suppliers/List", { pageSize: 500, signal }),
    staleTime: 60_000,
    retry: noRetryOn401,
  });
  const purchasersQ = useQuery({
    queryKey: ["n3", "purchasers"],
    enabled: hydrated && !!token,
    queryFn: ({ signal }) => n3ListAll<Named>("api/Purchasers/Query", { pageSize: 500, signal }),
    staleTime: 60_000,
    retry: noRetryOn401,
  });
  const projectsQ = useQuery({
    queryKey: ["n3", "projects"],
    enabled: hydrated && !!token,
    queryFn: ({ signal }) => n3ListAll<Named>("api/Projects/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000,
    retry: noRetryOn401,
  });
  const stocksQ = useQuery({
    queryKey: ["n3", "stocks"],
    enabled: hydrated && !!token,
    queryFn: ({ signal }) => n3ListAll<Named>("api/Stocks/List", { pageSize: 500, signal }),
    staleTime: 5 * 60_000,
    retry: noRetryOn401,
  });
  const taxCodesQ = useQuery({
    queryKey: ["n3", "taxCodes"],
    enabled: hydrated && !!token,
    queryFn: ({ signal }) =>
      n3ListAll<Named>("api/TaxCodes/InputTax/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000,
    retry: noRetryOn401,
  });

  const toOptions = useCallback(
    (rows: Named[] | undefined, useDesc = false): ComboOption[] => {
      if (!rows) return [];
      return rows
        .map((r) => ({
          value: String(r.id),
          label: `${r.code ?? ""} — ${useDesc ? r.description ?? r.name ?? "" : r.name ?? ""}`.replace(
            /^ — /,
            "",
          ),
          hint: useDesc ? r.description ?? r.name : r.name,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    },
    [],
  );

  const supplierOpts = useMemo(() => toOptions(suppliersQ.data), [toOptions, suppliersQ.data]);
  const purchaserOpts = useMemo(() => toOptions(purchasersQ.data), [toOptions, purchasersQ.data]);
  const projectOpts = useMemo(() => toOptions(projectsQ.data), [toOptions, projectsQ.data]);
  const stockOpts = useMemo(() => toOptions(stocksQ.data), [toOptions, stocksQ.data]);
  const taxCodeOpts = useMemo(() => toOptions(taxCodesQ.data, true), [toOptions, taxCodesQ.data]);

  const mutation = useMutation({
    mutationFn: fetchReport,
    retry: false,
  });

  const runInquiry = useCallback(() => {
    setInquiry((s) => ({ ...s, ran: true, drillCode: null, drillPage: 1 }));
    mutation.mutate(inquiry.filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inquiry.filter]);

  const clearAll = useCallback(() => {
    const d = defaultInquiry();
    setInquiry(d);
    mutation.reset();
  }, [mutation]);

  const report = mutation.data ?? null;
  const err = mutation.error as
    | (Error & { kind?: string; matchedInvoiceCount?: number; failedInvoiceCount?: number })
    | null;

  const sortedGroups = useMemo(() => {
    if (!report) return [];
    const gs = [...report.groups];
    const key = inquiry.sortKey;
    const dir = inquiry.sortDir === "asc" ? 1 : -1;
    gs.sort((a, b) => {
      const av =
        key === "code" ? a.glAccountCode : (a[keyMap(key)] as number);
      const bv =
        key === "code" ? b.glAccountCode : (b[keyMap(key)] as number);
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return (av - bv) * dir;
    });
    return gs;
  }, [report, inquiry.sortKey, inquiry.sortDir]);

  const drill = useMemo(() => {
    if (!report || !inquiry.drillCode) return null;
    const group = report.groups.find((g) => g.glAccountCode === inquiry.drillCode);
    if (!group) return null;
    const lines = report.lines
      .filter((l) => l.glAccountCode === inquiry.drillCode)
      .sort(
        (a, b) =>
          b.docDate.localeCompare(a.docDate) ||
          a.docCode.localeCompare(b.docCode) ||
          a.pos - b.pos,
      );
    return { group, lines };
  }, [report, inquiry.drillCode]);

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">GL Analysis</h1>
            <p className="text-sm text-muted-foreground">
              Purchase Audit Trail grouped by GL Account. Live from N3 · MYR.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/reports/purchasebook-probe" className="app-btn">
              PurchaseBook Probe
            </Link>
            <div className="text-xs text-muted-foreground">
              Cancelled/voided Purchase Invoices are excluded.
            </div>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            runInquiry();
          }}
          className="app-card space-y-3 p-3"
        >
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
            <Field label="Period">
              <select
                className="app-input h-8 text-[13px]"
                value={inquiry.preset}
                onChange={(e) => setPreset(e.target.value as Preset)}
              >
                <option value="this-month">This Month</option>
                <option value="prev-month">Previous Month</option>
                <option value="this-year">This Year</option>
                <option value="custom">Custom</option>
              </select>
            </Field>
            <Field label="Date from">
              <input
                type="date"
                className="app-input h-8 text-[13px]"
                value={inquiry.filter.dateFrom}
                onChange={(e) => {
                  setFilter({ dateFrom: e.target.value });
                  setInquiry((s) => ({ ...s, preset: "custom" }));
                }}
              />
            </Field>
            <Field label="Date to">
              <input
                type="date"
                className="app-input h-8 text-[13px]"
                value={inquiry.filter.dateTo}
                onChange={(e) => {
                  setFilter({ dateTo: e.target.value });
                  setInquiry((s) => ({ ...s, preset: "custom" }));
                }}
              />
            </Field>
            <Field label="Financial Period">
              <div className="app-input flex h-8 items-center px-2 text-[12px] text-muted-foreground">
                Not documented in N3 API
              </div>
            </Field>
            <Field label="HQ Sequence contains">
              <input
                className="app-input h-8 text-[13px]"
                value={inquiry.filter.hqSequence ?? ""}
                onChange={(e) => setFilter({ hqSequence: e.target.value || undefined })}
              />
            </Field>
            <Field label="Supplier">
              <SearchableSelect
                options={supplierOpts}
                value={inquiry.filter.supplierId ? String(inquiry.filter.supplierId) : null}
                selectedLabel={inquiry.supplierLabel ?? null}
                loading={suppliersQ.isLoading}
                placeholder="All suppliers"
                onChange={(opt) => {
                  setFilter({ supplierId: opt ? Number(opt.value) : undefined });
                  setInquiry((s) => ({ ...s, supplierLabel: opt?.label }));
                }}
              />
            </Field>
            <Field label="Payment Type / Purchaser">
              <SearchableSelect
                options={purchaserOpts}
                value={inquiry.filter.purchaserId ? String(inquiry.filter.purchaserId) : null}
                selectedLabel={inquiry.purchaserLabel ?? null}
                loading={purchasersQ.isLoading}
                placeholder="All purchasers"
                onChange={(opt) => {
                  setFilter({ purchaserId: opt ? Number(opt.value) : undefined });
                  setInquiry((s) => ({ ...s, purchaserLabel: opt?.label }));
                }}
              />
            </Field>
            <Field label="Cost Centre / Project">
              <SearchableSelect
                options={projectOpts}
                value={inquiry.filter.projectId ? String(inquiry.filter.projectId) : null}
                selectedLabel={inquiry.projectLabel ?? null}
                loading={projectsQ.isLoading}
                placeholder="All projects"
                onChange={(opt) => {
                  setFilter({ projectId: opt ? Number(opt.value) : undefined });
                  setInquiry((s) => ({ ...s, projectLabel: opt?.label }));
                }}
              />
            </Field>
            <Field label="WBS / Stock">
              <SearchableSelect
                options={stockOpts}
                value={inquiry.filter.stockId ? String(inquiry.filter.stockId) : null}
                selectedLabel={inquiry.stockLabel ?? null}
                loading={stocksQ.isLoading}
                placeholder="All stocks"
                onChange={(opt) => {
                  setFilter({ stockId: opt ? Number(opt.value) : undefined });
                  setInquiry((s) => ({ ...s, stockLabel: opt?.label }));
                }}
              />
            </Field>
            <Field label="HQ Tax / Input Tax">
              <SearchableSelect
                options={taxCodeOpts}
                value={inquiry.filter.taxCodeId ? String(inquiry.filter.taxCodeId) : null}
                selectedLabel={inquiry.taxCodeLabel ?? null}
                loading={taxCodesQ.isLoading}
                placeholder="All tax codes"
                onChange={(opt) => {
                  setFilter({ taxCodeId: opt ? Number(opt.value) : undefined });
                  setInquiry((s) => ({ ...s, taxCodeLabel: opt?.label }));
                }}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="app-btn app-btn-primary"
              disabled={mutation.isPending || !hydrated || !token}
            >
              {mutation.isPending ? "Running…" : inquiry.ran ? "Re-run inquiry" : "Inquiry"}
            </button>
            <button type="button" className="app-btn" onClick={clearAll}>
              Clear
            </button>
            <span className="text-xs text-muted-foreground">
              Dates {isoToMy(inquiry.filter.dateFrom)} → {isoToMy(inquiry.filter.dateTo)}
            </span>
          </div>
        </form>

        {!hydrated || !token ? (
          <div className="app-card p-6 text-sm text-muted-foreground">
            Sign in to N3 to run GL Analysis.
          </div>
        ) : !inquiry.ran && !mutation.isPending ? (
          <div className="app-card p-6 text-sm text-muted-foreground">
            Select a reporting period or date range, then click Inquiry.
          </div>
        ) : mutation.isPending ? (
          <div className="app-card p-6 text-sm text-muted-foreground">
            <div>Loading invoice headers…</div>
            <div>Loading invoice details (bounded concurrency ≤ 3)…</div>
            <div>Aggregating GL totals…</div>
          </div>
        ) : err ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <div>
              <strong>
                {err.kind === "incomplete" ? "Incomplete report:" : "Inquiry failed:"}
              </strong>{" "}
              {err.message}
            </div>
            <button
              type="button"
              className="app-btn mt-2"
              onClick={runInquiry}
              disabled={mutation.isPending}
            >
              Retry inquiry
            </button>
          </div>
        ) : report ? (
          <>
            <SummaryCards report={report} />
            <GLTable
              groups={sortedGroups}
              sortKey={inquiry.sortKey}
              sortDir={inquiry.sortDir}
              onSort={(k) =>
                setInquiry((s) => ({
                  ...s,
                  sortKey: k,
                  sortDir:
                    s.sortKey === k ? (s.sortDir === "asc" ? "desc" : "asc") : "desc",
                }))
              }
              drillCode={inquiry.drillCode}
              onDrill={(code) =>
                setInquiry((s) => ({
                  ...s,
                  drillCode: s.drillCode === code ? null : code,
                  drillPage: 1,
                }))
              }
            />
            {drill && (
              <DrillDown
                group={drill.group}
                lines={drill.lines}
                page={inquiry.drillPage}
                pageSize={inquiry.drillPageSize}
                onPage={(p) => setInquiry((s) => ({ ...s, drillPage: p }))}
                onPageSize={(z) =>
                  setInquiry((s) => ({ ...s, drillPageSize: z, drillPage: 1 }))
                }
              />
            )}
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

function keyMap(k: SortKey): keyof GLAccountSummary {
  if (k === "code") return "glAccountCode";
  if (k === "invoiceCount") return "invoiceCount";
  return k;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SummaryCards({ report }: { report: ReportData }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Card label="GL Accounts" value={String(report.summary.glAccountsCount)} />
      <Card label="Amount Before Tax (MYR)" value={fmt(report.summary.beforeTax)} />
      <Card label="Total Tax (MYR)" value={fmt(report.summary.taxAmount)} />
      <Card label="Amount Including Tax (MYR)" value={fmt(report.summary.includingTax)} />
      <div className="col-span-full text-[11px] text-muted-foreground">
        {report.fetchedInvoiceCount} Purchase Invoice{report.fetchedInvoiceCount === 1 ? "" : "s"}{" "}
        · {report.summary.lineCount} line{report.summary.lineCount === 1 ? "" : "s"} included.
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="app-card p-3">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="tabular text-lg font-semibold">{value}</div>
    </div>
  );
}

function GLTable({
  groups,
  sortKey,
  sortDir,
  onSort,
  drillCode,
  onDrill,
}: {
  groups: GLAccountSummary[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  drillCode: string | null;
  onDrill: (code: string) => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="app-card p-6 text-sm text-muted-foreground">
        No Purchase Invoice lines matched this inquiry.
      </div>
    );
  }
  const arrow = (k: SortKey) => (sortKey === k ? (sortDir === "asc" ? " ▲" : " ▼") : "");
  return (
    <div className="app-card overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="bg-surface-2 text-[11px] uppercase text-muted-foreground">
          <tr>
            <Th onClick={() => onSort("code")}>GL Account Code{arrow("code")}</Th>
            <Th>GL Account Name</Th>
            <Th className="text-right" onClick={() => onSort("invoiceCount")}>
              Invoices{arrow("invoiceCount")}
            </Th>
            <Th className="text-right">Lines</Th>
            <Th className="text-right" onClick={() => onSort("beforeTax")}>
              Before Tax{arrow("beforeTax")}
            </Th>
            <Th className="text-right" onClick={() => onSort("taxAmount")}>
              Tax{arrow("taxAmount")}
            </Th>
            <Th className="text-right" onClick={() => onSort("includingTax")}>
              Including Tax{arrow("includingTax")}
            </Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr
              key={g.glAccountCode}
              className={`border-t border-border/60 ${
                drillCode === g.glAccountCode ? "bg-primary/5" : ""
              }`}
            >
              <Td className="font-medium">{g.glAccountCode}</Td>
              <Td>{g.glAccountName}</Td>
              <Td className="tabular text-right">{g.invoiceCount}</Td>
              <Td className="tabular text-right">{g.lineCount}</Td>
              <Td className="tabular text-right">{fmt(g.beforeTax)}</Td>
              <Td className="tabular text-right">{fmt(g.taxAmount)}</Td>
              <Td className="tabular text-right">{fmt(g.includingTax)}</Td>
              <Td>
                <button
                  type="button"
                  className="app-btn"
                  onClick={() => onDrill(g.glAccountCode)}
                >
                  {drillCode === g.glAccountCode ? "Hide" : "Drill"}
                </button>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DrillDown({
  group,
  lines,
  page,
  pageSize,
  onPage,
  onPageSize,
}: {
  group: GLAccountSummary;
  lines: ReportData["lines"];
  page: number;
  pageSize: 20 | 50 | 100;
  onPage: (p: number) => void;
  onPageSize: (z: 20 | 50 | 100) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(lines.length / pageSize));
  const clamped = Math.min(page, totalPages);
  const start = (clamped - 1) * pageSize;
  const rows = lines.slice(start, start + pageSize);
  return (
    <div className="app-card space-y-3 p-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">
            {group.glAccountCode} — {group.glAccountName || "(No name)"}
          </h2>
          <div className="text-xs text-muted-foreground">
            {group.invoiceCount} invoices · {group.lineCount} lines
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Rows / page</span>
          <select
            className="app-input h-7 text-[12px]"
            value={pageSize}
            onChange={(e) => onPageSize(Number(e.target.value) as 20 | 50 | 100)}
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1500px] text-left text-sm">
          <thead className="bg-surface-2 text-[11px] uppercase text-muted-foreground">
            <tr>
              <Th>Date</Th>
              <Th>PI No.</Th>
              <Th>Supplier</Th>
              <Th>Supplier INV#</Th>
              <Th>HQ Sequence</Th>
              <Th>Payment Type</Th>
              <Th>Cost Centre</Th>
              <Th>WBS</Th>
              <Th>Item Description</Th>
              <Th>HQ Tax</Th>
              <Th className="text-right">Qty</Th>
              <Th className="text-right">Unit Price</Th>
              <Th className="text-right">Before Tax</Th>
              <Th className="text-right">Tax</Th>
              <Th className="text-right">Including Tax</Th>
              <Th>Ref No.</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={`${l.invoiceId}:${l.pos}`} className="border-t border-border/60">
                <Td>{isoToMy(l.docDate)}</Td>
                <Td>
                  <Link
                    to="/purchase-invoices/$id/edit"
                    params={{ id: l.invoiceId }}
                    className="text-primary underline"
                  >
                    {l.docCode}
                  </Link>
                </Td>
                <Td>
                  <div className="tabular text-[12px] text-muted-foreground">
                    {l.supplierCode}
                  </div>
                  <div>{l.supplierName}</div>
                </Td>
                <Td>{l.supplierInvNo}</Td>
                <Td className="max-w-[180px] truncate" title={l.hqSequence}>
                  {l.hqSequence}
                </Td>
                <Td>{l.paymentType}</Td>
                <Td>{l.projectCode}</Td>
                <Td>{l.stockCode}</Td>
                <Td className="max-w-[240px] truncate" title={l.itemDescription}>
                  {l.itemDescription}
                </Td>
                <Td>{l.taxCodeCode}</Td>
                <Td className="tabular text-right">{fmt(l.qty)}</Td>
                <Td className="tabular text-right">{fmt(l.unitPrice)}</Td>
                <Td className="tabular text-right">{fmt(l.beforeTax)}</Td>
                <Td className="tabular text-right">{fmt(l.taxAmount)}</Td>
                <Td className="tabular text-right">{fmt(l.includingTax)}</Td>
                <Td>{l.referenceNo}</Td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-surface-2 text-[12px]">
            <tr>
              <Td colSpan={12} className="text-right font-semibold">
                Totals
              </Td>
              <Td className="tabular text-right font-semibold">{fmt(group.beforeTax)}</Td>
              <Td className="tabular text-right font-semibold">{fmt(group.taxAmount)}</Td>
              <Td className="tabular text-right font-semibold">{fmt(group.includingTax)}</Td>
              <Td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Page {clamped} of {totalPages} · {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="app-btn"
            onClick={() => onPage(Math.max(1, clamped - 1))}
            disabled={clamped <= 1}
          >
            Previous
          </button>
          <button
            type="button"
            className="app-btn"
            onClick={() => onPage(Math.min(totalPages, clamped + 1))}
            disabled={clamped >= totalPages}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function Th({
  children,
  className,
  onClick,
}: {
  children?: React.ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <th
      className={`px-3 py-2 font-semibold ${onClick ? "cursor-pointer select-none" : ""} ${
        className ?? ""
      }`}
      onClick={onClick}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
  colSpan,
  title,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
  title?: string;
}) {
  return (
    <td colSpan={colSpan} title={title} className={`px-3 py-2 align-top ${className ?? ""}`}>
      {children}
    </td>
  );
}
