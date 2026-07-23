import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { SearchableSelect, type ComboOption } from "@/components/SearchableSelect";
import { setToken } from "@/lib/auth-store";
import { useAuthToken } from "@/hooks/use-auth";
import { n3ListAll, N3Error } from "@/lib/n3-client";

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
          "Keyboard-friendly alternative to the standard N3 Purchase Invoice screen.",
      },
    ],
  }),
  component: NewBillEntry,
});

// -------- Types loosely modelled on N3 DTOs (we only depend on a few fields) --------

interface Supplier {
  id?: string;
  code?: string;
  companyName?: string;
  address1?: string;
  address2?: string;
  contact?: string;
  phone1?: string;
  emailAddress?: string;
  creditTerm?: { code?: string } | null;
  creditTermId?: string;
}

interface Purchaser {
  id?: string;
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

const todayISO = () => new Date().toISOString().slice(0, 10);

function NewBillEntry() {
  const token = useAuthToken();
  const [captured, setCaptured] = useState(false);

  // Path A: capture ?token= from N3 My Apps launch.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const t = url.searchParams.get("token");
    if (t) {
      setToken(t);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());
      setCaptured(true);
    }
  }, []);

  return (
    <AppShell>
      {!token && !captured ? (
        <NoAuthPanel />
      ) : (
        <BillForm />
      )}
    </AppShell>
  );
}

function NoAuthPanel() {
  const [isDev, setIsDev] = useState(false);
  useEffect(() => setIsDev(import.meta.env.DEV), []);
  return (
    <div className="app-card mx-auto max-w-lg p-6">
      <h1 className="text-lg font-semibold">Not connected to N3</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        This app must be launched from <strong>N3 My Apps</strong> so the JWT is
        delivered on the URL as <code>?token=…</code>. The token is then stored in
        your browser and reused across reloads.
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
  const [docDate, setDocDate] = useState(todayISO());
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [purchaserId, setPurchaserId] = useState<string | null>(null);
  const [description, setDescription] = useState(""); // HQ Sequence
  const [refNo, setRefNo] = useState("");
  const [supplierInvNo, setSupplierInvNo] = useState("");
  const [lines, setLines] = useState<DetailLine[]>(() => [emptyLine()]);

  const suppliersQ = useQuery({
    queryKey: ["n3", "suppliers"],
    queryFn: () => n3ListAll<Supplier>("api/Suppliers/List", { pageSize: 200 }),
    staleTime: 60_000,
  });
  const purchasersQ = useQuery({
    queryKey: ["n3", "purchasers"],
    queryFn: () => n3ListAll<Purchaser>("api/Purchasers/Query", { pageSize: 200 }),
    staleTime: 60_000,
  });

  const supplierOptions: ComboOption[] = useMemo(
    () =>
      (suppliersQ.data ?? []).map((s) => ({
        value: s.id ?? s.code ?? "",
        label: `${s.code ?? ""} — ${s.companyName ?? ""}`,
        hint: s.emailAddress ?? undefined,
      })),
    [suppliersQ.data],
  );

  const purchaserOptions: ComboOption[] = useMemo(
    () =>
      (purchasersQ.data ?? []).map((p) => ({
        value: p.id ?? p.code ?? "",
        label: `${p.code ?? ""} — ${p.description ?? ""}`,
      })),
    [purchasersQ.data],
  );

  const selectedSupplier = useMemo(
    () => (suppliersQ.data ?? []).find((s) => (s.id ?? s.code) === supplierId) ?? null,
    [suppliersQ.data, supplierId],
  );

  const anyError =
    suppliersQ.error instanceof N3Error
      ? suppliersQ.error.message
      : purchasersQ.error instanceof N3Error
        ? purchasersQ.error.message
        : null;

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
        e.preventDefault();
        // Phase 2: implement save flow (duplicate check + POST /api/PurchaseInvoices/Create)
        alert("Save is wired in Phase 2. Duplicate check + N3 POST comes next.");
      }}
      onKeyDown={(e) => {
        // Guard: Enter inside grid or dropdowns must NEVER submit the form.
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
          <button type="submit" className="app-btn app-btn-primary">
            Save to N3
          </button>
        </div>
      </div>

      {anyError && (
        <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load master data: {anyError}
        </div>
      )}

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
            <label className="app-label">Document Date</label>
            <input
              type="date"
              className="app-input"
              value={docDate}
              onChange={(e) => setDocDate(e.target.value)}
            />
          </div>
          <div>
            <label className="app-label">Supplier</label>
            <SearchableSelect
              options={supplierOptions}
              value={supplierId}
              onChange={(o) => setSupplierId(o?.value ?? null)}
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
              value={selectedSupplier?.companyName ?? ""}
            />
          </div>
          <div>
            <label className="app-label">Payment Type (Purchaser)</label>
            <SearchableSelect
              options={purchaserOptions}
              value={purchaserId}
              onChange={(o) => setPurchaserId(o?.value ?? null)}
              loading={purchasersQ.isLoading}
              placeholder="Blank — select if needed"
              ariaLabel="Purchaser"
            />
          </div>

          <div className="md:col-span-2">
            <label className="app-label">Supplier Address</label>
            <input
              className="app-input"
              readOnly
              value={[selectedSupplier?.address1, selectedSupplier?.address2]
                .filter(Boolean)
                .join(", ")}
            />
          </div>
          <div>
            <label className="app-label">Supplier Contact</label>
            <input className="app-input" readOnly value={selectedSupplier?.contact ?? ""} />
          </div>

          <div>
            <label className="app-label">Supplier Phone</label>
            <input className="app-input" readOnly value={selectedSupplier?.phone1 ?? ""} />
          </div>
          <div>
            <label className="app-label">Supplier Email</label>
            <input
              className="app-input"
              readOnly
              value={selectedSupplier?.emailAddress ?? ""}
            />
          </div>
          <div>
            <label className="app-label">Term</label>
            <input
              className="app-input"
              readOnly
              value={selectedSupplier?.creditTerm?.code ?? ""}
              placeholder="From supplier"
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
              placeholder="Duplicate check on save"
            />
          </div>
        </div>
      </div>

      {/* Detail grid */}
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

  // Keyboard: Enter moves to the next editable input; on final field of the
  // final row, add a new line. We rely on the grid's DOM order via [tabIndex].
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
      // Focus the first input of the newly-added row on the next tick.
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
            Tab / Shift+Tab to move · Enter confirms selection or advances · Net = Qty × Unit
            Price (N3 handles final tax &amp; totals)
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
              <td colSpan={COLS.length - 1} className="px-2 py-2 text-right text-xs font-semibold uppercase text-muted-foreground">
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
