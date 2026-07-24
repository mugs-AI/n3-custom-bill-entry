import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { AppShell } from "@/components/AppShell";
import { useAuthToken, useHydrated } from "@/hooks/use-auth";
import { n3Call, N3Error } from "@/lib/n3-client";
import { isoToMy, todayISOInKL } from "@/lib/date-my";
import { formatMoney } from "@/lib/money";
import {
  buildHistoryFilter,
  HISTORY_QUERY_KEY,
  isEmptyFilter,
  type HistoryFilter,
} from "@/lib/history-query";
import { getAuthScope } from "@/lib/draft-store";

// Purchase Invoice History — Correction C.
//
// Behavioural changes vs the previous version:
//   1. Inquiry-driven. The N3 Query is NEVER auto-executed. Users pick a date
//      range and any column filters, then press "Run inquiry" (or Enter in a
//      filter field). This is enforced because the tenant may hold tens of
//      thousands of invoices; an unscoped default load would time out.
//   2. Structured filters only. Free-text search is scoped to specific
//      documented DTO fields via buildHistoryFilter (see history-query.ts).
//   3. Row click navigates to /purchase-invoices/:id/edit rather than opening
//      a read-only modal.
//   4. State persists per tenant/user in sessionStorage so Back-from-Edit
//      restores the inquiry the user was reviewing, without re-fetching until
//      they explicitly re-inquire.

const searchSchema = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
});

export const Route = createFileRoute("/history")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      { title: "Purchase Invoice History · Custom Bill Entry" },
      {
        name: "description",
        content:
          "Structured inquiry for Purchase Invoices in N3 AI Cloud Accounting — date range plus column filters.",
      },
      { property: "og:title", content: "Purchase Invoice History · Custom Bill Entry" },
      {
        property: "og:description",
        content: "Structured inquiry for Purchase Invoices in N3 AI Cloud Accounting.",
      },
    ],
  }),
  component: HistoryPage,
});

interface PurchaseInvoiceRow {
  id?: string;
  docCode?: string;
  docDate?: string;
  supplierInvNo?: string;
  description?: string;
  referenceNo?: string;
  billFrom?: string;
  companyCode?: string;
  companyName?: string;
  isCancelled?: boolean;
  netTotalAmount?: number;
  taxTotalAmount?: number;
  supplier?: { code?: string; name?: string } | null;
  purchaser?: { code?: string; name?: string } | null;
  term?: { code?: string; description?: string } | null;
}

interface PageEnvelope {
  value: PurchaseInvoiceRow[];
  count?: number;
}

const PAGE_SIZE = 25;
const INQUIRY_EVENT = "custom-bill-entry:history-inquiry-change";

interface InquiryState {
  filter: HistoryFilter;
  page: number;
  ran: boolean;
}

function defaultInquiry(): InquiryState {
  const today = todayISOInKL();
  const d = new Date(today);
  d.setDate(d.getDate() - 30);
  const from = d.toISOString().slice(0, 10);
  return {
    filter: { dateFrom: from, dateTo: today, status: "active" },
    page: 1,
    ran: false,
  };
}

function inquiryStorageKey(): string {
  const s = getAuthScope();
  return `custom-bill-entry:history-inquiry:${s.tenantId}:${s.userId}`;
}

function loadInquiry(): InquiryState {
  if (typeof window === "undefined") return defaultInquiry();
  try {
    const raw = window.sessionStorage.getItem(inquiryStorageKey());
    if (!raw) return defaultInquiry();
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.filter) {
      return { ...defaultInquiry(), ...parsed };
    }
  } catch {
    /* ignore */
  }
  return defaultInquiry();
}

function saveInquiry(s: InquiryState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(inquiryStorageKey(), JSON.stringify(s));
    window.dispatchEvent(new Event(INQUIRY_EVENT));
  } catch {
    /* ignore */
  }
}

function HistoryPage() {
  const hydrated = useHydrated();
  const token = useAuthToken();

  const [inquiry, setInquiry] = useState<InquiryState>(defaultInquiry);
  // Live restore *after* hydration so SSR + first client render agree.
  useEffect(() => {
    setInquiry(loadInquiry());
  }, []);
  useEffect(() => {
    saveInquiry(inquiry);
  }, [inquiry]);

  const filter = inquiry.filter;
  const filterString = useMemo(() => buildHistoryFilter(filter), [filter]);
  const empty = filterString === null;

  const query = useQuery({
    queryKey: [...HISTORY_QUERY_KEY, "list", filterString, inquiry.page],
    // Never auto-run. Only fire after the user has explicitly clicked Inquiry.
    enabled: hydrated && !!token && inquiry.ran,
    placeholderData: keepPreviousData,
    retry: (count, err) => (err instanceof N3Error && err.status === 401 ? false : count < 1),
    queryFn: ({ signal }) =>
      n3Call<PageEnvelope>("api/PurchaseInvoices/Query", {
        method: "GET",
        signal,
        query: {
          $top: PAGE_SIZE,
          $skip: (inquiry.page - 1) * PAGE_SIZE,
          $count: "true",
          $orderby: "docDate desc,docCode desc",
          ...(filterString ? { $filter: filterString } : {}),
        },
      }),
  });

  const rows = query.data?.value ?? [];
  const total = query.data?.count ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const runInquiry = useCallback(() => {
    setInquiry((s) => ({ ...s, ran: true, page: 1 }));
  }, []);

  const updateFilter = useCallback((patch: Partial<HistoryFilter>) => {
    setInquiry((s) => ({ ...s, filter: { ...s.filter, ...patch } }));
  }, []);

  const clearAll = useCallback(() => {
    setInquiry({ filter: {}, page: 1, ran: false });
  }, []);

  const gotoPage = useCallback((p: number) => {
    setInquiry((s) => ({ ...s, page: p }));
  }, []);

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Purchase Invoice History</h1>
            <p className="text-sm text-muted-foreground">
              Choose a date range, add column filters, then press <strong>Run inquiry</strong>.
              Nothing loads automatically.
            </p>
          </div>
          <Link to="/" className="app-btn">
            + New Bill Entry
          </Link>
        </div>

        <InquiryPanel
          filter={filter}
          onChange={updateFilter}
          onRun={runInquiry}
          onClear={clearAll}
          busy={query.isFetching}
          ran={inquiry.ran}
          empty={empty}
        />

        {!hydrated || !token ? (
          <div className="app-card p-6 text-sm text-muted-foreground">
            Sign in to N3 to run inquiries.
          </div>
        ) : !inquiry.ran ? (
          <div className="app-card p-6 text-sm text-muted-foreground">
            No results yet. Enter your filter above and press <strong>Run inquiry</strong>.
          </div>
        ) : query.isError ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <span>
              <strong>Inquiry failed:</strong>{" "}
              {query.error instanceof Error ? query.error.message : "Unknown error"}
            </span>
            <button type="button" className="app-btn" onClick={() => query.refetch()}>
              Retry
            </button>
          </div>
        ) : (
          <>
            <HistoryTable rows={rows} loading={query.isLoading} />
            <Pager
              page={inquiry.page}
              totalPages={totalPages}
              total={total}
              onPage={gotoPage}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}

function InquiryPanel({
  filter,
  onChange,
  onRun,
  onClear,
  busy,
  ran,
  empty,
}: {
  filter: HistoryFilter;
  onChange: (patch: Partial<HistoryFilter>) => void;
  onRun: () => void;
  onClear: () => void;
  busy: boolean;
  ran: boolean;
  empty: boolean;
}) {
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onRun();
  };
  return (
    <form onSubmit={submit} className="app-card space-y-3 p-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Field label="Date from">
          <input
            type="date"
            className="app-input h-8 text-[13px]"
            value={filter.dateFrom ?? ""}
            onChange={(e) => onChange({ dateFrom: e.target.value || undefined })}
          />
        </Field>
        <Field label="Date to">
          <input
            type="date"
            className="app-input h-8 text-[13px]"
            value={filter.dateTo ?? ""}
            onChange={(e) => onChange({ dateTo: e.target.value || undefined })}
          />
        </Field>
        <Field label="Status">
          <select
            className="app-input h-8 text-[13px]"
            value={filter.status ?? "active"}
            onChange={(e) => onChange({ status: e.target.value as HistoryFilter["status"] })}
          >
            <option value="active">Active</option>
            <option value="cancelled">Cancelled</option>
            <option value="all">All</option>
          </select>
        </Field>
        <Field label="PI No. contains">
          <input
            className="app-input h-8 text-[13px]"
            value={filter.docCode ?? ""}
            onChange={(e) => onChange({ docCode: e.target.value || undefined })}
            placeholder="e.g. PI-0001"
          />
        </Field>
        <Field label="Supplier INV# contains">
          <input
            className="app-input h-8 text-[13px]"
            value={filter.supplierInvNo ?? ""}
            onChange={(e) => onChange({ supplierInvNo: e.target.value || undefined })}
          />
        </Field>
        <Field label="HQ Sequence contains">
          <input
            className="app-input h-8 text-[13px]"
            value={filter.description ?? ""}
            onChange={(e) => onChange({ description: e.target.value || undefined })}
          />
        </Field>
        <Field label="Reference No. contains">
          <input
            className="app-input h-8 text-[13px]"
            value={filter.referenceNo ?? ""}
            onChange={(e) => onChange({ referenceNo: e.target.value || undefined })}
          />
        </Field>
        <Field label="Supplier ID">
          <input
            type="number"
            inputMode="numeric"
            className="app-input h-8 text-[13px] tabular"
            value={filter.supplierId ?? ""}
            onChange={(e) =>
              onChange({
                supplierId: e.target.value ? Number(e.target.value) : undefined,
              })
            }
          />
        </Field>
        <Field label="Purchaser ID">
          <input
            type="number"
            inputMode="numeric"
            className="app-input h-8 text-[13px] tabular"
            value={filter.purchaserId ?? ""}
            onChange={(e) =>
              onChange({
                purchaserId: e.target.value ? Number(e.target.value) : undefined,
              })
            }
          />
        </Field>
        <Field label="Net min">
          <input
            type="number"
            inputMode="decimal"
            className="app-input h-8 text-[13px] tabular"
            value={filter.netMin ?? ""}
            onChange={(e) =>
              onChange({ netMin: e.target.value ? Number(e.target.value) : undefined })
            }
          />
        </Field>
        <Field label="Net max">
          <input
            type="number"
            inputMode="decimal"
            className="app-input h-8 text-[13px] tabular"
            value={filter.netMax ?? ""}
            onChange={(e) =>
              onChange({ netMax: e.target.value ? Number(e.target.value) : undefined })
            }
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="app-btn app-btn-primary" disabled={busy}>
          {busy ? "Running…" : ran ? "Re-run inquiry" : "Run inquiry"}
        </button>
        <button type="button" className="app-btn" onClick={onClear}>
          Clear filters
        </button>
        {empty && (
          <span className="text-xs text-muted-foreground">
            Tip: at least one filter is required so the inquiry stays scoped.
          </span>
        )}
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function HistoryTable({ rows, loading }: { rows: PurchaseInvoiceRow[]; loading: boolean }) {
  if (loading && rows.length === 0) {
    return (
      <div className="app-card p-6 text-sm text-muted-foreground">Loading Purchase Invoices…</div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="app-card p-6 text-sm text-muted-foreground">
        No invoices matched this inquiry.
      </div>
    );
  }
  return (
    <div className="app-card overflow-x-auto">
      <table className="w-full min-w-[1100px] text-left text-sm">
        <thead className="bg-surface-2 text-[11px] uppercase text-muted-foreground">
          <tr>
            <Th>PI No.</Th>
            <Th>Date</Th>
            <Th>Supplier</Th>
            <Th>Supplier INV#</Th>
            <Th>HQ Sequence</Th>
            <Th>Purchaser</Th>
            <Th>Ref No.</Th>
            <Th className="text-right">Sub Total</Th>
            <Th className="text-right">Tax</Th>
            <Th className="text-right">Net Total</Th>
            <Th>Status</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const net = r.netTotalAmount ?? 0;
            const tax = r.taxTotalAmount ?? 0;
            const sub = net - tax;
            const supplierCode =
              r.supplier?.code ?? r.companyCode ?? (r.billFrom ? r.billFrom.split(" ")[0] : "");
            const supplierName = r.supplier?.name ?? r.companyName ?? r.billFrom ?? "";
            const desc = r.description ?? "";
            return (
              <tr key={r.id ?? r.docCode} className="border-t border-border/60 hover:bg-surface-2">
                <Td className="font-medium">
                  {r.id ? (
                    <Link
                      to="/purchase-invoices/$id/edit"
                      params={{ id: r.id }}
                      className="text-primary underline"
                    >
                      {r.docCode}
                    </Link>
                  ) : (
                    r.docCode
                  )}
                </Td>
                <Td>{r.docDate ? isoToMy(r.docDate.slice(0, 10)) : ""}</Td>
                <Td>
                  <div className="tabular text-[12px] text-muted-foreground">{supplierCode}</div>
                  <div>{supplierName}</div>
                </Td>
                <Td>{r.supplierInvNo}</Td>
                <Td className="max-w-[220px] truncate">
                  <span title={desc}>{desc}</span>
                </Td>
                <Td>
                  {r.purchaser?.code ?? ""}
                  {r.purchaser?.name ? ` — ${r.purchaser.name}` : ""}
                </Td>
                <Td>{r.referenceNo}</Td>
                <Td className="tabular text-right">{formatMoney(sub)}</Td>
                <Td className="tabular text-right">{formatMoney(tax)}</Td>
                <Td className="tabular text-right">{formatMoney(net)}</Td>
                <Td>
                  {r.isCancelled ? (
                    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                      Cancelled
                    </span>
                  ) : (
                    <span className="rounded bg-success/10 px-1.5 py-0.5 text-[11px] font-medium text-success">
                      Active
                    </span>
                  )}
                </Td>
                <Td>
                  {r.id && (
                    <Link
                      to="/purchase-invoices/$id/edit"
                      params={{ id: r.id }}
                      className="app-btn"
                    >
                      Edit
                    </Link>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-semibold ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top ${className ?? ""}`}>{children}</td>;
}

function Pager({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>
        Page {page} of {totalPages} · {total} invoice{total === 1 ? "" : "s"}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="app-btn"
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page <= 1}
        >
          Previous
        </button>
        <button
          type="button"
          className="app-btn"
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
        >
          Next
        </button>
      </div>
    </div>
  );
}
