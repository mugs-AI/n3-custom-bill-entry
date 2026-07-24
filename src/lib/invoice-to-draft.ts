// Transform a live N3 PurchaseInvoiceDto response into the shape BillForm
// consumes. Extra `n3Id` is preserved on the header and each detail line so
// the Update endpoint can match rows back to server-side records.
//
// This module owns *only* the shape mapping. Master-data enrichment (WBS,
// UOM, GL Account names, etc.) is done by the form's own lookup queries so
// this file has no side effects and no network calls.

import type { BillDraft, DraftLine } from "./draft-store";
import { DRAFT_SCHEMA_VERSION } from "./draft-store";

export interface RawInvoiceLine {
  id?: string | null;
  pos?: number;
  stockId?: number | null;
  stock?: { id?: number; code?: string; name?: string; description?: string } | null;
  uomId?: number | null;
  uom?: { id?: number; code?: string } | null;
  accountId?: string | null;
  account?: { id?: string; code?: string; name?: string } | null;
  projectId?: number | null;
  project?: { id?: number; code?: string; name?: string } | null;
  taxCodeId?: number | null;
  taxCode?: { id?: number; code?: string; fullName?: string; name?: string } | null;
  tariffCodeId?: number | null;
  tariffCode?: { id?: number; code?: string; description?: string } | null;
  description?: string;
  qty?: number;
  unitPrice?: number;
  referenceNo?: string;
}

export interface RawInvoice {
  id?: string;
  docCode?: string;
  docDate?: string;
  supplierId?: number | null;
  supplier?: { id?: number; code?: string; name?: string } | null;
  purchaserId?: number | null;
  purchaser?: { id?: number; code?: string; name?: string } | null;
  termId?: number | null;
  term?: { id?: number; code?: string; description?: string } | null;
  description?: string;
  referenceNo?: string;
  supplierInvNo?: string;
  isTaxInclusive?: boolean;
  itemDetails?: RawInvoiceLine[];
  details?: RawInvoiceLine[];
}

function joinLabel(code: string | undefined | null, name: string | undefined | null): string {
  const c = (code ?? "").trim();
  const n = (name ?? "").trim();
  if (c && n) return `${c} — ${n}`;
  return c || n || "";
}

function toStr(n: number | undefined | null): string {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "";
}

export function invoiceToDraft(raw: RawInvoice): BillDraft {
  const details = raw.itemDetails ?? raw.details ?? [];
  const lines: DraftLine[] = details.map((d, i) => {
    const stockId = d.stockId ?? d.stock?.id ?? null;
    const uomId = d.uomId ?? d.uom?.id ?? null;
    const accountId = d.accountId ?? d.account?.id ?? null;
    const projectId = d.projectId ?? d.project?.id ?? null;
    const taxCodeId = d.taxCodeId ?? d.taxCode?.id ?? null;
    const tariffCodeId = d.tariffCodeId ?? d.tariffCode?.id ?? null;
    return {
      key:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `line-${i}-${Date.now()}`,
      n3Id: d.id ?? null,
      stockId,
      stockCode: d.stock?.code ?? "",
      stockName: d.stock?.name ?? d.stock?.description ?? "",
      itemDescription: d.description ?? "",
      itemDescriptionTouched: true, // preserve as-typed
      uomId,
      uomCode: d.uom?.code ?? "",
      glAccountId: accountId,
      glAccountCode: d.account?.code ?? "",
      glAccountName: d.account?.name ?? "",
      projectId,
      projectCode: d.project?.code ?? "",
      projectName: d.project?.name ?? "",
      taxCodeId,
      taxCodeCode: d.taxCode?.code ?? "",
      taxCodeName: d.taxCode?.fullName ?? d.taxCode?.name ?? "",
      tariffCodeId,
      tariffCodeCode: d.tariffCode?.code ?? "",
      tariffCodeName: d.tariffCode?.description ?? "",
      qty: toStr(d.qty),
      unitPrice: toStr(d.unitPrice),
      refNo: d.referenceNo ?? "",
    };
  });
  const docDateIso =
    typeof raw.docDate === "string" && raw.docDate.length >= 10 ? raw.docDate.slice(0, 10) : "";
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    savedAt: Date.now(),
    invoiceId: raw.id ?? null,
    docCode: raw.docCode ?? null,
    docDate: docDateIso,
    supplierId: raw.supplierId ?? raw.supplier?.id ?? null,
    supplierLabel: joinLabel(raw.supplier?.code, raw.supplier?.name),
    purchaserId: raw.purchaserId ?? raw.purchaser?.id ?? null,
    purchaserLabel: joinLabel(raw.purchaser?.code, raw.purchaser?.name),
    termId: raw.termId ?? raw.term?.id ?? null,
    termLabel: joinLabel(raw.term?.code, raw.term?.description),
    termTouched: true, // loaded value wins over supplier default
    description: raw.description ?? "",
    referenceNo: raw.referenceNo ?? "",
    supplierInvNo: raw.supplierInvNo ?? "",
    isTaxInclusive: !!raw.isTaxInclusive,
    lines: lines.length > 0 ? lines : [],
  };
}
