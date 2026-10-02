import { round2, sumTo2dp } from "./money";
import type { PurchaseAuditResult } from "./audit-trail";
import type { ReportData } from "./report-model";

export const AEAT_EXCEL_COLUMNS = [
  "G/L Account (10)",
  "Item Text (50)",
  "Debit",
  "Credit",
  "Tax Code (2)",
  "Jurisdiction",
  "Cost Center (10)",
  "Profit Center (10)",
  "Order Number (12)",
  "WBS Element (24)",
] as const;

export interface AdvancedExpenditureAuditRow {
  glAccount: string;
  itemText: string;
  debit: number;
  credit: number;
  taxCode: string;
  jurisdiction: string;
  costCenter: string;
  profitCenter: string;
  orderNumber: string;
  wbsElement: string;
}

function rowKey(parts: string[]): string {
  return parts.map((x) => x.trim()).join("\u001f");
}

function debitRows(report: ReportData): AdvancedExpenditureAuditRow[] {
  const map = new Map<string, AdvancedExpenditureAuditRow>();
  for (const line of report.lines) {
    if (line.isCancelled) continue;
    const glAccount = line.glAccountCode.trim();
    const itemText = line.itemDescription.trim();
    const taxCode = line.taxCodeCode.trim();
    const costCenter = line.projectCode.trim();
    const wbsElement = line.stockCode.trim();

    // AEAT grouping is intentionally more granular than EAT1. The same GL
    // account remains separate when Item Text, Cost Centre, WBS or Tax Code
    // differs. This covers A-NIL as a distinct Cost Centre value.
    const key = rowKey([glAccount, itemText, costCenter, wbsElement, taxCode]);
    const existing = map.get(key);
    if (existing) {
      existing.debit = round2(existing.debit + line.beforeTax);
      continue;
    }
    map.set(key, {
      glAccount,
      itemText,
      debit: round2(line.beforeTax),
      credit: 0,
      taxCode,
      jurisdiction: "",
      costCenter,
      profitCenter: costCenter,
      orderNumber: "",
      wbsElement,
    });
  }
  return [...map.values()].sort(
    (a, b) =>
      a.glAccount.localeCompare(b.glAccount, undefined, { numeric: true }) ||
      a.itemText.localeCompare(b.itemText) ||
      a.costCenter.localeCompare(b.costCenter) ||
      a.wbsElement.localeCompare(b.wbsElement) ||
      a.taxCode.localeCompare(b.taxCode),
  );
}

function creditRows(
  report: ReportData,
  audit: PurchaseAuditResult | null,
): AdvancedExpenditureAuditRow[] {
  if (!audit) return [];

  const taxCodesByInvoice = new Map<string, Set<string>>();
  for (const line of report.lines) {
    if (line.isCancelled) continue;
    const code = line.taxCodeCode.trim();
    if (!code) continue;
    const set = taxCodesByInvoice.get(line.invoiceId) ?? new Set<string>();
    set.add(code);
    taxCodesByInvoice.set(line.invoiceId, set);
  }

  const map = new Map<string, AdvancedExpenditureAuditRow & { taxCodes: Set<string> }>();
  for (const doc of audit.documents) {
    if (!doc.creditor) continue;
    const glAccount = (doc.creditor.accountCode || doc.supplierCode).trim();
    const itemText = (doc.creditor.accountName || doc.supplierName).trim();
    const key = rowKey([glAccount, itemText]);
    const existing =
      map.get(key) ??
      {
        glAccount,
        itemText,
        debit: 0,
        credit: 0,
        taxCode: "",
        jurisdiction: "",
        costCenter: "",
        profitCenter: "",
        orderNumber: "",
        wbsElement: "",
        taxCodes: new Set<string>(),
      };

    existing.debit = round2(existing.debit + doc.creditor.debit);
    existing.credit = round2(existing.credit + doc.creditor.credit);
    for (const code of taxCodesByInvoice.get(doc.invoiceId) ?? []) existing.taxCodes.add(code);
    map.set(key, existing);
  }

  return [...map.values()]
    .map(({ taxCodes, ...row }) => ({
      ...row,
      taxCode: taxCodes.size === 1 ? [...taxCodes][0] : "",
    }))
    .sort((a, b) => a.glAccount.localeCompare(b.glAccount, undefined, { numeric: true }));
}

export function buildAdvancedExpenditureAuditRows(
  report: ReportData,
  audit: PurchaseAuditResult | null,
): AdvancedExpenditureAuditRow[] {
  return [...debitRows(report), ...creditRows(report, audit)];
}

export function advancedExpenditureTotals(rows: AdvancedExpenditureAuditRow[]): {
  debit: number;
  credit: number;
} {
  return {
    debit: sumTo2dp(rows.map((r) => r.debit)),
    credit: sumTo2dp(rows.map((r) => r.credit)),
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function excelCell(value: string | number, type: "String" | "Number"): string {
  const data = type === "Number" ? String(value) : xmlEscape(String(value));
  return `<Cell><Data ss:Type="${type}">${data}</Data></Cell>`;
}

/**
 * Dependency-free SpreadsheetML workbook. Excel opens this directly and the
 * worksheet contains exactly the 10 client-required AEAT columns.
 */
export function buildAdvancedExpenditureExcelXml(
  rows: AdvancedExpenditureAuditRow[],
): string {
  const header = AEAT_EXCEL_COLUMNS.map((h) => excelCell(h, "String")).join("");
  const body = rows
    .map((r) => {
      const values: Array<[string | number, "String" | "Number"]> = [
        [r.glAccount, "String"],
        [r.itemText, "String"],
        [r.debit || "", r.debit ? "Number" : "String"],
        [r.credit || "", r.credit ? "Number" : "String"],
        [r.taxCode, "String"],
        [r.jurisdiction, "String"],
        [r.costCenter, "String"],
        [r.profitCenter, "String"],
        [r.orderNumber, "String"],
        [r.wbsElement, "String"],
      ];
      return `<Row>${values.map(([v, t]) => excelCell(v, t)).join("")}</Row>`;
    })
    .join("");

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="AEAT">
  <Table>
   <Row>${header}</Row>
   ${body}
  </Table>
 </Worksheet>
</Workbook>`;
}
