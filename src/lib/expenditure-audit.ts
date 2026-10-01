import { round2, sumTo2dp } from "./money";
import type { PurchaseAuditResult } from "./audit-trail";
import type { ReportData } from "./report-model";

export interface ExpenditureAuditRow {
  docCode: string;
  docDate: string;
  vendorAccount: string;
  vendorName: string;
  expenditureType: string;
  costCentre: string;
  chargedToAccount: string;
  description: string;
  amount: number;
  pos: number;
}

export interface ExpenditurePostingSummaryRow {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

const LEGACY_CREDITOR_CODES: Record<string, string> = {
  "800-2002": "800-R023",
  "800-H006": "800-H024",
};

/**
 * Display-only legacy creditor aliases requested for the client's
 * Expenditure Audit Trail. N3 values and posting contracts are never changed.
 */
export function expenditureVendorAccount(code: string): string {
  const trimmed = code.trim();
  return LEGACY_CREDITOR_CODES[trimmed.toUpperCase()] ?? trimmed;
}

/**
 * The client's current transactions are tax-free. The expenditure amount is
 * therefore the persisted N3 before-tax line amount. Tax treatment is
 * deliberately not customized here; future taxable transactions require a
 * separate authorized change.
 */
export function buildExpenditureAuditRows(report: ReportData): ExpenditureAuditRow[] {
  return report.lines
    .filter((line) => !line.isCancelled)
    .map((line) => ({
      docCode: line.docCode,
      docDate: line.docDate,
      vendorAccount: expenditureVendorAccount(line.supplierCode),
      vendorName: line.supplierName,
      expenditureType: line.glAccountCode,
      costCentre: line.projectCode,
      chargedToAccount: line.glAccountName,
      description: line.itemDescription || line.hqSequence,
      amount: round2(line.beforeTax),
      pos: line.pos,
    }))
    .sort(
      (a, b) =>
        a.docDate.localeCompare(b.docDate) ||
        a.docCode.localeCompare(b.docCode) ||
        a.pos - b.pos,
    );
}

export function expenditureGrandTotal(rows: ExpenditureAuditRow[]): number {
  return sumTo2dp(rows.map((row) => row.amount));
}

/**
 * Old-system style "Summary of Posting Account":
 *   - debit side: expenditure GL + Cost Centre, e.g. 501203-50000028
 *   - credit side: supplier control account, using display-only legacy aliases
 *
 * The credit side comes from the reconciled N3 GL audit result rather than
 * being synthesized from invoice amounts.
 */
export function buildExpenditurePostingSummary(
  rows: ExpenditureAuditRow[],
  audit: PurchaseAuditResult | null,
): ExpenditurePostingSummaryRow[] {
  const map = new Map<string, ExpenditurePostingSummaryRow>();

  for (const row of rows) {
    const accountCode = [row.expenditureType, row.costCentre].filter(Boolean).join("-");
    const key = `D:${accountCode}`;
    const existing = map.get(key);
    if (existing) {
      existing.debit = round2(existing.debit + row.amount);
    } else {
      map.set(key, {
        accountCode,
        accountName: row.chargedToAccount,
        debit: row.amount,
        credit: 0,
      });
    }
  }

  for (const doc of audit?.documents ?? []) {
    if (!doc.creditor) continue;
    const accountCode = expenditureVendorAccount(doc.creditor.accountCode || doc.supplierCode);
    const key = `C:${accountCode}`;
    const existing = map.get(key);
    if (existing) {
      existing.debit = round2(existing.debit + doc.creditor.debit);
      existing.credit = round2(existing.credit + doc.creditor.credit);
    } else {
      map.set(key, {
        accountCode,
        accountName: doc.creditor.accountName || doc.supplierName,
        debit: round2(doc.creditor.debit),
        credit: round2(doc.creditor.credit),
      });
    }
  }

  return [...map.values()].sort((a, b) => {
    const aCredit = Math.abs(a.credit) > 0.0001;
    const bCredit = Math.abs(b.credit) > 0.0001;
    if (aCredit !== bCredit) return aCredit ? 1 : -1;
    return a.accountCode.localeCompare(b.accountCode);
  });
}

export function expenditurePostingTotals(rows: ExpenditurePostingSummaryRow[]): {
  debit: number;
  credit: number;
} {
  return {
    debit: sumTo2dp(rows.map((row) => row.debit)),
    credit: sumTo2dp(rows.map((row) => row.credit)),
  };
}
