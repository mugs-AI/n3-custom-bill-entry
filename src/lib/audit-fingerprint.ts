// Phase 3B Correction E — deterministic Purchase Audit cache fingerprint.
//
// The audit query cache key must change whenever any relevant Purchase
// Invoice or accounting amount changes, so a different set of invoices with
// the same count can never reuse the wrong audit result.
//
// The fingerprint is a stable JSON of canonicalised (docCode/supplierCode/
// accountCode uppercased+trimmed, dates sliced to yyyy-mm-dd, amounts rounded
// to 2dp) tuples sorted so line reordering alone never triggers a false
// change. Never expose secrets — only accounting fields go in.

import type { ReportData } from "./report-model";
import { canonicalAccountCode, canonicalDocCode } from "./report-keys";
import { round2 } from "./money";

function normDate(v: string | undefined): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, 10);
}

interface FpInvoice {
  invoiceId: string;
  docCode: string;
  docDate: string;
  supplierInvNo: string;
  supplierCode: string;
  lines: Array<{
    glAccountCode: string;
    taxCodeId: number | null;
    beforeTax: number;
    taxAmount: number;
    includingTax: number;
  }>;
}

export function computeAuditFingerprint(report: ReportData | null | undefined): string {
  if (!report) return "empty";
  const byInvoice = new Map<string, FpInvoice>();
  for (const l of report.lines) {
    const invoiceId = l.invoiceId || "";
    const docKey = canonicalDocCode(l.docCode);
    const key = invoiceId || docKey || "unknown";
    let inv = byInvoice.get(key);
    if (!inv) {
      inv = {
        invoiceId,
        docCode: docKey,
        docDate: normDate(l.docDate),
        supplierInvNo: canonicalDocCode(l.supplierInvNo),
        supplierCode: canonicalAccountCode(l.supplierCode),
        lines: [],
      };
      byInvoice.set(key, inv);
    }
    inv.lines.push({
      glAccountCode: canonicalAccountCode(l.glAccountCode),
      taxCodeId: typeof l.taxCodeId === "number" ? l.taxCodeId : null,
      beforeTax: round2(l.beforeTax),
      taxAmount: round2(l.taxAmount),
      includingTax: round2(l.includingTax),
    });
  }
  const invoices = [...byInvoice.values()];
  for (const inv of invoices) {
    inv.lines.sort((a, b) => {
      if (a.glAccountCode !== b.glAccountCode)
        return a.glAccountCode.localeCompare(b.glAccountCode);
      if (a.beforeTax !== b.beforeTax) return a.beforeTax - b.beforeTax;
      if (a.taxAmount !== b.taxAmount) return a.taxAmount - b.taxAmount;
      if (a.includingTax !== b.includingTax) return a.includingTax - b.includingTax;
      return (a.taxCodeId ?? -1) - (b.taxCodeId ?? -1);
    });
  }
  invoices.sort(
    (a, b) =>
      a.docCode.localeCompare(b.docCode) || a.invoiceId.localeCompare(b.invoiceId),
  );
  return JSON.stringify(invoices);
}
