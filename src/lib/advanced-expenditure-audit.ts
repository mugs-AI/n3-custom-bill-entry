import { round2, sumTo2dp } from "./money";
import type { PurchaseAuditResult } from "./audit-trail";
import type { ReportData } from "./report-model";

export const AEAT_EXCEL_COLUMNS = [
  "Company Code (4)",
  "G/L Account (10)",
  "Item Text (50)",
  "Debit",
  "Credit",
  "Amount in Company Code Currency",
  "Amount in Second Local Currency",
  "Tax Code (2)",
  "Tax Jurisdiction (15)",
  "Cost Center (10)",
  "Profit Center (10)",
  "Order Number (12)",
  "WBS Element (24)",
] as const;

export type AeatColumnKey =
  | "companyCode"
  | "glAccount"
  | "itemText"
  | "debit"
  | "credit"
  | "companyCurrencyAmount"
  | "secondLocalCurrencyAmount"
  | "taxCode"
  | "jurisdiction"
  | "costCenter"
  | "profitCenter"
  | "orderNumber"
  | "wbsElement";

export interface AeatColumnDefinition {
  key: AeatColumnKey;
  label: (typeof AEAT_EXCEL_COLUMNS)[number];
  numeric?: boolean;
  optional?: boolean;
}

export const AEAT_COLUMNS: readonly AeatColumnDefinition[] = [
  { key: "companyCode", label: "Company Code (4)" },
  { key: "glAccount", label: "G/L Account (10)" },
  { key: "itemText", label: "Item Text (50)" },
  { key: "debit", label: "Debit", numeric: true },
  { key: "credit", label: "Credit", numeric: true },
  {
    key: "companyCurrencyAmount",
    label: "Amount in Company Code Currency",
    optional: true,
  },
  {
    key: "secondLocalCurrencyAmount",
    label: "Amount in Second Local Currency",
    optional: true,
  },
  { key: "taxCode", label: "Tax Code (2)" },
  { key: "jurisdiction", label: "Tax Jurisdiction (15)", optional: true },
  { key: "costCenter", label: "Cost Center (10)" },
  { key: "profitCenter", label: "Profit Center (10)" },
  { key: "orderNumber", label: "Order Number (12)" },
  { key: "wbsElement", label: "WBS Element (24)" },
];

export function getAdvancedExpenditureColumns(
  shownOptionalColumns: readonly string[] = [],
): AeatColumnDefinition[] {
  const shown = new Set(shownOptionalColumns);
  return AEAT_COLUMNS.filter((column) => !column.optional || shown.has(column.key));
}

export interface AdvancedExpenditureAuditRow {
  companyCode: string;
  glAccount: string;
  itemText: string;
  debit: number;
  credit: number;
  companyCurrencyAmount: string;
  secondLocalCurrencyAmount: string;
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
      companyCode: "1000",
      glAccount,
      itemText,
      debit: round2(line.beforeTax),
      credit: 0,
      companyCurrencyAmount: "",
      secondLocalCurrencyAmount: "",
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

function detailedCreditRows(
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
        companyCode: "1000",
        glAccount,
        itemText,
        debit: 0,
        credit: 0,
        companyCurrencyAmount: "",
        secondLocalCurrencyAmount: "",
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

function consolidatedCreditRow(
  credits: AdvancedExpenditureAuditRow[],
): AdvancedExpenditureAuditRow[] {
  if (credits.length === 0) return [];
  const uniqueTaxCodes = new Set(credits.map((r) => r.taxCode).filter(Boolean));
  return [
    {
      companyCode: "1000",
      glAccount: "",
      itemText: "Total Credit",
      debit: round2(sumTo2dp(credits.map((r) => r.debit))),
      credit: round2(sumTo2dp(credits.map((r) => r.credit))),
      companyCurrencyAmount: "",
      secondLocalCurrencyAmount: "",
      taxCode: uniqueTaxCodes.size === 1 ? [...uniqueTaxCodes][0] : "",
      jurisdiction: "",
      costCenter: "",
      profitCenter: "",
      orderNumber: "",
      wbsElement: "",
    },
  ];
}

export function buildAdvancedExpenditureAuditRows(
  report: ReportData,
  audit: PurchaseAuditResult | null,
  options: { breakdownCreditSide?: boolean } = {},
): AdvancedExpenditureAuditRow[] {
  const breakdownCreditSide = options.breakdownCreditSide ?? true;
  const credits = detailedCreditRows(report, audit);
  return [
    ...debitRows(report),
    ...(breakdownCreditSide ? credits : consolidatedCreditRow(credits)),
  ];
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
 * Dependency-free SpreadsheetML workbook. Excel opens this directly. The
 * exported columns follow the exact currently visible AEAT column arrangement.
 */
export function buildAdvancedExpenditureExcelXml(
  rows: AdvancedExpenditureAuditRow[],
  columns: readonly AeatColumnDefinition[] = AEAT_COLUMNS,
): string {
  const header = columns.map((column) => excelCell(column.label, "String")).join("");
  const body = rows
    .map((row) => {
      const cells = columns.map((column) => {
        const value = aeatCellValue(row, column.key);
        const type: "String" | "Number" =
          column.numeric && typeof value === "number" && value !== 0 ? "Number" : "String";
        const rendered = column.numeric && value === 0 ? "" : value;
        return excelCell(rendered, type);
      });
      return `<Row>${cells.join("")}</Row>`;
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

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildAdvancedExpenditureCsv(
  rows: AdvancedExpenditureAuditRow[],
  columns: readonly AeatColumnDefinition[] = AEAT_COLUMNS,
): string {
  const header = columns.map((column) => csvCell(column.label)).join(",");
  const body = rows.map((row) =>
    columns
      .map((column) => {
        const value = aeatCellValue(row, column.key);
        return csvCell(column.numeric && value === 0 ? "" : value);
      })
      .join(","),
  );
  return [header, ...body].join("\r\n");
}

export function aeatCellValue(
  row: AdvancedExpenditureAuditRow,
  key: AeatColumnKey,
): string | number {
  return row[key];
}
