import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { SearchableSelect, type ComboOption } from "@/components/SearchableSelect";
import { MyDateInput } from "@/components/MyDateInput";
import { setToken } from "@/lib/auth-store";
import { useAuthToken, useHydrated } from "@/hooks/use-auth";
import { n3Call, n3ListAll, N3Error } from "@/lib/n3-client";
import { todayISOInKL } from "@/lib/date-my";
import { formatMoney, multiplyDecimal, sumTo2dp } from "@/lib/money";
import { useItemLayout } from "@/hooks/use-item-layout";
import {
  FIELD_LABELS,
  READONLY_FIELDS,
  type FieldId,
  type ItemLayout,
} from "@/lib/item-layout";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "New Bill Entry · Custom Bill Entry" },
      {
        name: "description",
        content:
          "Keyboard-first Purchase Invoice entry for N3 AI Cloud Accounting. Live master data, single-screen entry.",
      },
      { property: "og:title", content: "New Bill Entry · Custom Bill Entry" },
      {
        property: "og:description",
        content:
          "Keyboard-first Purchase Invoice entry for N3 AI Cloud Accounting. Live master data, single-screen entry.",
      },
    ],
  }),
  component: NewBillEntry,
});

// ==================== DTO shapes (verified vs live probing) ==============
// Suppliers:  GET  /api/Suppliers/List, GET /api/Suppliers/{id}
// Purchasers: GET  /api/Purchasers/Query
// Terms:      GET  /api/Terms/Query
// Stocks:     GET  /api/Stocks/List, GET /api/Stocks/{id}
// GL:         GET  /api/AccountCodes/Leaf/Query
// Projects:   GET  /api/Projects/Query   (bare /api/Projects is 405; /Query is OData)
// Tax:        GET  /api/TaxCodes/InputTax/Query
// Tariff:     GET  /api/TariffCodes/Query
//   Live tenants may legitimately have zero Tariff Codes configured — the
//   dropdown surfaces "No Tariff Codes are configured in N3" in that case
//   so users can distinguish empty master data from a request failure.

interface SupplierList {
  id: number;
  code?: string;
  name?: string;
  email?: string;
  emailList?: string[];
  phoneNo1?: string;
  phoneNo2?: string;
  contactPerson?: string;
  address1?: string;
  address2?: string;
  address3?: string;
  address4?: string;
  termCode?: string;
}
interface SupplierDetail extends SupplierList {
  eInvoiceEmail?: string;
  termId?: number;
  term?: { id?: number; code?: string; description?: string } | null;
}
interface Purchaser { id: number; code?: string; name?: string; isActive?: boolean }
interface Term { id: number; code?: string; description?: string }
interface StockListRow {
  id: number;
  code?: string;
  name?: string;
  description?: string;
  baseUOM?: string;
  isActive?: boolean;
}
interface AccountCode { id: number; code?: string; name?: string; isActive?: boolean }
interface Project { id: number; code?: string; name?: string; isActive?: boolean }
interface TaxCode {
  id: number;
  code?: string;
  rate?: number;
  fullName?: string;
  isActive?: boolean;
  inactive?: boolean;
}
interface TariffCode { id: number; code?: string; description?: string; isActive?: boolean }

interface DetailLine {
  key: string;
  stockId: number | null;
  stockCode: string;
  stockName: string;
  itemDescription: string;
  /** True after user edits Item Description; prevents WBS re-select overwriting. */
  itemDescriptionTouched: boolean;
  uomId: number | null;
  uomCode: string;
  uomError: string | null;
  glAccountId: number | null;
  glAccountCode: string;
  glAccountName: string;
  projectId: number | null;
  projectCode: string;
  projectName: string;
  taxCodeId: number | null;
  taxCodeCode: string;
  taxCodeName: string;
  tariffCodeId: number | null;
  tariffCodeCode: string;
  tariffCodeName: string;
  qty: string;
  unitPrice: string;
  refNo: string;
}

const emptyLine = (): DetailLine => ({
  key: crypto.randomUUID(),
  stockId: null,
  stockCode: "",
  stockName: "",
  itemDescription: "",
  itemDescriptionTouched: false,
  uomId: null,
  uomCode: "",
  uomError: null,
  glAccountId: null,
  glAccountCode: "",
  glAccountName: "",
  projectId: null,
  projectCode: "",
  projectName: "",
  taxCodeId: null,
  taxCodeCode: "",
  taxCodeName: "",
  tariffCodeId: null,
  tariffCodeCode: "",
  tariffCodeName: "",
  qty: "",
  unitPrice: "",
  refNo: "",
});

function NewBillEntry() {
  const hydrated = useHydrated();
  const token = useAuthToken();
  const [capturePhase, setCapturePhase] = useState<"pending" | "done">("pending");

  useEffect(() => {
    if (typeof window === "undefined") { setCapturePhase("done"); return; }
    try {
      const url = new URL(window.location.href);
      const t = url.searchParams.get("token");
      if (t) {
        setToken(t);
        url.searchParams.delete("token");
        window.history.replaceState({}, "", url.toString());
      }
    } catch { /* fail-safe */ }
    setCapturePhase("done");
  }, []);

  return (
    <AppShell>
      {!hydrated || capturePhase === "pending" ? (
        <BootShell />
      ) : !token ? (
        <NoAuthPanel />
      ) : (
        <BillForm />
      )}
    </AppShell>
  );
}

function BootShell() {
  return (
    <div className="app-card mx-auto max-w-lg p-6 text-sm text-muted-foreground">
      Loading N3 session…
    </div>
  );
}

function NoAuthPanel() {
  const [isDev, setIsDev] = useState(false);
  useEffect(() => setIsDev(import.meta.env.DEV), []);
  return (
    <div className="app-card mx-auto max-w-lg p-6">
      <h1 className="text-lg font-semibold">Not connected to N3</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        This app must be launched from <strong>N3 My Apps</strong> so the JWT
        arrives on the URL as <code>?token=…</code>. It is then stored in your
        browser and reused across reloads.
      </p>
      {isDev && (
        <p className="mt-3 text-sm text-muted-foreground">
          For local development, use the{" "}
          <a href="/dev-login" className="text-primary underline">dev connect</a>{" "}
          screen to exchange an API key.
        </p>
      )}
    </div>
  );
}

// ============================== The form ==============================

function BillForm() {
  const layout = useItemLayout();
  const [docDate, setDocDate] = useState(() => todayISOInKL());
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [purchaserId, setPurchaserId] = useState<number | null>(null);
  const [termId, setTermId] = useState<number | null>(null);
  const [termTouched, setTermTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [refNo, setRefNo] = useState("");
  const [supplierInvNo, setSupplierInvNo] = useState("");
  const [isTaxInclusive, setIsTaxInclusive] = useState(false);
  const [lines, setLines] = useState<DetailLine[]>(() => [emptyLine()]);

  const noRetryOn401 = useCallback(
    (count: number, err: unknown) =>
      err instanceof N3Error && err.status === 401 ? false : count < 1,
    [],
  );

  const suppliersQ = useQuery({
    queryKey: ["n3", "suppliers"],
    queryFn: ({ signal }) => n3ListAll<SupplierList>("api/Suppliers/List", { pageSize: 500, signal }),
    staleTime: 60_000, retry: noRetryOn401,
  });
  const purchasersQ = useQuery({
    queryKey: ["n3", "purchasers"],
    queryFn: ({ signal }) => n3ListAll<Purchaser>("api/Purchasers/Query", { pageSize: 500, signal }),
    staleTime: 60_000, retry: noRetryOn401,
  });
  const termsQ = useQuery({
    queryKey: ["n3", "terms"],
    queryFn: ({ signal }) => n3ListAll<Term>("api/Terms/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000, retry: noRetryOn401,
  });
  const stocksQ = useQuery({
    queryKey: ["n3", "stocks"],
    queryFn: ({ signal }) => n3ListAll<StockListRow>("api/Stocks/List", { pageSize: 500, signal }),
    staleTime: 5 * 60_000, retry: noRetryOn401,
  });
  const glAccountsQ = useQuery({
    queryKey: ["n3", "glAccounts"],
    queryFn: ({ signal }) => n3ListAll<AccountCode>("api/AccountCodes/Leaf/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000, retry: noRetryOn401,
  });
  // Bare /api/Projects returns 405. The OData query endpoint is /api/Projects/Query.
  const projectsQ = useQuery({
    queryKey: ["n3", "projects"],
    queryFn: ({ signal }) => n3ListAll<Project>("api/Projects/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000, retry: noRetryOn401,
  });
  const taxCodesQ = useQuery({
    queryKey: ["n3", "taxCodes"],
    queryFn: ({ signal }) => n3ListAll<TaxCode>("api/TaxCodes/InputTax/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000, retry: noRetryOn401,
  });
  const tariffCodesQ = useQuery({
    queryKey: ["n3", "tariffCodes"],
    queryFn: ({ signal }) => n3ListAll<TariffCode>("api/TariffCodes/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000, retry: noRetryOn401,
  });

  const supplierDetailQ = useQuery({
    queryKey: ["n3", "supplier", supplierId],
    queryFn: ({ signal }) => n3Call<SupplierDetail>(`api/Suppliers/${supplierId}`, { signal }),
    enabled: supplierId != null, staleTime: 30_000, retry: noRetryOn401,
  });

  useEffect(() => {
    if (termTouched) return;
    const detail = supplierDetailQ.data;
    if (!detail) return;
    setTermId(detail.termId ?? detail.term?.id ?? null);
  }, [supplierDetailQ.data, termTouched]);

  useEffect(() => {
    if (supplierId == null) { setTermId(null); setTermTouched(false); }
  }, [supplierId]);

  const collator = useMemo(
    () => new Intl.Collator(undefined, { sensitivity: "base", numeric: true }),
    [],
  );

  const dedupe = useCallback(<T extends { id: number }>(rows: T[]): T[] => {
    const seen = new Set<number>(); const out: T[] = [];
    for (const r of rows) {
      if (r?.id == null || seen.has(r.id)) continue;
      seen.add(r.id); out.push(r);
    }
    return out;
  }, []);

  const supplierOptions: ComboOption[] = useMemo(() => {
    const rows = dedupe(suppliersQ.data ?? []).slice();
    rows.sort((a, b) => {
      const an = (a.name ?? "").trim(), bn = (b.name ?? "").trim();
      if (!an && bn) return 1;
      if (an && !bn) return -1;
      const byName = collator.compare(an, bn);
      return byName !== 0 ? byName : collator.compare(a.code ?? "", b.code ?? "");
    });
    return rows.map((s) => ({
      value: String(s.id),
      label: `${s.code ?? ""} — ${s.name ?? ""}`.trim(),
      hint: s.termCode ?? undefined,
    }));
  }, [suppliersQ.data, collator, dedupe]);

  const purchaserOptions: ComboOption[] = useMemo(
    () => dedupe(purchasersQ.data ?? [])
      .filter((p) => p.isActive !== false)
      .map((p) => ({ value: String(p.id), label: `${p.code ?? ""} — ${p.name ?? ""}`.trim() })),
    [purchasersQ.data, dedupe],
  );

  const termOptions: ComboOption[] = useMemo(
    () => dedupe(termsQ.data ?? []).map((t) => ({
      value: String(t.id),
      label: `${t.code ?? ""} — ${t.description ?? ""}`.trim(),
    })),
    [termsQ.data, dedupe],
  );

  const sortByCode = useCallback(
    <T extends { code?: string }>(rows: T[]) => {
      const out = rows.slice();
      out.sort((a, b) => collator.compare(a.code ?? "", b.code ?? ""));
      return out;
    },
    [collator],
  );

  const stockOptions: ComboOption[] = useMemo(() => {
    const rows = sortByCode(dedupe(stocksQ.data ?? []).filter((r) => r.isActive !== false));
    return rows.map((r) => ({
      value: String(r.id),
      label: `${r.code ?? ""} — ${r.name ?? r.description ?? ""}`.trim(),
    }));
  }, [stocksQ.data, sortByCode, dedupe]);

  const glOptions: ComboOption[] = useMemo(() => {
    const rows = sortByCode(dedupe(glAccountsQ.data ?? []).filter((r) => r.isActive !== false));
    return rows.map((r) => ({ value: String(r.id), label: `${r.code ?? ""} — ${r.name ?? ""}`.trim() }));
  }, [glAccountsQ.data, sortByCode, dedupe]);

  const projectOptions: ComboOption[] = useMemo(() => {
    const rows = sortByCode(dedupe(projectsQ.data ?? []).filter((r) => r.isActive !== false));
    return rows.map((r) => ({ value: String(r.id), label: `${r.code ?? ""} — ${r.name ?? ""}`.trim() }));
  }, [projectsQ.data, sortByCode, dedupe]);

  const taxOptions: ComboOption[] = useMemo(() => {
    const rows = sortByCode(
      dedupe(taxCodesQ.data ?? []).filter((r) => r.isActive !== false && r.inactive !== true),
    );
    return rows.map((r) => ({ value: String(r.id), label: `${r.code ?? ""} — ${r.fullName ?? ""}`.trim() }));
  }, [taxCodesQ.data, sortByCode, dedupe]);

  const tariffOptions: ComboOption[] = useMemo(() => {
    const rows = sortByCode(dedupe(tariffCodesQ.data ?? []).filter((r) => r.isActive !== false));
    return rows.map((r) => ({ value: String(r.id), label: `${r.code ?? ""} — ${r.description ?? ""}`.trim() }));
  }, [tariffCodesQ.data, sortByCode, dedupe]);

  const listSupplier = useMemo<SupplierList | null>(() => {
    if (supplierId == null) return null;
    return (suppliersQ.data ?? []).find((s) => s.id === supplierId) ?? null;
  }, [suppliersQ.data, supplierId]);

  const detail: SupplierDetail | null =
    supplierDetailQ.data && supplierDetailQ.data.id === supplierId ? supplierDetailQ.data : null;
  const supplierView = detail ?? listSupplier;
  const addressLines = [supplierView?.address1, supplierView?.address2, supplierView?.address3, supplierView?.address4]
    .map((s) => (s ?? "").trim()).filter((s) => s.length > 0);
  const email = pickEmail(detail) || (listSupplier?.email ?? "");
  const phone = supplierView?.phoneNo1 ?? "";
  const contact = supplierView?.contactPerson ?? "";
  const supplierName = supplierView?.name ?? "";
  const supplierLabel = listSupplier ? `${listSupplier.code ?? ""} — ${listSupplier.name ?? ""}`.trim() : "";
  const enriching = supplierId != null && supplierDetailQ.isFetching;

  const lineNet = useCallback((l: DetailLine) => multiplyDecimal(l.qty, l.unitPrice), []);
  const totalNet = useMemo(() => sumTo2dp(lines.map(lineNet)), [lines, lineNet]);

  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
  const removeLine = (key: string) =>
    setLines((ls) => (ls.length <= 1 ? ls : ls.filter((l) => l.key !== key)));
  const updateLine = (key: string, patch: Partial<DetailLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const stockById = useMemo(() => {
    const m = new Map<number, StockListRow>();
    for (const r of stocksQ.data ?? []) m.set(r.id, r);
    return m;
  }, [stocksQ.data]);
  const glById = useMemo(() => {
    const m = new Map<number, AccountCode>();
    for (const r of glAccountsQ.data ?? []) m.set(r.id, r);
    return m;
  }, [glAccountsQ.data]);

  const handleStockSelect = (line: DetailLine, opt: ComboOption | null) => {
    if (!opt) {
      updateLine(line.key, {
        stockId: null, stockCode: "", stockName: "",
        itemDescription: "", itemDescriptionTouched: false,
        uomId: null, uomCode: "", uomError: null,
      });
      return;
    }
    const id = Number(opt.value);
    const row = stockById.get(id);
    updateLine(line.key, {
      stockId: id,
      stockCode: row?.code ?? "",
      stockName: row?.name ?? "",
      // Reset description to the newly selected Stock's default; clears any
      // previous manual edit because the WBS itself has changed.
      itemDescription: row?.name ?? row?.description ?? "",
      itemDescriptionTouched: false,
      uomId: null,
      uomCode: row?.baseUOM ?? "",
      uomError: null,
    });
  };

  const handleGlSelect = (line: DetailLine, opt: ComboOption | null) => {
    if (!opt) {
      updateLine(line.key, { glAccountId: null, glAccountCode: "", glAccountName: "" });
      return;
    }
    const id = Number(opt.value);
    const row = glById.get(id);
    updateLine(line.key, {
      glAccountId: id, glAccountCode: row?.code ?? "", glAccountName: row?.name ?? "",
    });
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const target = e.target as HTMLElement;
          if (target.tagName !== "TEXTAREA") e.preventDefault();
        }
      }}
    >
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">New Bill Entry</h1>
          <p className="text-sm text-muted-foreground">
            Simplified Purchase Invoice · posts directly to N3 · MYR
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="app-btn" onClick={() => window.location.reload()}>
            Reset
          </button>
          <button
            type="button"
            disabled
            title="Purchase Invoice POST arrives in Phase 2B"
            className="app-btn app-btn-primary cursor-not-allowed opacity-60"
          >
            Save to N3 · Available after Phase 2B
          </button>
        </div>
      </div>

      <ErrorBanner label="Suppliers" query={suppliersQ} />
      <ErrorBanner label="Purchasers" query={purchasersQ} />
      <ErrorBanner label="Terms" query={termsQ} />
      <ErrorBanner label="Supplier details" query={supplierDetailQ} />
      <ErrorBanner label="Stocks (WBS)" query={stocksQ} />
      <ErrorBanner label="GL Accounts" query={glAccountsQ} />
      <ErrorBanner label="Projects (Cost Centre)" query={projectsQ} />
      <ErrorBanner label="Tax Codes" query={taxCodesQ} />
      <ErrorBanner label="Tariff Codes" query={tariffCodesQ} />

      {/* ================================= Header ================================= */}
      <div className="app-card p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="app-label">Purchase Invoice No.</label>
            <input className="app-input bg-muted text-muted-foreground" readOnly value="Assigned on save" />
          </div>
          <div>
            <label className="app-label" htmlFor="doc-date">Document Date</label>
            <MyDateInput id="doc-date" value={docDate} onChange={setDocDate} ariaLabel="Document Date" required />
          </div>
          <div>
            <label className="app-label">Supplier</label>
            <SearchableSelect
              options={supplierOptions}
              value={supplierId != null ? String(supplierId) : null}
              selectedLabel={supplierLabel}
              onChange={(o) => setSupplierId(o ? Number(o.value) : null)}
              loading={suppliersQ.isLoading}
              placeholder={suppliersQ.isLoading ? "Loading suppliers…" : "Search by code or name"}
              ariaLabel="Supplier"
            />
            {enriching && (
              <p className="mt-1 text-[11px] text-muted-foreground" role="status">
                Loading full supplier details…
              </p>
            )}
          </div>

          <div className="md:col-span-2">
            <label className="app-label">Supplier Name</label>
            <input className="app-input" readOnly value={supplierName} />
          </div>
          <div>
            <label className="app-label">Payment Type (Purchaser)</label>
            <SearchableSelect
              options={purchaserOptions}
              value={purchaserId != null ? String(purchaserId) : null}
              onChange={(o) => setPurchaserId(o ? Number(o.value) : null)}
              loading={purchasersQ.isLoading}
              placeholder={purchasersQ.isLoading ? "Loading purchasers…" : "Blank — select if needed"}
              ariaLabel="Purchaser"
            />
          </div>

          <div className="md:col-span-2">
            <label className="app-label">Supplier Address</label>
            <div className="app-input min-h-[76px] whitespace-pre-line py-2" role="group" aria-label="Supplier Address">
              {addressLines.length ? addressLines.join("\n") : ""}
            </div>
          </div>
          <div>
            <label className="app-label">Supplier Contact</label>
            <input className="app-input" readOnly value={contact} />
          </div>

          <div>
            <label className="app-label">Supplier Phone</label>
            <input className="app-input" readOnly value={phone} />
          </div>
          <div>
            <label className="app-label">Supplier Email</label>
            <input className="app-input" readOnly value={email} />
          </div>
          <div>
            <label className="app-label">Term <span className="text-destructive">*</span></label>
            <SearchableSelect
              options={termOptions}
              value={termId != null ? String(termId) : null}
              onChange={(o) => { setTermTouched(true); setTermId(o ? Number(o.value) : null); }}
              loading={termsQ.isLoading}
              placeholder={termsQ.isLoading ? "Loading terms…" : supplierId ? "Default from supplier" : "Select a term"}
              ariaLabel="Term"
            />
          </div>

          <div>
            <label className="app-label">HQ Sequence</label>
            <input className="app-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Free text (→ Description)" />
          </div>
          <div>
            <label className="app-label">Reference No.</label>
            <input className="app-input" value={refNo} onChange={(e) => setRefNo(e.target.value)} />
          </div>
          <div>
            <label className="app-label">Supplier INV# <span className="text-destructive">*</span></label>
            <input required className="app-input" value={supplierInvNo} onChange={(e) => setSupplierInvNo(e.target.value)} placeholder="Duplicate check on save (Phase 2B)" />
          </div>

          <div className="md:col-span-3 mt-1 flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2">
            <label className="inline-flex cursor-pointer select-none items-center gap-2" htmlFor="tax-inclusive">
              <input
                id="tax-inclusive"
                type="checkbox"
                role="switch"
                aria-checked={isTaxInclusive}
                checked={isTaxInclusive}
                onChange={(e) => setIsTaxInclusive(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-primary)]"
              />
              <span className="text-sm font-medium">Tax Inclusive</span>
            </label>
            <span
              className={`text-xs font-semibold ${isTaxInclusive ? "text-primary" : "text-muted-foreground"}`}
              aria-hidden
            >
              {isTaxInclusive ? "ON" : "OFF"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              Defaults to OFF. Stored on the Purchase Invoice payload.
            </span>
          </div>
        </div>
      </div>

      <LineList
        lines={lines}
        layout={layout}
        onAdd={addLine}
        onRemove={removeLine}
        onChange={updateLine}
        totalNet={totalNet}
        lineNet={lineNet}
        stockOptions={stockOptions}
        stocksLoading={stocksQ.isLoading}
        glOptions={glOptions}
        glLoading={glAccountsQ.isLoading}
        projectOptions={projectOptions}
        projectsLoading={projectsQ.isLoading}
        taxOptions={taxOptions}
        taxLoading={taxCodesQ.isLoading}
        tariffOptions={tariffOptions}
        tariffLoading={tariffCodesQ.isLoading}
        tariffHasError={tariffCodesQ.isError}
        onStockSelect={handleStockSelect}
        onGlSelect={handleGlSelect}
      />
    </form>
  );
}

function pickEmail(detail: SupplierDetail | null): string {
  if (!detail) return "";
  const candidates: unknown[] = [
    detail.email, detail.eInvoiceEmail,
    ...(Array.isArray(detail.emailList) ? detail.emailList : []),
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (c && typeof c === "object") {
      const v = (c as { value?: unknown; email?: unknown }).value ?? (c as { email?: unknown }).email;
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

function ErrorBanner({
  label, query,
}: {
  label: string;
  query: { error: unknown; isError: boolean; refetch: () => void };
}) {
  if (!query.isError) return null;
  const err = query.error;
  const msg = err instanceof N3Error ? err.message : err instanceof Error ? err.message : "Request failed";
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <span><strong>{label}:</strong> {msg}</span>
      <button type="button" className="app-btn" onClick={() => query.refetch()}>Retry</button>
    </div>
  );
}

// ============================== Line list ==============================

interface LineCtx {
  stockOptions: ComboOption[]; stocksLoading: boolean;
  glOptions: ComboOption[]; glLoading: boolean;
  projectOptions: ComboOption[]; projectsLoading: boolean;
  taxOptions: ComboOption[]; taxLoading: boolean;
  tariffOptions: ComboOption[]; tariffLoading: boolean;
  tariffHasError: boolean;
  onStockSelect: (line: DetailLine, opt: ComboOption | null) => void;
  onGlSelect: (line: DetailLine, opt: ComboOption | null) => void;
  onChange: (key: string, patch: Partial<DetailLine>) => void;
  lineNet: (l: DetailLine) => number;
}

function LineList({
  lines, layout, onAdd, onRemove, totalNet,
  ...ctx
}: LineCtx & {
  lines: DetailLine[]; layout: ItemLayout;
  onAdd: () => void; onRemove: (key: string) => void; totalNet: number;
}) {
  const gridRef = useRef<HTMLDivElement>(null);

  const advanceFocus = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    const list = Array.from(
      gridRef.current?.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
        'input:not([readonly]):not([disabled]):not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"])',
      ) ?? [],
    );
    const idx = active ? list.indexOf(active as HTMLInputElement) : -1;
    const next = list[idx + 1];
    if (next) {
      next.focus();
      (next as HTMLInputElement).select?.();
      return true;
    }
    return false;
  }, []);

  const handleGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    // Don't hijack Enter inside a search input inside a popover — that's the
    // dropdown's own commit key. SearchableSelect preventDefaults it too.
    const t = e.target as HTMLElement;
    if (t.getAttribute("role") === "searchbox" || t.getAttribute("role") === "combobox") return;
    e.preventDefault();
    const moved = advanceFocus();
    if (!moved) {
      onAdd();
      requestAnimationFrame(() => {
        const rows = gridRef.current?.querySelectorAll<HTMLElement>("[data-line-row]");
        const lastRow = rows?.[rows.length - 1];
        const firstFieldOfLast = lastRow?.querySelector<HTMLElement>(
          'input:not([readonly]):not([disabled]):not([tabindex="-1"])',
        );
        firstFieldOfLast?.focus();
      });
    }
  };

  return (
    <div className="app-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Invoice Lines</h2>
          <p className="text-[11px] text-muted-foreground">
            Two-row card · configure fields in <a className="underline" href="/settings">Settings</a> · Enter advances field / creates line · Net = Qty × Unit Price
          </p>
        </div>
        <button type="button" className="app-btn" onClick={onAdd}>+ Add line</button>
      </div>

      <div ref={gridRef} onKeyDown={handleGridKey} className="space-y-3 p-3">
        {lines.map((line, i) => (
          <LineCard
            key={line.key}
            line={line}
            index={i}
            layout={layout}
            onRemove={() => onRemove(line.key)}
            canRemove={lines.length > 1}
            {...ctx}
          />
        ))}
      </div>

      <div className="flex items-center justify-between border-t-2 border-border-strong bg-surface-2 px-4 py-2">
        <span className="text-xs font-semibold uppercase text-muted-foreground">
          Line subtotal (MYR)
        </span>
        <span className="tabular font-semibold">{formatMoney(totalNet)}</span>
      </div>
    </div>
  );
}

function LineCard({
  line, index, layout, onRemove, canRemove, ...ctx
}: LineCtx & {
  line: DetailLine; index: number; layout: ItemLayout;
  onRemove: () => void; canRemove: boolean;
}) {
  const anyFilled =
    line.stockId != null || line.glAccountId != null || line.projectId != null ||
    line.taxCodeId != null || line.tariffCodeId != null ||
    line.qty.trim() !== "" || line.unitPrice.trim() !== "";

  const errorFor = (id: FieldId): string | null => {
    if (!anyFilled) return null;
    switch (id) {
      case "wbs": return line.stockId == null ? "WBS required" : line.uomError;
      case "glAccount": return line.glAccountId == null ? "GL required" : null;
      case "costCentre": return line.projectId == null ? "Cost Centre required" : null;
      case "hqTax": return line.taxCodeId == null ? "Tax required" : null;
      case "orderNo": return line.tariffCodeId == null ? "Tariff required" : null;
      case "qty": return Number(line.qty) > 0 ? null : "Qty > 0";
      case "unitPrice": return Number(line.unitPrice) >= 0 ? null : "Price ≥ 0";
      default: return null;
    }
  };

  const renderField = (id: FieldId) => (
    <FieldCell
      key={id}
      id={id}
      line={line}
      index={index}
      error={errorFor(id)}
      {...ctx}
    />
  );

  return (
    <div
      data-line-row
      className="grid-row-focus rounded-lg border border-border bg-surface"
    >
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <div className="text-xs font-semibold text-muted-foreground tabular">
          Item {index + 1}
        </div>
        <button
          type="button"
          tabIndex={-1}
          onClick={onRemove}
          disabled={!canRemove}
          className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-40"
          aria-label={`Delete item ${index + 1}`}
        >
          Delete line
        </button>
      </div>
      <div className="space-y-2 p-3">
        <RowRow ids={layout.row1} render={renderField} />
        <RowRow ids={layout.row2} render={renderField} />
      </div>
    </div>
  );
}

function RowRow({
  ids, render,
}: { ids: FieldId[]; render: (id: FieldId) => React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2">
      {ids.map((id) => render(id))}
    </div>
  );
}

function FieldCell({
  id, line, index, error, ...ctx
}: LineCtx & { id: FieldId; line: DetailLine; index: number; error: string | null }) {
  const readOnly = READONLY_FIELDS.has(id);
  const wideClass = "min-w-[220px] flex-[2_1_220px]";
  const medClass = "min-w-[180px] flex-[1.5_1_180px]";
  const narrowClass = "min-w-[110px] flex-1";

  const wrap = (widthClass: string, content: React.ReactNode) => (
    <div className={widthClass}>
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {FIELD_LABELS[id]}
      </div>
      {content}
      {error && <FieldError text={error} />}
    </div>
  );

  const { onChange } = ctx;

  switch (id) {
    case "wbs":
      return wrap(medClass, (
        <SearchableSelect
          compact popoverPortal withPopoverSearch
          options={ctx.stockOptions}
          loading={ctx.stocksLoading}
          value={line.stockId != null ? String(line.stockId) : null}
          selectedLabel={line.stockId ? `${line.stockCode} — ${line.stockName}`.trim() : ""}
          onChange={(o) => ctx.onStockSelect(line, o)}
          placeholder={ctx.stocksLoading ? "Loading…" : "Select WBS"}
          ariaLabel={`WBS line ${index + 1}`}
        />
      ));
    case "itemDescription":
      return wrap(wideClass, (
        <input
          className="app-input h-8 px-2 py-1 text-[13px]"
          value={line.itemDescription}
          onChange={(e) => onChange(line.key, {
            itemDescription: e.target.value, itemDescriptionTouched: true,
          })}
          aria-label={`Item Description line ${index + 1}`}
          placeholder={line.stockId ? "" : "Select WBS to default"}
        />
      ));
    case "glAccount":
      return wrap(medClass, (
        <SearchableSelect
          compact popoverPortal withPopoverSearch
          options={ctx.glOptions}
          loading={ctx.glLoading}
          value={line.glAccountId != null ? String(line.glAccountId) : null}
          selectedLabel={line.glAccountId ? `${line.glAccountCode} — ${line.glAccountName}`.trim() : ""}
          onChange={(o) => ctx.onGlSelect(line, o)}
          placeholder={ctx.glLoading ? "Loading…" : "Select GL"}
          ariaLabel={`GL Account line ${index + 1}`}
        />
      ));
    case "glAccountName":
      return wrap(wideClass, (
        <input
          readOnly tabIndex={-1}
          className="app-input h-8 px-2 py-1 text-[13px] bg-muted"
          value={line.glAccountName}
          aria-label={`GL Account Name line ${index + 1}`}
        />
      ));
    case "costCentre":
      return wrap(medClass, (
        <SearchableSelect
          compact popoverPortal withPopoverSearch
          options={ctx.projectOptions}
          loading={ctx.projectsLoading}
          value={line.projectId != null ? String(line.projectId) : null}
          selectedLabel={line.projectId ? `${line.projectCode} — ${line.projectName}`.trim() : ""}
          onChange={(o) => {
            if (!o) {
              onChange(line.key, { projectId: null, projectCode: "", projectName: "" });
              return;
            }
            const [code, ...rest] = o.label.split(" — ");
            onChange(line.key, {
              projectId: Number(o.value), projectCode: code ?? "", projectName: rest.join(" — "),
            });
          }}
          placeholder={ctx.projectsLoading ? "Loading…" : "Select Cost Centre"}
          ariaLabel={`Cost Centre line ${index + 1}`}
        />
      ));
    case "hqTax":
      return wrap(medClass, (
        <SearchableSelect
          compact popoverPortal withPopoverSearch
          options={ctx.taxOptions}
          loading={ctx.taxLoading}
          value={line.taxCodeId != null ? String(line.taxCodeId) : null}
          selectedLabel={line.taxCodeId ? `${line.taxCodeCode} — ${line.taxCodeName}`.trim() : ""}
          onChange={(o) => {
            if (!o) {
              onChange(line.key, { taxCodeId: null, taxCodeCode: "", taxCodeName: "" });
              return;
            }
            const [code, ...rest] = o.label.split(" — ");
            onChange(line.key, {
              taxCodeId: Number(o.value), taxCodeCode: code ?? "", taxCodeName: rest.join(" — "),
            });
          }}
          placeholder={ctx.taxLoading ? "Loading…" : "Select Tax"}
          ariaLabel={`HQ Tax line ${index + 1}`}
        />
      ));
    case "orderNo": {
      const tariffEmpty =
        !ctx.tariffLoading && !ctx.tariffHasError && ctx.tariffOptions.length === 0;
      return wrap(medClass, (
        <>
          <SearchableSelect
            compact popoverPortal withPopoverSearch
            options={ctx.tariffOptions}
            loading={ctx.tariffLoading}
            value={line.tariffCodeId != null ? String(line.tariffCodeId) : null}
            selectedLabel={line.tariffCodeId ? `${line.tariffCodeCode} — ${line.tariffCodeName}`.trim() : ""}
            onChange={(o) => {
              if (!o) {
                onChange(line.key, { tariffCodeId: null, tariffCodeCode: "", tariffCodeName: "" });
                return;
              }
              const [code, ...rest] = o.label.split(" — ");
              onChange(line.key, {
                tariffCodeId: Number(o.value), tariffCodeCode: code ?? "", tariffCodeName: rest.join(" — "),
              });
            }}
            placeholder={
              ctx.tariffLoading
                ? "Loading…"
                : tariffEmpty
                  ? "No Tariff Codes configured"
                  : "Select Tariff"
            }
            emptyMessage="No Tariff Codes are configured in N3"
            ariaLabel={`Order No line ${index + 1}`}
          />
          {tariffEmpty && (
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              No Tariff Codes are configured in N3
            </p>
          )}
        </>
      ));
    }
    case "qty":
      return wrap(narrowClass, (
        <input
          className="app-input h-8 px-2 py-1 text-[13px] tabular text-right"
          inputMode="decimal"
          value={line.qty}
          onChange={(e) => onChange(line.key, { qty: e.target.value })}
          aria-label={`Qty line ${index + 1}`}
        />
      ));
    case "unitPrice":
      return wrap(narrowClass, (
        <input
          className="app-input h-8 px-2 py-1 text-[13px] tabular text-right"
          inputMode="decimal"
          value={line.unitPrice}
          onChange={(e) => onChange(line.key, { unitPrice: e.target.value })}
          aria-label={`Unit Price line ${index + 1}`}
        />
      ));
    case "netAmount":
      return wrap(narrowClass, (
        <input
          readOnly tabIndex={-1}
          className="app-input h-8 px-2 py-1 text-[13px] tabular text-right bg-muted"
          value={formatMoney(ctx.lineNet(line))}
          aria-label={`Net Amount line ${index + 1}`}
        />
      ));
    case "refNo":
      return wrap(narrowClass, (
        <input
          className="app-input h-8 px-2 py-1 text-[13px]"
          value={line.refNo}
          onChange={(e) => onChange(line.key, { refNo: e.target.value })}
          aria-label={`Ref No line ${index + 1}`}
        />
      ));
    default: {
      const _: never = id;
      void _; void readOnly;
      return null;
    }
  }
}

function FieldError({ text }: { text: string }) {
  return (
    <p className="mt-0.5 text-[10px] font-medium text-destructive" role="alert">
      {text}
    </p>
  );
}
