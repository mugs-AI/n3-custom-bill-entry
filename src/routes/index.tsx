import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { SearchableSelect, type ComboOption } from "@/components/SearchableSelect";
import { MyDateInput } from "@/components/MyDateInput";
import { setToken } from "@/lib/auth-store";
import { useAuthToken, useHydrated } from "@/hooks/use-auth";
import { n3Call, n3ListAll, N3Error } from "@/lib/n3-client";
import { todayISOInKL } from "@/lib/date-my";

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

// -------- Types modelled on real N3 DTOs (verified against swagger). --------
// SupplierListDto: id, code, name, address1..4, contactPerson, email, phoneNo1,
//   phoneNo2, termCode, ...
// SupplierDto (detail /api/Suppliers/{id}): id, code, name, address1..4,
//   contactPerson, email, eInvoiceEmail, emailList[], phoneNo1, termId,
//   term: { id, code, description }, ...
// PurchaserDto: id, code, name, isActive, isDefault, ...
// TermLookupDto (/api/Terms/Query): id, code, description, type, value.

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

interface Purchaser {
  id: number;
  code?: string;
  name?: string;
  isActive?: boolean;
}

interface Term {
  id: number;
  code?: string;
  description?: string;
}

interface DetailLine {
  key: string;
  stockCode: string;
  itemDescription: string;
  glAccountCode: string;
  glAccountName: string;
  costCentre: string;
  hqTax: string;
  orderNo: string;
  qty: string;
  unitPrice: string;
  refNo: string;
}

const emptyLine = (): DetailLine => ({
  key: crypto.randomUUID(),
  stockCode: "",
  itemDescription: "",
  glAccountCode: "",
  glAccountName: "",
  costCentre: "",
  hqTax: "",
  orderNo: "",
  qty: "",
  unitPrice: "",
  refNo: "",
});

function NewBillEntry() {
  // Root crash root cause: `?token=…` from N3 My Apps is present during SSR
  // too, but SSR cannot read/write localStorage. If we render BillForm on the
  // server (no token → NoAuthPanel) and then swap to BillForm on the client
  // after capturing the token, React sees a fully different tree at hydration
  // → hydration mismatch → error boundary → "This page didn't load".
  //
  // Fix: render a neutral shell on the server and defer the auth-dependent UI
  // until after the first client render. Token capture from the URL runs in
  // that same effect, BEFORE any protected N3 request can run.
  const hydrated = useHydrated();
  const token = useAuthToken();
  const [capturePhase, setCapturePhase] = useState<"pending" | "done">("pending");

  useEffect(() => {
    if (typeof window === "undefined") {
      setCapturePhase("done");
      return;
    }
    try {
      const url = new URL(window.location.href);
      const t = url.searchParams.get("token");
      if (t) {
        // Persist BEFORE cleaning the URL so a race that reads the URL later
        // still finds the token in storage.
        setToken(t);
        url.searchParams.delete("token");
        window.history.replaceState({}, "", url.toString());
      }
    } catch {
      // Fail-safe: never let URL parsing crash the app shell.
    }
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
          <a href="/dev-login" className="text-primary underline">
            dev connect
          </a>{" "}
          screen to exchange an API key.
        </p>
      )}
    </div>
  );
}

// ------------------------------- The form -------------------------------

function BillForm() {
  const [docDate, setDocDate] = useState(() => todayISOInKL());
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [purchaserId, setPurchaserId] = useState<number | null>(null);
  const [termId, setTermId] = useState<number | null>(null);
  const [termTouched, setTermTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [refNo, setRefNo] = useState("");
  const [supplierInvNo, setSupplierInvNo] = useState("");
  const [lines, setLines] = useState<DetailLine[]>(() => [emptyLine()]);

  const suppliersQ = useQuery({
    queryKey: ["n3", "suppliers"],
    queryFn: ({ signal }) =>
      n3ListAll<SupplierList>("api/Suppliers/List", { pageSize: 500, signal }),
    staleTime: 60_000,
    retry: (count, err) => (err instanceof N3Error && err.status === 401 ? false : count < 1),
  });

  const purchasersQ = useQuery({
    queryKey: ["n3", "purchasers"],
    queryFn: ({ signal }) =>
      n3ListAll<Purchaser>("api/Purchasers/Query", { pageSize: 500, signal }),
    staleTime: 60_000,
    retry: (count, err) => (err instanceof N3Error && err.status === 401 ? false : count < 1),
  });

  const termsQ = useQuery({
    queryKey: ["n3", "terms"],
    queryFn: ({ signal }) =>
      n3ListAll<Term>("api/Terms/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000,
    retry: (count, err) => (err instanceof N3Error && err.status === 401 ? false : count < 1),
  });

  // Hydrate the selected Supplier's full record. The list DTO already includes
  // address/contact/email/phone, but the fully-typed term relation only lives
  // on SupplierDto — so we always fetch when a selection exists.
  const supplierDetailQ = useQuery({
    queryKey: ["n3", "supplier", supplierId],
    queryFn: ({ signal }) =>
      n3Call<SupplierDetail>(`api/Suppliers/${supplierId}`, { signal }),
    enabled: supplierId != null,
    staleTime: 30_000,
    retry: (count, err) => (err instanceof N3Error && err.status === 401 ? false : count < 1),
  });

  // Default Term from the supplier profile (only until the user picks one).
  useEffect(() => {
    if (termTouched) return;
    const detail = supplierDetailQ.data;
    if (!detail) return;
    const next = detail.termId ?? detail.term?.id ?? null;
    setTermId(next);
  }, [supplierDetailQ.data, termTouched]);

  // Clearing the Supplier resets every derived field consistently.
  useEffect(() => {
    if (supplierId == null) {
      setTermId(null);
      setTermTouched(false);
    }
  }, [supplierId]);

  // Case-insensitive, numeric-aware collator so "800-M002" sorts after
  // "800-M009" the way a human expects, and names like "eastcom" / "EASTCOM"
  // compare equal for ordering.
  const collator = useMemo(
    () => new Intl.Collator(undefined, { sensitivity: "base", numeric: true }),
    [],
  );

  const supplierOptions: ComboOption[] = useMemo(() => {
    const rows = (suppliersQ.data ?? []).slice();
    // Sort by Supplier Name asc, Supplier Code tie-break, empty names last.
    rows.sort((a, b) => {
      const an = (a.name ?? "").trim();
      const bn = (b.name ?? "").trim();
      if (!an && bn) return 1;
      if (an && !bn) return -1;
      const byName = collator.compare(an, bn);
      if (byName !== 0) return byName;
      return collator.compare(a.code ?? "", b.code ?? "");
    });
    return rows.map((s) => ({
      value: String(s.id),
      label: `${s.code ?? ""} — ${s.name ?? ""}`.trim(),
      hint: s.termCode ?? undefined,
    }));
  }, [suppliersQ.data, collator]);

  const purchaserOptions: ComboOption[] = useMemo(
    () =>
      (purchasersQ.data ?? [])
        .filter((p) => p.isActive !== false)
        .map((p) => ({
          value: String(p.id),
          label: `${p.code ?? ""} — ${p.name ?? ""}`.trim(),
        })),
    [purchasersQ.data],
  );

  const termOptions: ComboOption[] = useMemo(
    () =>
      (termsQ.data ?? []).map((t) => ({
        value: String(t.id),
        label: `${t.code ?? ""} — ${t.description ?? ""}`.trim(),
      })),
    [termsQ.data],
  );

  // Fallback view = the row from the /Suppliers/List response for the
  // currently-selected id. This lets Name/Address/Phone/Email/Contact/Term
  // Code appear IMMEDIATELY on selection — the /Suppliers/{id} enrichment
  // only overwrites or fills in properties the list DTO doesn't carry
  // (termId, full Term relation, eInvoiceEmail, emailList).
  const listSupplier = useMemo<SupplierList | null>(() => {
    if (supplierId == null) return null;
    return (suppliersQ.data ?? []).find((s) => s.id === supplierId) ?? null;
  }, [suppliersQ.data, supplierId]);

  // Guard against a stale detail response overwriting a newer selection.
  // react-query keys by supplierId already, but defensively verify.
  const detail: SupplierDetail | null =
    supplierDetailQ.data && supplierDetailQ.data.id === supplierId
      ? supplierDetailQ.data
      : null;

  // Merge: prefer detail fields when present, otherwise fall back to list.
  const supplierView = detail ?? listSupplier;
  const addressLines = [
    supplierView?.address1,
    supplierView?.address2,
    supplierView?.address3,
    supplierView?.address4,
  ]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0);

  const email = pickEmail(detail) || (listSupplier?.email ?? "");
  const phone = supplierView?.phoneNo1 ?? "";
  const contact = supplierView?.contactPerson ?? "";
  const supplierName = supplierView?.name ?? "";
  const supplierLabel = listSupplier
    ? `${listSupplier.code ?? ""} — ${listSupplier.name ?? ""}`.trim()
    : "";
  const enriching = supplierId != null && supplierDetailQ.isFetching;

  const totalNet = useMemo(
    () =>
      lines.reduce((sum, l) => {
        const n = Number(l.qty) * Number(l.unitPrice);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0),
    [lines],
  );

  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
  const removeLine = (key: string) =>
    setLines((ls) => (ls.length <= 1 ? ls : ls.filter((l) => l.key !== key)));
  const updateLine = (key: string, patch: Partial<DetailLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        // Save is intentionally disabled until Phase 2 wires the real POST.
        e.preventDefault();
      }}
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
            Simplified Purchase Invoice · posts directly to N3 · MYR · Tax Inclusive off
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="app-btn" onClick={() => window.location.reload()}>
            Reset
          </button>
          <button
            type="button"
            disabled
            title="Purchase Invoice POST arrives in Phase 2"
            className="app-btn app-btn-primary cursor-not-allowed opacity-60"
          >
            Save to N3 · Available after Phase 2
          </button>
        </div>
      </div>

      <ErrorBanner label="Suppliers" query={suppliersQ} />
      <ErrorBanner label="Purchasers" query={purchasersQ} />
      <ErrorBanner label="Terms" query={termsQ} />
      <ErrorBanner label="Supplier details" query={supplierDetailQ} />

      {/* Header card */}
      <div className="app-card p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <label className="app-label">Purchase Invoice No.</label>
            <input
              className="app-input bg-muted text-muted-foreground"
              readOnly
              value="Assigned on save"
            />
          </div>
          <div>
            <label className="app-label" htmlFor="doc-date">
              Document Date
            </label>
            <MyDateInput
              id="doc-date"
              value={docDate}
              onChange={setDocDate}
              ariaLabel="Document Date"
              required
            />
          </div>
          <div>
            <label className="app-label">Supplier</label>
            <SearchableSelect
              options={supplierOptions}
              value={supplierId != null ? String(supplierId) : null}
              onChange={(o) => setSupplierId(o ? Number(o.value) : null)}
              loading={suppliersQ.isLoading}
              placeholder={
                suppliersQ.isLoading ? "Loading suppliers…" : "Search by code or name"
              }
              ariaLabel="Supplier"
            />
          </div>

          <div className="md:col-span-2">
            <label className="app-label">Supplier Name</label>
            <input
              className="app-input"
              readOnly
              value={detail?.name ?? ""}
            />
          </div>
          <div>
            <label className="app-label">Payment Type (Purchaser)</label>
            <SearchableSelect
              options={purchaserOptions}
              value={purchaserId != null ? String(purchaserId) : null}
              onChange={(o) => setPurchaserId(o ? Number(o.value) : null)}
              loading={purchasersQ.isLoading}
              placeholder={
                purchasersQ.isLoading ? "Loading purchasers…" : "Blank — select if needed"
              }
              ariaLabel="Purchaser"
            />
          </div>

          <div className="md:col-span-2">
            <label className="app-label">Supplier Address</label>
            <div
              className="app-input min-h-[76px] whitespace-pre-line py-2"
              role="group"
              aria-label="Supplier Address"
            >
              {supplierDetailQ.isLoading && supplierId != null ? (
                <span className="text-muted-foreground">Loading…</span>
              ) : addressLines.length ? (
                addressLines.join("\n")
              ) : (
                ""
              )}
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
            <label className="app-label">
              Term <span className="text-destructive">*</span>
            </label>
            <SearchableSelect
              options={termOptions}
              value={termId != null ? String(termId) : null}
              onChange={(o) => {
                setTermTouched(true);
                setTermId(o ? Number(o.value) : null);
              }}
              loading={termsQ.isLoading}
              placeholder={
                termsQ.isLoading
                  ? "Loading terms…"
                  : supplierId
                    ? "Default from supplier"
                    : "Select a term"
              }
              ariaLabel="Term"
            />
          </div>

          <div>
            <label className="app-label">HQ Sequence</label>
            <input
              className="app-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Free text (→ Description)"
            />
          </div>
          <div>
            <label className="app-label">Reference No.</label>
            <input
              className="app-input"
              value={refNo}
              onChange={(e) => setRefNo(e.target.value)}
            />
          </div>
          <div>
            <label className="app-label">
              Supplier INV# <span className="text-destructive">*</span>
            </label>
            <input
              required
              className="app-input"
              value={supplierInvNo}
              onChange={(e) => setSupplierInvNo(e.target.value)}
              placeholder="Duplicate check on save (Phase 2)"
            />
          </div>
        </div>
      </div>

      <DetailGrid
        lines={lines}
        onAdd={addLine}
        onRemove={removeLine}
        onChange={updateLine}
        totalNet={totalNet}
      />
    </form>
  );
}

// Email may be a plain string, an object with `value`, or an array of either
// (varies by e-invoice configuration). Pick the first non-empty string.
function pickEmail(detail: SupplierDetail | null): string {
  if (!detail) return "";
  const candidates: unknown[] = [
    detail.email,
    detail.eInvoiceEmail,
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
  label,
  query,
}: {
  label: string;
  query: { error: unknown; isError: boolean; refetch: () => void };
}) {
  if (!query.isError) return null;
  const err = query.error;
  const msg =
    err instanceof N3Error
      ? err.message
      : err instanceof Error
        ? err.message
        : "Request failed";
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      <span>
        <strong>{label}:</strong> {msg}
      </span>
      <button type="button" className="app-btn" onClick={() => query.refetch()}>
        Retry
      </button>
    </div>
  );
}

// ------------------------------ Detail grid ------------------------------

const COLS = [
  { key: "stockCode", label: "WBS", width: "min-w-[110px]" },
  { key: "itemDescription", label: "Item Description", width: "min-w-[220px]" },
  { key: "glAccountCode", label: "GL Account", width: "min-w-[130px]" },
  { key: "glAccountName", label: "GL Account Name", width: "min-w-[180px]", readOnly: true },
  { key: "costCentre", label: "Cost Centre", width: "min-w-[140px]" },
  { key: "hqTax", label: "HQ Tax", width: "min-w-[110px]" },
  { key: "orderNo", label: "Order No.", width: "min-w-[120px]" },
  { key: "qty", label: "Qty", width: "min-w-[80px]", numeric: true },
  { key: "unitPrice", label: "Unit Price", width: "min-w-[110px]", numeric: true },
  { key: "netAmount", label: "Net Amount", width: "min-w-[120px]", numeric: true, readOnly: true },
  { key: "refNo", label: "Ref. No.", width: "min-w-[120px]" },
] as const;

function DetailGrid({
  lines,
  onAdd,
  onRemove,
  onChange,
  totalNet,
}: {
  lines: DetailLine[];
  onAdd: () => void;
  onRemove: (key: string) => void;
  onChange: (key: string, patch: Partial<DetailLine>) => void;
  totalNet: number;
}) {
  const gridRef = useRef<HTMLDivElement>(null);

  const handleGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    const target = e.target as HTMLElement;
    if (target.tagName !== "INPUT") return;
    e.preventDefault();
    const inputs = Array.from(
      gridRef.current?.querySelectorAll<HTMLInputElement>(
        "input:not([readonly]):not([disabled])",
      ) ?? [],
    );
    const idx = inputs.indexOf(target as HTMLInputElement);
    if (idx < 0) return;
    const next = inputs[idx + 1];
    if (next) {
      next.focus();
      next.select?.();
    } else {
      onAdd();
      requestAnimationFrame(() => {
        const refreshed = Array.from(
          gridRef.current?.querySelectorAll<HTMLInputElement>(
            "input:not([readonly]):not([disabled])",
          ) ?? [],
        );
        refreshed[inputs.length]?.focus();
      });
    }
  };

  return (
    <div className="app-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Invoice Lines</h2>
          <p className="text-[11px] text-muted-foreground">
            Phase 2 wires WBS / GL / Cost Centre / Tax lookups · Net = Qty × Unit Price
          </p>
        </div>
        <button type="button" className="app-btn" onClick={onAdd}>
          + Add line
        </button>
      </div>
      <div ref={gridRef} onKeyDown={handleGridKey} className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="w-8 px-2 py-2"></th>
              {COLS.map((c) => (
                <th key={c.key} className={`px-2 py-2 font-medium ${c.width}`}>
                  {c.label}
                </th>
              ))}
              <th className="w-10 px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => {
              const net = Number(line.qty) * Number(line.unitPrice);
              return (
                <tr key={line.key} className="grid-row-focus border-t border-border">
                  <td className="px-2 py-1.5 text-xs text-muted-foreground tabular">
                    {i + 1}
                  </td>
                  {COLS.map((c) => {
                    if (c.key === "netAmount") {
                      return (
                        <td key={c.key} className="px-2 py-1.5">
                          <input
                            readOnly
                            className="app-input tabular text-right"
                            value={Number.isFinite(net) ? net.toFixed(2) : "0.00"}
                            tabIndex={-1}
                          />
                        </td>
                      );
                    }
                    const readOnly = "readOnly" in c && c.readOnly;
                    const numeric = "numeric" in c && c.numeric;
                    return (
                      <td key={c.key} className="px-2 py-1.5">
                        <input
                          className={`app-input ${numeric ? "tabular text-right" : ""}`}
                          readOnly={readOnly}
                          value={(line as unknown as Record<string, string>)[c.key] ?? ""}
                          inputMode={numeric ? "decimal" : undefined}
                          onChange={(e) =>
                            onChange(line.key, { [c.key]: e.target.value } as Partial<DetailLine>)
                          }
                        />
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => onRemove(line.key)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Remove line ${i + 1}`}
                      disabled={lines.length === 1}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-surface-2">
              <td
                colSpan={COLS.length - 1}
                className="px-2 py-2 text-right text-xs font-semibold uppercase text-muted-foreground"
              >
                Line subtotal (MYR)
              </td>
              <td className="px-2 py-2 text-right tabular font-semibold">
                {totalNet.toFixed(2)}
              </td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
