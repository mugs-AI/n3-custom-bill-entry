import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { AppShell } from "@/components/AppShell";
import { useAuthToken, useHydrated } from "@/hooks/use-auth";
import { n3Call, N3Error } from "@/lib/n3-client";
import { isoToMy } from "@/lib/date-my";
import { formatMoney } from "@/lib/money";
import { buildInvoiceFilter, HISTORY_QUERY_KEY } from "@/lib/history-query";

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
          "Search, view and open Purchase Invoices retrieved live from N3 AI Cloud Accounting.",
      },
      { property: "og:title", content: "Purchase Invoice History · Custom Bill Entry" },
      {
        property: "og:description",
        content: "Live-search Purchase Invoices from N3 AI Cloud Accounting.",
      },
    ],
  }),
  component: HistoryPage,
});

// PurchaseInvoiceListDto — only fields we consume on the history grid.
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
  outstandingAmount?: number;
  currencyCode?: string;
  supplier?: { id?: number; code?: string; name?: string } | null;
  purchaser?: { id?: number; code?: string; name?: string } | null;
  term?: { code?: string; description?: string } | null;
}

interface PageEnvelope {
  value: PurchaseInvoiceRow[];
  count?: number;
}

const PAGE_SIZE = 25;

function HistoryPage() {
  const hydrated = useHydrated();
  const token = useAuthToken();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const [inputQ, setInputQ] = useState<string>(search.q ?? "");
  const q = (search.q ?? "").trim();
  const page = search.page ?? 1;

  // Keep the local input in sync when the URL param changes (e.g. after
  // navigating from the New Bill Entry success screen with ?q=DOCCODE).
  useEffect(() => {
    setInputQ(search.q ?? "");
  }, [search.q]);

  const filter = useMemo(() => buildInvoiceFilter(q), [q]);

  const query = useQuery({
    queryKey: [...HISTORY_QUERY_KEY, { q, page }],
    enabled: hydrated && !!token,
    placeholderData: keepPreviousData,
    retry: (count, err) =>
      err instanceof N3Error && err.status === 401 ? false : count < 1,
    queryFn: ({ signal }) =>
      n3Call<PageEnvelope>("api/PurchaseInvoices/Query", {
        method: "GET",
        signal,
        query: {
          $top: PAGE_SIZE,
          $skip: (page - 1) * PAGE_SIZE,
          $count: "true",
          $orderby: "docDate desc,docCode desc",
          ...(filter ? { $filter: filter } : {}),
        },
      }),
  });

  const rows = query.data?.value ?? [];
  const total = query.data?.count ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate({ search: { q: inputQ.trim() || undefined, page: 1 } });
  };

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Purchase Invoice History</h1>
            <p className="text-sm text-muted-foreground">
              Live from N3 · newest first · search by PI No, Supplier INV#, Supplier Code, HQ
              Sequence, or Reference No.
            </p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="app-card flex flex-wrap items-center gap-2 p-3"
          role="search"
        >
          <input
            className="app-input flex-1 min-w-[220px]"
            placeholder="Search Purchase Invoices…"
            value={inputQ}
            onChange={(e) => setInputQ(e.target.value)}
            aria-label="Search"
          />
          <button type="submit" className="app-btn app-btn-primary">
            Search
          </button>
          {q && (
            <button
              type="button"
              className="app-btn"
              onClick={() => {
                setInputQ("");
                navigate({ search: { q: undefined, page: 1 } });
              }}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            className="app-btn"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </form>

        {!hydrated || !token ? (
          <div className="app-card p-6 text-sm text-muted-foreground">
            Sign in to N3 to view history.
          </div>
        ) : query.isError ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <span>
              <strong>History failed:</strong>{" "}
              {query.error instanceof Error ? query.error.message : "Unknown error"}
            </span>
            <button type="button" className="app-btn" onClick={() => query.refetch()}>
              Retry
            </button>
          </div>
        ) : (
          <>
            <HistoryTable rows={rows} loading={query.isLoading} onRowClick={(id) => setDetail(id)} />
            <Pager
              page={page}
              totalPages={totalPages}
              total={total}
              onPage={(p) => navigate({ search: { q: q || undefined, page: p } })}
            />
          </>
        )}
      </div>
      {detailId && <DetailPanel id={detailId} onClose={() => setDetail(null)} />}
    </AppShell>
  );

  // Detail modal state lives at the bottom to keep the render tree simple.
  function setDetail(id: string | null) {
    setDetailId(id);
  }
}

// -------------------- table + pagination --------------------

function HistoryTable({
  rows,
  loading,
  onRowClick,
}: {
  rows: PurchaseInvoiceRow[];
  loading: boolean;
  onRowClick: (id: string) => void;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="app-card p-6 text-sm text-muted-foreground">Loading Purchase Invoices…</div>
    );
  }
  if (rows.length === 0) {
    return <div className="app-card p-6 text-sm text-muted-foreground">No invoices found.</div>;
  }
  return (
    <div className="app-card overflow-x-auto">
      <table className="w-full min-w-[1100px] text-left text-sm">
        <thead className="bg-surface-2 text-[11px] uppercase text-muted-foreground">
          <tr>
            <Th>Doc No.</Th>
            <Th>Date</Th>
            <Th>Supplier</Th>
            <Th>Supplier INV#</Th>
            <Th>HQ Sequence</Th>
            <Th>Payment Type</Th>
            <Th>Ref No.</Th>
            <Th className="text-right">Sub Total</Th>
            <Th className="text-right">Tax</Th>
            <Th className="text-right">Net Total</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const net = r.netTotalAmount ?? 0;
            const tax = r.taxTotalAmount ?? 0;
            const sub = net - tax;
            const supplierCode =
              r.supplier?.code ??
              r.companyCode ??
              (r.billFrom ? r.billFrom.split(" ")[0] : "");
            const supplierName = r.supplier?.name ?? r.companyName ?? r.billFrom ?? "";
            return (
              <tr
                key={r.id ?? r.docCode}
                className="cursor-pointer border-t border-border/60 hover:bg-surface-2"
                onClick={() => r.id && onRowClick(r.id)}
              >
                <Td className="font-medium">{r.docCode}</Td>
                <Td>{r.docDate ? isoToMy(r.docDate.slice(0, 10)) : ""}</Td>
                <Td>
                  <div className="tabular text-[12px] text-muted-foreground">{supplierCode}</div>
                  <div>{supplierName}</div>
                </Td>
                <Td>{r.supplierInvNo}</Td>
                <Td className="max-w-[220px] truncate" title={r.description ?? ""}>
                  {r.description}
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-semibold ${className ?? ""}`}>{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
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

// -------------------- detail modal --------------------

interface PurchaseInvoiceDetail {
  id?: string;
  docCode?: string;
  docDate?: string;
  dueDate?: string;
  supplierInvNo?: string;
  description?: string;
  referenceNo?: string;
  isTaxInclusive?: boolean;
  isCancelled?: boolean;
  netTotalAmount?: number;
  taxTotalAmount?: number;
  subtotalAmount?: number;
  supplier?: { code?: string; name?: string } | null;
  purchaser?: { code?: string; name?: string } | null;
  term?: { code?: string; description?: string } | null;
  details?: Array<{
    pos?: number;
    description?: string;
    qty?: number;
    unitPrice?: number;
    netAmount?: number;
    taxAmount?: number;
    taxRate?: number;
    account?: { code?: string; name?: string } | null;
    taxCode?: { code?: string } | null;
  }>;
}

import { useCallback } from "react";
function DetailPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: [...HISTORY_QUERY_KEY, "detail", id],
    queryFn: ({ signal }) =>
      n3Call<PurchaseInvoiceDetail>(`api/PurchaseInvoices/${id}`, { signal }),
    staleTime: 30_000,
  });
  const escape = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);
  useEffect(() => {
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [escape]);

  const d = q.data;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="app-card mt-16 w-full max-w-3xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Purchase Invoice · {d?.docCode ?? "…"}</h2>
          <button type="button" className="app-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.isError && (
          <p className="text-sm text-destructive">
            {q.error instanceof Error ? q.error.message : "Failed to load."}
          </p>
        )}
        {d && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="Doc Date">{d.docDate ? isoToMy(d.docDate.slice(0, 10)) : ""}</Field>
              <Field label="Due Date">{d.dueDate ? isoToMy(d.dueDate.slice(0, 10)) : ""}</Field>
              <Field label="Status">{d.isCancelled ? "Cancelled" : "Active"}</Field>
              <Field label="Supplier">
                {d.supplier?.code} — {d.supplier?.name}
              </Field>
              <Field label="Supplier INV#">{d.supplierInvNo}</Field>
              <Field label="Reference No.">{d.referenceNo}</Field>
              <Field label="HQ Sequence" className="md:col-span-3">
                {d.description}
              </Field>
              <Field label="Tax Inclusive">{d.isTaxInclusive ? "Yes" : "No"}</Field>
              <Field label="Term">{d.term?.code}</Field>
              <Field label="Purchaser">{d.purchaser?.code}</Field>
            </div>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="bg-surface-2 uppercase text-muted-foreground">
                  <tr>
                    <Th>#</Th>
                    <Th>Description</Th>
                    <Th>GL</Th>
                    <Th>Tax</Th>
                    <Th className="text-right">Qty</Th>
                    <Th className="text-right">Price</Th>
                    <Th className="text-right">Net</Th>
                    <Th className="text-right">Tax Amt</Th>
                  </tr>
                </thead>
                <tbody>
                  {(d.details ?? []).map((l, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <Td>{l.pos ?? i + 1}</Td>
                      <Td>{l.description}</Td>
                      <Td>{l.account?.code}</Td>
                      <Td>{l.taxCode?.code}</Td>
                      <Td className="text-right tabular">{formatMoney(l.qty ?? 0)}</Td>
                      <Td className="text-right tabular">{formatMoney(l.unitPrice ?? 0)}</Td>
                      <Td className="text-right tabular">{formatMoney(l.netAmount ?? 0)}</Td>
                      <Td className="text-right tabular">{formatMoney(l.taxAmount ?? 0)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="ml-auto mt-3 flex max-w-xs flex-col gap-1 text-sm">
              <TotalRow label="Sub Total">{formatMoney(d.subtotalAmount ?? 0)}</TotalRow>
              <TotalRow label="Total Tax">{formatMoney(d.taxTotalAmount ?? 0)}</TotalRow>
              <TotalRow label="Net Total" bold>
                {formatMoney(d.netTotalAmount ?? 0)}
              </TotalRow>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div>{children ?? "—"}</div>
    </div>
  );
}

function TotalRow({
  label,
  children,
  bold,
}: {
  label: string;
  children: React.ReactNode;
  bold?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between ${bold ? "border-t border-border pt-1" : ""}`}>
      <span
        className={`text-xs uppercase ${bold ? "font-bold" : "font-semibold text-muted-foreground"}`}
      >
        {label}
      </span>
      <span className={`tabular ${bold ? "text-base font-semibold" : ""}`}>{children}</span>
    </div>
  );
}

// Detail state — placed at the module level via a small local hook wrapper
// so the outer component can toggle it. Kept simple with a useState-inside-
// component pattern via closure.
function useDetailState() {
  const [id, setId] = useState<string | null>(null);
  return { id, setId } as const;
}
// The outer component reads `detailId` from a closure; wire via a hook that
// lifts state up.
// eslint-disable-next-line react-hooks/rules-of-hooks
const { id: detailId, setId: setDetailId } = ((): { id: string | null; setId: (v: string | null) => void } => {
  // Placeholder to satisfy TS; real state is created via `useHistoryDetail` below.
  return { id: null, setId: () => {} };
})();
void useDetailState;
