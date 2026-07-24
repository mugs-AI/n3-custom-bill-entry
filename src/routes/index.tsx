import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { SearchableSelect, type ComboOption } from "@/components/SearchableSelect";
import { MyDateInput } from "@/components/MyDateInput";
import { getToken, setToken } from "@/lib/auth-store";
import { useAuthToken, useHydrated } from "@/hooks/use-auth";
import { n3Call, n3ListAll, N3Error } from "@/lib/n3-client";
import { todayISOInKL } from "@/lib/date-my";
import { computeLine, formatMoney, sumTo2dp, type LineAmounts } from "@/lib/money";
import { useItemLayout } from "@/hooks/use-item-layout";
import { FIELD_LABELS, READONLY_FIELDS, type FieldId, type ItemLayout } from "@/lib/item-layout";
import {
  clearDraft,
  draftStorageKey,
  loadDraft,
  saveDraft,
  type BillDraft,
  type DraftLine,
} from "@/lib/draft-store";
import { HISTORY_QUERY_KEY } from "@/lib/history-query";

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

// ==================== N3 DTO shapes (verified vs live swagger) ============
// PurchaseInvoiceDetailDto.accountId is a UUID string; AccountCodeLookupDto.id
// is a string. StockLookupDto.id, UOMLookupDto.id, TaxCodeLookupDto.id,
// TariffCodeLookupDto.id, ProjectLookupDto.id, SupplierLookupDto.id,
// PurchaserLookupDto.id, TermLookupDto.id are all integers.

interface SupplierList {
  id: number;
  code?: string;
  name?: string;
  email?: string;
  emailList?: string[];
  phoneNo1?: string;
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
interface StockListRow {
  id: number;
  code?: string;
  name?: string;
  description?: string;
  baseUOM?: string;
  matchedUomId?: number;
  isActive?: boolean;
}
interface StockDetail {
  id: number;
  code?: string;
  name?: string;
  description?: string;
  uoms?: Array<{ id: number; code?: string; isBase?: boolean; rate?: number }>;
}
interface AccountCode {
  id: string;
  code?: string;
  name?: string;
  isActive?: boolean;
}
interface Project {
  id: number;
  code?: string;
  name?: string;
  isActive?: boolean;
}
interface TaxCode {
  id: number;
  code?: string;
  /**
   * N3 TaxCodeLookupDto.rate — a **decimal factor**, not a percentage
   * (0.05 for PT-5%, 0.10 for PT-10%). Never divide by 100 again.
   */
  rate?: number;
  taxRate?: number;
  fullName?: string;
  isActive?: boolean;
  inactive?: boolean;
}
type TaxCodeDetail = TaxCode;
interface TariffCode {
  id: number;
  code?: string;
  description?: string;
  isActive?: boolean;
}

interface DetailLine {
  key: string;
  stockId: number | null;
  stockCode: string;
  stockName: string;
  itemDescription: string;
  itemDescriptionTouched: boolean;
  uomId: number | null;
  uomCode: string;
  uomError: string | null;
  glAccountId: string | null;
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
    if (typeof window === "undefined") {
      setCapturePhase("done");
      return;
    }
    try {
      const url = new URL(window.location.href);
      const t = url.searchParams.get("token");
      if (t) {
        setToken(t);
        url.searchParams.delete("token");
        window.history.replaceState({}, "", url.toString());
      }
    } catch {
      /* fail-safe */
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
        This app must be launched from <strong>N3 My Apps</strong> so the JWT arrives on the URL as{" "}
        <code>?token=…</code>. It is then stored in your browser and reused across reloads.
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

// ============================== The form ==============================

interface SaveState {
  status: "idle" | "saving" | "success" | "error";
  message?: string;
  docCode?: string;
}

function initialFormFromDraft(d: BillDraft | null) {
  if (!d) {
    return {
      docDate: todayISOInKL(),
      supplierId: null as number | null,
      supplierLabel: "",
      purchaserId: null as number | null,
      purchaserLabel: "",
      termId: null as number | null,
      termLabel: "",
      termTouched: false,
      description: "",
      referenceNo: "",
      supplierInvNo: "",
      isTaxInclusive: false,
      lines: [emptyLine()],
    };
  }
  const lines = d.lines.map(
    (l): DetailLine => ({
      key: l.key,
      // n3Id is DraftLine-only metadata that stays on DetailLine for edit-mode
      // Update payloads.
      ...(l.n3Id ? { n3Id: l.n3Id } : {}),
      stockId: l.stockId,
      stockCode: l.stockCode,
      stockName: l.stockName,
      itemDescription: l.itemDescription,
      itemDescriptionTouched: l.itemDescriptionTouched,
      uomId: l.uomId,
      uomCode: l.uomCode,
      uomError: null,
      glAccountId: l.glAccountId,
      glAccountCode: l.glAccountCode,
      glAccountName: l.glAccountName,
      projectId: l.projectId,
      projectCode: l.projectCode,
      projectName: l.projectName,
      taxCodeId: l.taxCodeId,
      taxCodeCode: l.taxCodeCode,
      taxCodeName: l.taxCodeName,
      tariffCodeId: l.tariffCodeId,
      tariffCodeCode: l.tariffCodeCode,
      tariffCodeName: l.tariffCodeName,
      qty: l.qty,
      unitPrice: l.unitPrice,
      refNo: l.refNo,
    }),
  );
  return {
    docDate: d.docDate || todayISOInKL(),
    supplierId: d.supplierId,
    supplierLabel: d.supplierLabel,
    purchaserId: d.purchaserId,
    purchaserLabel: d.purchaserLabel,
    termId: d.termId,
    termLabel: d.termLabel,
    termTouched: d.termTouched,
    description: d.description,
    referenceNo: d.referenceNo,
    supplierInvNo: d.supplierInvNo,
    isTaxInclusive: d.isTaxInclusive,
    lines: lines.length > 0 ? lines : [emptyLine()],
  };
}

export interface BillFormProps {
  /** Defaults to "create". "edit" wires the form to /api/bills/update. */
  mode?: "create" | "edit";
  /**
   * Pre-populated draft when editing an existing PI. Must carry invoiceId
   * and docCode. Used only on first render; further edits go to a per-invoice
   * sessionStorage draft key.
   */
  editInvoice?: BillDraft | null;
}

export function BillForm({ mode = "create", editInvoice = null }: BillFormProps = {}) {
  const layout = useItemLayout();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isEdit = mode === "edit";
  const invoiceId = isEdit ? (editInvoice?.invoiceId ?? null) : null;
  const editedDocCode = isEdit ? (editInvoice?.docCode ?? "") : "";
  const draftScope = useMemo<import("@/lib/draft-store").DraftScope>(
    () => (isEdit && invoiceId ? { kind: "edit", invoiceId } : "new"),
    [isEdit, invoiceId],
  );
  // Draft is loaded once at mount (client only). In edit mode the loaded
  // invoice is the base; a per-invoice session draft (if any) wins over it so
  // in-flight edits survive reload.
  const initial = useMemo(
    () => initialFormFromDraft(loadDraft(draftScope) ?? (isEdit ? editInvoice : null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const draftScopeAtMount = useRef<string>(draftStorageKey(draftScope));

  const [docDate, setDocDate] = useState(initial.docDate);
  const [supplierId, setSupplierId] = useState<number | null>(initial.supplierId);
  const [supplierLabelDraft, setSupplierLabelDraft] = useState<string>(initial.supplierLabel);
  const [purchaserId, setPurchaserId] = useState<number | null>(initial.purchaserId);
  const [purchaserLabelDraft, setPurchaserLabelDraft] = useState<string>(initial.purchaserLabel);
  const [termId, setTermId] = useState<number | null>(initial.termId);
  const [termLabelDraft, setTermLabelDraft] = useState<string>(initial.termLabel);
  const [termTouched, setTermTouched] = useState(initial.termTouched);
  const [description, setDescription] = useState(initial.description);
  const [refNo, setRefNo] = useState(initial.referenceNo);
  const [supplierInvNo, setSupplierInvNo] = useState(initial.supplierInvNo);
  const [isTaxInclusive, setIsTaxInclusive] = useState(initial.isTaxInclusive);
  const [lines, setLines] = useState<DetailLine[]>(initial.lines);
  const [save, setSave] = useState<SaveState>({ status: "idle" });

  const noRetryOn401 = useCallback(
    (count: number, err: unknown) =>
      err instanceof N3Error && err.status === 401 ? false : count < 1,
    [],
  );

  const suppliersQ = useQuery({
    queryKey: ["n3", "suppliers"],
    queryFn: ({ signal }) =>
      n3ListAll<SupplierList>("api/Suppliers/List", { pageSize: 500, signal }),
    staleTime: 60_000,
    retry: noRetryOn401,
  });
  const purchasersQ = useQuery({
    queryKey: ["n3", "purchasers"],
    queryFn: ({ signal }) =>
      n3ListAll<Purchaser>("api/Purchasers/Query", { pageSize: 500, signal }),
    staleTime: 60_000,
    retry: noRetryOn401,
  });
  const termsQ = useQuery({
    queryKey: ["n3", "terms"],
    queryFn: ({ signal }) => n3ListAll<Term>("api/Terms/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000,
    retry: noRetryOn401,
  });
  const stocksQ = useQuery({
    queryKey: ["n3", "stocks"],
    queryFn: ({ signal }) => n3ListAll<StockListRow>("api/Stocks/List", { pageSize: 500, signal }),
    staleTime: 5 * 60_000,
    retry: noRetryOn401,
  });
  const glAccountsQ = useQuery({
    queryKey: ["n3", "glAccounts"],
    queryFn: ({ signal }) =>
      n3ListAll<AccountCode>("api/AccountCodes/Leaf/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000,
    retry: noRetryOn401,
  });
  const projectsQ = useQuery({
    queryKey: ["n3", "projects"],
    queryFn: ({ signal }) => n3ListAll<Project>("api/Projects/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000,
    retry: noRetryOn401,
  });
  const taxCodesQ = useQuery({
    queryKey: ["n3", "taxCodes"],
    queryFn: ({ signal }) =>
      n3ListAll<TaxCode>("api/TaxCodes/InputTax/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000,
    retry: noRetryOn401,
  });
  const tariffCodesQ = useQuery({
    queryKey: ["n3", "tariffCodes"],
    queryFn: ({ signal }) =>
      n3ListAll<TariffCode>("api/TariffCodes/Query", { pageSize: 500, signal }),
    staleTime: 5 * 60_000,
    retry: noRetryOn401,
  });

  const supplierDetailQ = useQuery({
    queryKey: ["n3", "supplier", supplierId],
    queryFn: ({ signal }) => n3Call<SupplierDetail>(`api/Suppliers/${supplierId}`, { signal }),
    enabled: supplierId != null,
    staleTime: 30_000,
    retry: noRetryOn401,
  });

  useEffect(() => {
    if (termTouched) return;
    const detail = supplierDetailQ.data;
    if (!detail) return;
    const tid = detail.termId ?? detail.term?.id ?? null;
    if (tid != null) setTermId(tid);
  }, [supplierDetailQ.data, termTouched]);

  useEffect(() => {
    if (supplierId == null) {
      setSupplierLabelDraft("");
      setTermTouched(false);
    }
  }, [supplierId]);

  const collator = useMemo(
    () => new Intl.Collator(undefined, { sensitivity: "base", numeric: true }),
    [],
  );

  const dedupe = useCallback(<T extends { id: string | number }>(rows: T[]): T[] => {
    const seen = new Set<string | number>();
    const out: T[] = [];
    for (const r of rows) {
      if (r?.id == null || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return out;
  }, []);

  const supplierOptions: ComboOption[] = useMemo(() => {
    const rows = dedupe(suppliersQ.data ?? []).slice();
    rows.sort((a, b) => {
      const an = (a.name ?? "").trim(),
        bn = (b.name ?? "").trim();
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
    () =>
      dedupe(purchasersQ.data ?? [])
        .filter((p) => p.isActive !== false)
        .map((p) => ({ value: String(p.id), label: `${p.code ?? ""} — ${p.name ?? ""}`.trim() })),
    [purchasersQ.data, dedupe],
  );

  const termOptions: ComboOption[] = useMemo(
    () =>
      dedupe(termsQ.data ?? []).map((t) => ({
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
    return rows.map((r) => ({ value: r.id, label: `${r.code ?? ""} — ${r.name ?? ""}`.trim() }));
  }, [glAccountsQ.data, sortByCode, dedupe]);

  const projectOptions: ComboOption[] = useMemo(() => {
    const rows = sortByCode(dedupe(projectsQ.data ?? []).filter((r) => r.isActive !== false));
    return rows.map((r) => ({
      value: String(r.id),
      label: `${r.code ?? ""} — ${r.name ?? ""}`.trim(),
    }));
  }, [projectsQ.data, sortByCode, dedupe]);

  const taxOptions: ComboOption[] = useMemo(() => {
    const rows = sortByCode(
      dedupe(taxCodesQ.data ?? []).filter((r) => r.isActive !== false && r.inactive !== true),
    );
    return rows.map((r) => ({
      value: String(r.id),
      label: `${r.code ?? ""} — ${r.fullName ?? ""}`.trim(),
    }));
  }, [taxCodesQ.data, sortByCode, dedupe]);

  const tariffOptions: ComboOption[] = useMemo(() => {
    const rows = sortByCode(dedupe(tariffCodesQ.data ?? []).filter((r) => r.isActive !== false));
    return rows.map((r) => ({
      value: String(r.id),
      label: `${r.code ?? ""} — ${r.description ?? ""}`.trim(),
    }));
  }, [tariffCodesQ.data, sortByCode, dedupe]);

  const listSupplier = useMemo<SupplierList | null>(() => {
    if (supplierId == null) return null;
    return (suppliersQ.data ?? []).find((s) => s.id === supplierId) ?? null;
  }, [suppliersQ.data, supplierId]);

  const detail: SupplierDetail | null =
    supplierDetailQ.data && supplierDetailQ.data.id === supplierId ? supplierDetailQ.data : null;
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
    : supplierLabelDraft;
  const enriching = supplierId != null && supplierDetailQ.isFetching;

  const purchaserLabel = useMemo(() => {
    if (purchaserId == null) return "";
    const p = (purchasersQ.data ?? []).find((x) => x.id === purchaserId);
    return p ? `${p.code ?? ""} — ${p.name ?? ""}`.trim() : purchaserLabelDraft;
  }, [purchasersQ.data, purchaserId, purchaserLabelDraft]);

  const termLabel = useMemo(() => {
    if (termId == null) return "";
    const t = (termsQ.data ?? []).find((x) => x.id === termId);
    return t ? `${t.code ?? ""} — ${t.description ?? ""}`.trim() : termLabelDraft;
  }, [termsQ.data, termId, termLabelDraft]);

  // Map: taxCodeId -> **rate factor** (0.05 for PT-5%, 0.10 for PT-10%). The
  // N3 TaxCodeLookupDto.rate is a decimal factor, not a percentage. Missing
  // entries default to 0, which produces tax = 0 without breaking net math.
  const taxRateFactorFromList = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of taxCodesQ.data ?? []) {
      const r =
        typeof t.rate === "number" ? t.rate : typeof t.taxRate === "number" ? t.taxRate : undefined;
      if (r != null && Number.isFinite(r)) m.set(t.id, r);
    }
    return m;
  }, [taxCodesQ.data]);

  // Detail fallback for any selected tax code whose list row lacked a rate.
  const [taxRateFactorDetail, setTaxRateFactorDetail] = useState<Map<number, number>>(
    () => new Map(),
  );
  useEffect(() => {
    const selected = new Set<number>();
    for (const l of lines) if (l.taxCodeId != null) selected.add(l.taxCodeId);
    const missing: number[] = [];
    for (const id of selected) {
      if (!taxRateFactorFromList.has(id) && !taxRateFactorDetail.has(id)) missing.push(id);
    }
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const updates = new Map(taxRateFactorDetail);
      for (const id of missing) {
        try {
          const d = await n3Call<TaxCodeDetail>(`api/TaxCodes/${id}`);
          const r =
            typeof d?.rate === "number" ? d.rate : typeof d?.taxRate === "number" ? d.taxRate : 0;
          updates.set(id, Number.isFinite(r) ? r : 0);
        } catch {
          updates.set(id, 0);
        }
      }
      if (!cancelled) setTaxRateFactorDetail(updates);
    })();
    return () => {
      cancelled = true;
    };
  }, [lines, taxRateFactorFromList, taxRateFactorDetail]);

  const rateFactorForLine = useCallback(
    (l: DetailLine): number => {
      if (l.taxCodeId == null) return 0;
      const r = taxRateFactorFromList.get(l.taxCodeId) ?? taxRateFactorDetail.get(l.taxCodeId);
      return typeof r === "number" && Number.isFinite(r) ? r : 0;
    },
    [taxRateFactorFromList, taxRateFactorDetail],
  );

  const amountsFor = useCallback(
    (l: DetailLine): LineAmounts =>
      computeLine({
        qty: l.qty,
        unitPrice: l.unitPrice,
        rateFactor: rateFactorForLine(l),
        inclusive: isTaxInclusive,
      }),
    [rateFactorForLine, isTaxInclusive],
  );

  const lineNet = useCallback((l: DetailLine) => amountsFor(l).net, [amountsFor]);
  const lineTax = useCallback((l: DetailLine) => amountsFor(l).tax, [amountsFor]);
  const lineGrand = useCallback((l: DetailLine) => amountsFor(l).grand, [amountsFor]);
  const totals = useMemo(() => {
    const all = lines.map(amountsFor);
    return {
      subTotal: sumTo2dp(all.map((a) => a.net)),
      totalTax: sumTo2dp(all.map((a) => a.tax)),
      grandTotal: sumTo2dp(all.map((a) => a.grand)),
    };
  }, [lines, amountsFor]);

  const addLine = () => setLines((ls) => [...ls, emptyLine()]);
  const removeLine = (key: string) =>
    setLines((ls) => (ls.length <= 1 ? ls : ls.filter((l) => l.key !== key)));
  const updateLine = useCallback((key: string, patch: Partial<DetailLine>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }, []);

  const stockById = useMemo(() => {
    const m = new Map<number, StockListRow>();
    for (const r of stocksQ.data ?? []) m.set(r.id, r);
    return m;
  }, [stocksQ.data]);
  const glById = useMemo(() => {
    const m = new Map<string, AccountCode>();
    for (const r of glAccountsQ.data ?? []) m.set(r.id, r);
    return m;
  }, [glAccountsQ.data]);

  // Fetch the Stock detail once per selected stockId to resolve the base
  // UOM's immutable ID (required by N3 PurchaseInvoiceDetailDto.uomId).
  const handleStockSelect = useCallback(
    async (line: DetailLine, opt: ComboOption | null) => {
      if (!opt) {
        updateLine(line.key, {
          stockId: null,
          stockCode: "",
          stockName: "",
          itemDescription: "",
          itemDescriptionTouched: false,
          uomId: null,
          uomCode: "",
          uomError: null,
        });
        return;
      }
      const id = Number(opt.value);
      const row = stockById.get(id);
      updateLine(line.key, {
        stockId: id,
        stockCode: row?.code ?? "",
        stockName: row?.name ?? "",
        itemDescription: row?.name ?? row?.description ?? "",
        itemDescriptionTouched: false,
        uomId: row?.matchedUomId ?? null,
        uomCode: row?.baseUOM ?? "",
        uomError: null,
      });
      try {
        const detail = await n3Call<StockDetail>(`api/Stocks/${id}`);
        const uoms = Array.isArray(detail?.uoms) ? detail.uoms : [];
        const base = uoms.find((u) => u.isBase) ?? uoms[0];
        if (base?.id != null) {
          updateLine(line.key, { uomId: base.id, uomCode: base.code ?? "", uomError: null });
        } else if (row?.matchedUomId == null) {
          updateLine(line.key, { uomError: "No default UOM configured in N3" });
        }
      } catch (err) {
        if (err instanceof N3Error && err.status === 401) return;
        updateLine(line.key, {
          uomError:
            err instanceof Error ? `UOM lookup failed: ${err.message}` : "UOM lookup failed",
        });
      }
    },
    [stockById, updateLine],
  );

  const handleGlSelect = (line: DetailLine, opt: ComboOption | null) => {
    if (!opt) {
      updateLine(line.key, { glAccountId: null, glAccountCode: "", glAccountName: "" });
      return;
    }
    const row = glById.get(opt.value);
    updateLine(line.key, {
      glAccountId: opt.value,
      glAccountCode: row?.code ?? "",
      glAccountName: row?.name ?? "",
    });
  };

  // ==================== Draft persistence (sessionStorage) ================
  // Save whenever anything the user typed/selected changes.
  useEffect(() => {
    if (save.status === "success") return; // do not resurrect a saved bill
    const draft: BillDraft = {
      schemaVersion: 1,
      savedAt: Date.now(),
      docDate,
      supplierId,
      supplierLabel: supplierLabel || supplierLabelDraft,
      purchaserId,
      purchaserLabel: purchaserLabel || purchaserLabelDraft,
      termId,
      termLabel: termLabel || termLabelDraft,
      termTouched,
      description,
      referenceNo: refNo,
      supplierInvNo,
      isTaxInclusive,
      lines: lines.map(
        (l): DraftLine => ({
          key: l.key,
          stockId: l.stockId,
          stockCode: l.stockCode,
          stockName: l.stockName,
          itemDescription: l.itemDescription,
          itemDescriptionTouched: l.itemDescriptionTouched,
          uomId: l.uomId,
          uomCode: l.uomCode,
          glAccountId: l.glAccountId,
          glAccountCode: l.glAccountCode,
          glAccountName: l.glAccountName,
          projectId: l.projectId,
          projectCode: l.projectCode,
          projectName: l.projectName,
          taxCodeId: l.taxCodeId,
          taxCodeCode: l.taxCodeCode,
          taxCodeName: l.taxCodeName,
          tariffCodeId: l.tariffCodeId,
          tariffCodeCode: l.tariffCodeCode,
          tariffCodeName: l.tariffCodeName,
          qty: l.qty,
          unitPrice: l.unitPrice,
          refNo: l.refNo,
        }),
      ),
    };
    saveDraft(draft);
  }, [
    docDate,
    supplierId,
    supplierLabel,
    supplierLabelDraft,
    purchaserId,
    purchaserLabel,
    purchaserLabelDraft,
    termId,
    termLabel,
    termLabelDraft,
    termTouched,
    description,
    refNo,
    supplierInvNo,
    isTaxInclusive,
    lines,
    save.status,
  ]);

  // If the auth scope shifts (tenant/user swap) while this page is mounted,
  // drop the old draft key we captured at mount so it doesn't linger.
  useEffect(() => {
    const check = () => {
      const now = draftStorageKey();
      if (now !== draftScopeAtMount.current) {
        try {
          window.sessionStorage.removeItem(draftScopeAtMount.current);
        } catch {
          /* ignore */
        }
        draftScopeAtMount.current = now;
      }
    };
    window.addEventListener("qne-auth-change", check);
    window.addEventListener("storage", check);
    return () => {
      window.removeEventListener("qne-auth-change", check);
      window.removeEventListener("storage", check);
    };
  }, []);

  const resetForm = useCallback(() => {
    clearDraft();
    setDocDate(todayISOInKL());
    setSupplierId(null);
    setSupplierLabelDraft("");
    setPurchaserId(null);
    setPurchaserLabelDraft("");
    setTermId(null);
    setTermLabelDraft("");
    setTermTouched(false);
    setDescription("");
    setRefNo("");
    setSupplierInvNo("");
    setIsTaxInclusive(false);
    setLines([emptyLine()]);
    setSave({ status: "idle" });
  }, []);

  const onReset = () => {
    if (window.confirm("Clear all entered values and start a new bill?")) resetForm();
  };

  // ==================== Save to N3 =========================================
  const savingRef = useRef(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [invalidFields, setInvalidFields] = useState<Set<string>>(() => new Set());

  // "Blocking reasons" — surfaced when validation fails, so the user knows why
  // save couldn't proceed. Never disables the button; always shown near it.
  const blockingReasons = useMemo(() => {
    const r: string[] = [];
    if (suppliersQ.isLoading) r.push("Loading Suppliers…");
    if (termsQ.isLoading) r.push("Loading Terms…");
    if (stocksQ.isLoading) r.push("Loading Stocks (WBS)…");
    if (glAccountsQ.isLoading) r.push("Loading GL Accounts…");
    if (projectsQ.isLoading) r.push("Loading Projects (Cost Centre)…");
    if (taxCodesQ.isLoading) r.push("Loading Tax Codes…");
    if (tariffCodesQ.isLoading) r.push("Loading Tariff Codes…");
    if (supplierId != null && supplierDetailQ.isFetching) r.push("Loading Supplier details…");
    for (const [i, l] of lines.entries()) {
      if (l.stockId != null && l.uomId == null && !l.uomError)
        r.push(`Item ${i + 1}: resolving default UOM from Stock detail…`);
    }
    return r;
  }, [
    suppliersQ.isLoading,
    termsQ.isLoading,
    stocksQ.isLoading,
    glAccountsQ.isLoading,
    projectsQ.isLoading,
    taxCodesQ.isLoading,
    tariffCodesQ.isLoading,
    supplierId,
    supplierDetailQ.isFetching,
    lines,
  ]);

  /**
   * Run header + line validation. Returns list of user-facing messages and
   * the ordered field-id list (used to focus the first invalid field). Never
   * touches state.
   */
  const runValidation = useCallback((): {
    errors: string[];
    invalidFields: string[];
  } => {
    const errors: string[] = [];
    const invalid: string[] = [];
    if (supplierId == null) {
      errors.push("Supplier is required.");
      invalid.push("supplier");
    }
    if (!docDate || !/^\d{4}-\d{2}-\d{2}$/.test(docDate)) {
      errors.push("Document Date is required.");
      invalid.push("docDate");
    }
    if (termId == null) {
      errors.push("Term is required.");
      invalid.push("term");
    }
    if (supplierInvNo.trim().length === 0) {
      errors.push("Supplier INV# is required.");
      invalid.push("supplierInvNo");
    }
    // A line is "empty" iff every selectable field is blank.
    const isFilled = (l: DetailLine) =>
      l.stockId != null ||
      l.glAccountId != null ||
      l.projectId != null ||
      l.taxCodeId != null ||
      l.tariffCodeId != null ||
      l.qty.trim() !== "" ||
      l.unitPrice.trim() !== "" ||
      l.itemDescription.trim() !== "";
    const filledLines = lines.filter(isFilled);
    if (filledLines.length === 0) {
      errors.push("Add at least one invoice line.");
      invalid.push(`line:${lines[0]?.key ?? ""}:wbs`);
    }
    for (const [i, l] of lines.entries()) {
      if (!isFilled(l)) continue;
      const push = (id: FieldId, msg: string) => {
        errors.push(`Item ${i + 1}: ${msg}`);
        invalid.push(`line:${l.key}:${id}`);
      };
      if (l.stockId == null) push("wbs", "WBS is required.");
      else if (l.uomId == null) push("wbs", l.uomError ?? "Default UOM is still loading.");
      if (!l.itemDescription.trim()) push("itemDescription", "Item Description is required.");
      if (l.glAccountId == null) push("glAccount", "GL Account is required.");
      if (l.projectId == null) push("costCentre", "Cost Centre is required.");
      if (l.taxCodeId == null) push("hqTax", "HQ Tax is required.");
      if (l.tariffCodeId == null) push("orderNo", "Order No. / Tariff is required.");
      if (!(Number(l.qty) > 0)) push("qty", "Qty must be greater than 0.");
      if (!(Number(l.unitPrice) >= 0)) push("unitPrice", "Unit Price must be ≥ 0.");
    }
    return { errors, invalidFields: invalid };
  }, [supplierId, docDate, termId, supplierInvNo, lines]);

  const focusField = useCallback((id: string) => {
    if (typeof document === "undefined") return;
    const el = document.querySelector<HTMLElement>(`[data-field="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    // Prefer the first focusable child; fall back to the container.
    const focusable = el.querySelector<HTMLElement>(
      'input:not([readonly]):not([disabled]), button:not([disabled]), [role="combobox"], [role="searchbox"]',
    );
    (focusable ?? el).focus?.();
  }, []);

  const onSave = async () => {
    if (savingRef.current || save.status === "saving") return;

    // Always run validation regardless of button state so users get a specific
    // reason instead of a silently disabled button.
    const { errors, invalidFields: bad } = runValidation();
    if (errors.length > 0) {
      setValidationErrors(errors);
      setInvalidFields(new Set(bad));
      setSave({ status: "idle" });
      if (bad[0]) requestAnimationFrame(() => focusField(bad[0]));
      return;
    }
    setValidationErrors([]);
    setInvalidFields(new Set());

    savingRef.current = true;
    setSave({ status: "saving" });
    try {
      const t = getToken();
      if (!t) {
        setSave({ status: "error", message: "Session expired — please sign in again." });
        savingRef.current = false;
        return;
      }
      const body = {
        header: {
          supplierId,
          docDate,
          termId,
          purchaserId,
          description,
          referenceNo: refNo,
          supplierInvNo: supplierInvNo.trim(),
          isTaxInclusive,
        },
        lines: lines.map((l) => ({
          stockId: l.stockId,
          uomId: l.uomId,
          glAccountId: l.glAccountId,
          projectId: l.projectId,
          taxCodeId: l.taxCodeId,
          tariffCodeId: l.tariffCodeId,
          description: l.itemDescription,
          qty: Number(l.qty),
          unitPrice: Number(l.unitPrice),
          // Rate factor from N3 TaxCodeLookupDto.rate (0.05 for PT-5%). Server
          // re-validates and mirrors the calculation before POST.
          taxRateFactor: rateFactorForLine(l),
          referenceNo: l.refNo,
        })),
      };
      const res = await fetch("/api/bills/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify(body),
      });
      const data: unknown = await res.json().catch(() => null);
      const d = (data ?? {}) as {
        ok?: boolean;
        docCode?: string;
        error?: string;
        kind?: string;
      };
      if (res.ok && d.ok && d.docCode) {
        clearDraft();
        // Invalidate History cache so the new invoice appears immediately.
        try {
          queryClient.invalidateQueries({ queryKey: HISTORY_QUERY_KEY });
        } catch {
          /* best effort */
        }
        setSave({ status: "success", docCode: d.docCode, message: "Saved to N3" });
      } else {
        setSave({
          status: "error",
          message: d.error || `N3 rejected the request (${res.status})`,
        });
      }
    } catch (err) {
      setSave({
        status: "error",
        message:
          err instanceof Error
            ? `Network error: ${err.message}. If unsure, verify in N3 before retrying.`
            : "Network error.",
      });
    } finally {
      savingRef.current = false;
    }
  };

  if (save.status === "success" && save.docCode) {
    return <SuccessPanel docCode={save.docCode} onNew={resetForm} navigate={navigate} />;
  }

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
          <button
            type="button"
            className="app-btn"
            onClick={onReset}
            disabled={save.status === "saving"}
          >
            Reset
          </button>
          <button
            type="button"
            disabled={save.status === "saving"}
            onClick={onSave}
            className="app-btn app-btn-primary disabled:cursor-not-allowed disabled:opacity-60"
            title="Post the Purchase Invoice to N3"
          >
            {save.status === "saving" ? "Saving…" : "Save to N3"}
          </button>
        </div>
      </div>

      {validationErrors.length > 0 && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
          aria-live="assertive"
        >
          <strong>Please fix these before saving:</strong>
          <ul className="ml-5 mt-1 list-disc">
            {validationErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {validationErrors.length > 0 && blockingReasons.length > 0 && (
        <div
          className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
          role="status"
        >
          <strong>Still loading:</strong> {blockingReasons.join(" · ")}
        </div>
      )}

      {save.status === "error" && save.message && (
        <div
          className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          <div>
            <strong>Save failed:</strong> {save.message}
          </div>
          <button type="button" className="app-btn" onClick={() => setSave({ status: "idle" })}>
            Dismiss
          </button>
        </div>
      )}

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
            <input
              className="app-input bg-muted text-muted-foreground"
              readOnly
              value="Assigned on save"
            />
          </div>
          <div data-field="docDate">
            <label className="app-label" htmlFor="doc-date">
              Document Date <span className="text-destructive">*</span>
            </label>
            <MyDateInput
              id="doc-date"
              value={docDate}
              onChange={setDocDate}
              ariaLabel="Document Date"
              required
            />
          </div>
          <div data-field="supplier">
            <label className="app-label">Supplier</label>
            <SearchableSelect
              options={supplierOptions}
              value={supplierId != null ? String(supplierId) : null}
              selectedLabel={supplierLabel}
              onChange={(o) => {
                setSupplierId(o ? Number(o.value) : null);
                setSupplierLabelDraft(o?.label ?? "");
              }}
              loading={suppliersQ.isLoading}
              placeholder={suppliersQ.isLoading ? "Loading suppliers…" : "Search by code or name"}
              ariaLabel="Supplier"
              popoverPortal
              withPopoverSearch
              minPopoverWidth={650}
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
              selectedLabel={purchaserLabel}
              onChange={(o) => {
                setPurchaserId(o ? Number(o.value) : null);
                setPurchaserLabelDraft(o?.label ?? "");
              }}
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
          <div data-field="term">
            <label className="app-label">
              Term <span className="text-destructive">*</span>
            </label>
            <SearchableSelect
              options={termOptions}
              value={termId != null ? String(termId) : null}
              selectedLabel={termLabel}
              onChange={(o) => {
                setTermTouched(true);
                setTermId(o ? Number(o.value) : null);
                setTermLabelDraft(o?.label ?? "");
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
            <input className="app-input" value={refNo} onChange={(e) => setRefNo(e.target.value)} />
          </div>
          <div data-field="supplierInvNo">
            <label className="app-label" htmlFor="supplier-inv-no">
              Supplier INV# <span className="text-destructive">*</span>
            </label>
            <input
              id="supplier-inv-no"
              required
              className={`app-input ${invalidFields.has("supplierInvNo") ? "ring-2 ring-destructive/60" : ""}`}
              value={supplierInvNo}
              onChange={(e) => setSupplierInvNo(e.target.value)}
              placeholder="Duplicate check runs on save"
              aria-invalid={invalidFields.has("supplierInvNo") || undefined}
            />
          </div>

          <div className="md:col-span-3 mt-1 flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2">
            <label
              className="inline-flex cursor-pointer select-none items-center gap-2"
              htmlFor="tax-inclusive"
            >
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
        totals={totals}
        lineNet={lineNet}
        lineTax={lineTax}
        invalidFields={invalidFields}
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

function SuccessPanel({
  docCode,
  onNew,
  navigate,
}: {
  docCode: string;
  onNew: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <div className="app-card mx-auto max-w-xl p-6 text-center">
      <div
        className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-success/10 text-success"
        aria-hidden
      >
        ✓
      </div>
      <h1 className="text-lg font-semibold">Purchase Invoice created in N3</h1>
      <p className="mt-2 text-sm text-muted-foreground">N3 assigned document number</p>
      <p className="mt-1 text-2xl font-semibold tabular tracking-tight">{docCode}</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <button type="button" className="app-btn app-btn-primary" onClick={onNew}>
          Create Another Bill
        </button>
        <button
          type="button"
          className="app-btn"
          onClick={() => navigate({ to: "/history", search: { q: docCode } })}
        >
          View in History
        </button>
      </div>
    </div>
  );
}

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
      const v =
        (c as { value?: unknown; email?: unknown }).value ?? (c as { email?: unknown }).email;
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
    err instanceof N3Error ? err.message : err instanceof Error ? err.message : "Request failed";
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

// ============================== Line list ==============================

interface LineCtx {
  stockOptions: ComboOption[];
  stocksLoading: boolean;
  glOptions: ComboOption[];
  glLoading: boolean;
  projectOptions: ComboOption[];
  projectsLoading: boolean;
  taxOptions: ComboOption[];
  taxLoading: boolean;
  tariffOptions: ComboOption[];
  tariffLoading: boolean;
  tariffHasError: boolean;
  onStockSelect: (line: DetailLine, opt: ComboOption | null) => void;
  onGlSelect: (line: DetailLine, opt: ComboOption | null) => void;
  onChange: (key: string, patch: Partial<DetailLine>) => void;
  lineNet: (l: DetailLine) => number;
  lineTax: (l: DetailLine) => number;
  invalidFields: Set<string>;
}

function LineList({
  lines,
  layout,
  onAdd,
  onRemove,
  totals,
  ...ctx
}: LineCtx & {
  lines: DetailLine[];
  layout: ItemLayout;
  onAdd: () => void;
  onRemove: (key: string) => void;
  totals: { subTotal: number; totalTax: number; grandTotal: number };
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
            Two-row card · configure fields in{" "}
            <a className="underline" href="/settings">
              Settings
            </a>{" "}
            · Enter advances field / creates line · Net = Qty × Unit Price
          </p>
        </div>
        <button type="button" className="app-btn" onClick={onAdd}>
          + Add line
        </button>
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

      <div className="border-t-2 border-border-strong bg-surface-2 px-4 py-3">
        <div className="ml-auto flex max-w-md flex-col gap-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              Sub Total (MYR)
            </span>
            <span className="tabular">{formatMoney(totals.subTotal)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase text-muted-foreground">
              Total Tax (MYR)
            </span>
            <span className="tabular">{formatMoney(totals.totalTax)}</span>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-border pt-1">
            <span className="text-xs font-bold uppercase">Grand Total (MYR)</span>
            <span className="tabular text-base font-semibold">
              {formatMoney(totals.grandTotal)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function LineCard({
  line,
  index,
  layout,
  onRemove,
  canRemove,
  ...ctx
}: LineCtx & {
  line: DetailLine;
  index: number;
  layout: ItemLayout;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const anyFilled =
    line.stockId != null ||
    line.glAccountId != null ||
    line.projectId != null ||
    line.taxCodeId != null ||
    line.tariffCodeId != null ||
    line.qty.trim() !== "" ||
    line.unitPrice.trim() !== "";

  const errorFor = (id: FieldId): string | null => {
    if (!anyFilled) return null;
    switch (id) {
      case "wbs":
        return line.stockId == null ? "WBS required" : line.uomError;
      case "glAccount":
        return line.glAccountId == null ? "GL required" : null;
      case "costCentre":
        return line.projectId == null ? "Cost Centre required" : null;
      case "hqTax":
        return line.taxCodeId == null ? "Tax required" : null;
      case "orderNo":
        return line.tariffCodeId == null ? "Tariff required" : null;
      case "qty":
        return Number(line.qty) > 0 ? null : "Qty > 0";
      case "unitPrice":
        return Number(line.unitPrice) >= 0 ? null : "Price ≥ 0";
      default:
        return null;
    }
  };

  const renderField = (id: FieldId) => (
    <FieldCell key={id} id={id} line={line} index={index} error={errorFor(id)} {...ctx} />
  );

  // Alternating card palette. Colour is a secondary cue; every card also has
  // an explicit "Item N" header + numeric badge so users don't rely on colour.
  const palette = [
    { bg: "bg-[#f8fbff]", border: "border-l-4 border-l-sky-400", badge: "bg-sky-100 text-sky-800" },
    {
      bg: "bg-[#f6fbf7]",
      border: "border-l-4 border-l-emerald-400",
      badge: "bg-emerald-100 text-emerald-800",
    },
    {
      bg: "bg-[#fffaf3]",
      border: "border-l-4 border-l-amber-400",
      badge: "bg-amber-100 text-amber-800",
    },
    {
      bg: "bg-[#fbf7ff]",
      border: "border-l-4 border-l-violet-400",
      badge: "bg-violet-100 text-violet-800",
    },
  ];
  const tone = palette[index % palette.length];

  return (
    <div
      data-line-row
      className={`grid-row-focus rounded-lg border border-border ${tone.border} ${tone.bg}`}
    >
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <span
          className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-semibold tabular ${tone.badge}`}
        >
          Item {index + 1}
        </span>
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

function RowRow({ ids, render }: { ids: FieldId[]; render: (id: FieldId) => React.ReactNode }) {
  return <div className="flex flex-wrap gap-2">{ids.map((id) => render(id))}</div>;
}

function FieldCell({
  id,
  line,
  index,
  error,
  ...ctx
}: LineCtx & { id: FieldId; line: DetailLine; index: number; error: string | null }) {
  const readOnly = READONLY_FIELDS.has(id);
  const wideClass = "min-w-[220px] flex-[2_1_220px]";
  const medClass = "min-w-[180px] flex-[1.5_1_180px]";
  const narrowClass = "min-w-[110px] flex-1";

  const fieldKey = `line:${line.key}:${id}`;
  const isInvalid = ctx.invalidFields.has(fieldKey);

  const wrap = (widthClass: string, content: React.ReactNode) => (
    <div
      className={`${widthClass} ${isInvalid ? "rounded-md ring-2 ring-destructive/60 ring-offset-1" : ""}`}
      data-field={fieldKey}
    >
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
      return wrap(
        medClass,
        <SearchableSelect
          compact
          popoverPortal
          withPopoverSearch
          minPopoverWidth={750}
          options={ctx.stockOptions}
          loading={ctx.stocksLoading}
          value={line.stockId != null ? String(line.stockId) : null}
          selectedLabel={line.stockId ? `${line.stockCode} — ${line.stockName}`.trim() : ""}
          onChange={(o) => ctx.onStockSelect(line, o)}
          placeholder={ctx.stocksLoading ? "Loading…" : "Select WBS"}
          ariaLabel={`WBS line ${index + 1}`}
        />,
      );
    case "itemDescription":
      return wrap(
        wideClass,
        <input
          className="app-input h-8 px-2 py-1 text-[13px]"
          value={line.itemDescription}
          onChange={(e) =>
            onChange(line.key, {
              itemDescription: e.target.value,
              itemDescriptionTouched: true,
            })
          }
          aria-label={`Item Description line ${index + 1}`}
          placeholder={line.stockId ? "" : "Select WBS to default"}
        />,
      );
    case "glAccount":
      return wrap(
        medClass,
        <SearchableSelect
          compact
          popoverPortal
          withPopoverSearch
          minPopoverWidth={600}
          options={ctx.glOptions}
          loading={ctx.glLoading}
          value={line.glAccountId ?? null}
          selectedLabel={
            line.glAccountId ? `${line.glAccountCode} — ${line.glAccountName}`.trim() : ""
          }
          onChange={(o) => ctx.onGlSelect(line, o)}
          placeholder={ctx.glLoading ? "Loading…" : "Select GL"}
          ariaLabel={`GL Account line ${index + 1}`}
        />,
      );
    case "glAccountName":
      return wrap(
        wideClass,
        <input
          readOnly
          tabIndex={-1}
          className="app-input h-8 px-2 py-1 text-[13px] bg-muted"
          value={line.glAccountName}
          aria-label={`GL Account Name line ${index + 1}`}
        />,
      );
    case "costCentre":
      return wrap(
        medClass,
        <SearchableSelect
          compact
          popoverPortal
          withPopoverSearch
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
              projectId: Number(o.value),
              projectCode: code ?? "",
              projectName: rest.join(" — "),
            });
          }}
          placeholder={ctx.projectsLoading ? "Loading…" : "Select Cost Centre"}
          ariaLabel={`Cost Centre line ${index + 1}`}
        />,
      );
    case "hqTax":
      return wrap(
        medClass,
        <SearchableSelect
          compact
          popoverPortal
          withPopoverSearch
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
              taxCodeId: Number(o.value),
              taxCodeCode: code ?? "",
              taxCodeName: rest.join(" — "),
            });
          }}
          placeholder={ctx.taxLoading ? "Loading…" : "Select Tax"}
          ariaLabel={`HQ Tax line ${index + 1}`}
        />,
      );
    case "orderNo": {
      const tariffEmpty =
        !ctx.tariffLoading && !ctx.tariffHasError && ctx.tariffOptions.length === 0;
      return wrap(
        medClass,
        <>
          <SearchableSelect
            compact
            popoverPortal
            withPopoverSearch
            options={ctx.tariffOptions}
            loading={ctx.tariffLoading}
            value={line.tariffCodeId != null ? String(line.tariffCodeId) : null}
            selectedLabel={
              line.tariffCodeId ? `${line.tariffCodeCode} — ${line.tariffCodeName}`.trim() : ""
            }
            onChange={(o) => {
              if (!o) {
                onChange(line.key, { tariffCodeId: null, tariffCodeCode: "", tariffCodeName: "" });
                return;
              }
              const [code, ...rest] = o.label.split(" — ");
              onChange(line.key, {
                tariffCodeId: Number(o.value),
                tariffCodeCode: code ?? "",
                tariffCodeName: rest.join(" — "),
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
        </>,
      );
    }
    case "qty":
      return wrap(
        narrowClass,
        <input
          className="app-input h-8 px-2 py-1 text-[13px] tabular text-right"
          inputMode="decimal"
          value={line.qty}
          onChange={(e) => onChange(line.key, { qty: e.target.value })}
          aria-label={`Qty line ${index + 1}`}
        />,
      );
    case "unitPrice":
      return wrap(
        narrowClass,
        <input
          className="app-input h-8 px-2 py-1 text-[13px] tabular text-right"
          inputMode="decimal"
          value={line.unitPrice}
          onChange={(e) => onChange(line.key, { unitPrice: e.target.value })}
          aria-label={`Unit Price line ${index + 1}`}
        />,
      );
    case "netAmount":
      return wrap(
        narrowClass,
        <input
          readOnly
          tabIndex={-1}
          className="app-input h-8 px-2 py-1 text-[13px] tabular text-right bg-muted"
          value={formatMoney(ctx.lineNet(line))}
          aria-label={`Net Amount line ${index + 1}`}
        />,
      );
    case "taxAmount":
      return wrap(
        narrowClass,
        <input
          readOnly
          tabIndex={-1}
          className="app-input h-8 px-2 py-1 text-[13px] tabular text-right bg-muted"
          value={formatMoney(ctx.lineTax(line))}
          aria-label={`Tax Amount line ${index + 1}`}
        />,
      );
    case "refNo":
      return wrap(
        narrowClass,
        <input
          className="app-input h-8 px-2 py-1 text-[13px]"
          value={line.refNo}
          onChange={(e) => onChange(line.key, { refNo: e.target.value })}
          aria-label={`Ref No line ${index + 1}`}
        />,
      );

    default: {
      const _: never = id;
      void _;
      void readOnly;
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
