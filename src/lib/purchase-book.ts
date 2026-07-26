// N3 Reporting PurchaseBook response normalizer (Phase 3B).
//
// The live envelope observed in Phase 3B Prerequisite is:
//   { success, code, message, data: PurchaseBookReportModel[] }
// but the endpoint historically also returns:
//   { success, code, data: LoadResult }              // LoadResult = { data: [], totalCount }
//   { success, code, data: PurchaseBookReportModel } // defensive single-model form
//
// Each PurchaseBookReportModel carries two arrays we care about:
//   detailItems[]     — the purchase-document rows included in the audit
//   postingSummary[]  — { accountCode, accountName, amount } per posting account
//
// This module is I/O-free so both the server route and unit tests can call
// it with real fixtures. On any shape the parser does not recognise it MUST
// return `{ kind: "contract-mismatch" }` — never silently downgrade to a
// balanced-looking empty report.

export interface PurchaseBookDetailItem {
  docCode?: string;
  docDate?: string;
  docType?: string;
  isCancelled?: boolean;
  supplierCode?: string;
  supplierName?: string;
  purchaserCode?: string;
  purchaserName?: string;
  termCode?: string;
  termDescription?: string;
  dueDate?: string;
  currencyCode?: string;
  currencyRate?: number;
  amount?: number;
  amountLocal?: number;
  taxAmount?: number;
  taxAmountLocal?: number;
  netAmount?: number;
  netAmountLocal?: number;
  [key: string]: unknown;
}

export interface PurchaseBookPostingSummaryRow {
  accountCode?: string;
  accountName?: string;
  amount?: number;
  [key: string]: unknown;
}

export interface PurchaseBookReportModel {
  detailItems?: PurchaseBookDetailItem[] | null;
  postingSummary?: PurchaseBookPostingSummaryRow[] | null;
  [key: string]: unknown;
}

export interface PurchaseBookNormalized {
  kind: "ok";
  models: number;
  detailItems: PurchaseBookDetailItem[];
  postingSummary: PurchaseBookPostingSummaryRow[];
}

export interface PurchaseBookMismatch {
  kind: "contract-mismatch";
  reason: string;
  shape: string;
}

export type PurchaseBookResult = PurchaseBookNormalized | PurchaseBookMismatch;

function shapeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  const t = typeof v;
  if (t !== "object") return t;
  return `object(${Object.keys(v as object).slice(0, 8).join(",")})`;
}

function isModel(v: unknown): v is PurchaseBookReportModel {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as PurchaseBookReportModel;
  const hasDetails = "detailItems" in o;
  const hasSummary = "postingSummary" in o;
  return hasDetails || hasSummary;
}

/**
 * Normalize any documented `POST /api/reporting/PurchaseBook` response into a
 * flat `{ detailItems, postingSummary }`. Empty arrays are legitimate.
 */
export function normalizePurchaseBook(envelope: unknown): PurchaseBookResult {
  if (!envelope || typeof envelope !== "object") {
    return {
      kind: "contract-mismatch",
      reason: "Response was not an object.",
      shape: shapeOf(envelope),
    };
  }
  const env = envelope as { success?: unknown; code?: unknown; data?: unknown };
  if (env.success === false) {
    return {
      kind: "contract-mismatch",
      reason: "N3 returned success:false.",
      shape: shapeOf(env.data),
    };
  }
  // Locate the payload — envelope's `.data`, or the whole body if it already
  // looks like the report body.
  const payload = "data" in env ? env.data : envelope;

  // Case 1: data is a PurchaseBookReportModel[] (the live shape).
  if (Array.isArray(payload)) {
    const models = payload.filter(isModel) as PurchaseBookReportModel[];
    if (models.length === 0 && payload.length > 0) {
      return {
        kind: "contract-mismatch",
        reason: "Array items did not carry detailItems/postingSummary.",
        shape: shapeOf(payload[0]),
      };
    }
    return concatModels(models);
  }
  if (!payload || typeof payload !== "object") {
    return {
      kind: "contract-mismatch",
      reason: "Payload was neither an array nor an object.",
      shape: shapeOf(payload),
    };
  }

  // Case 2: LoadResult = { data: [...], totalCount }
  const inner = payload as { data?: unknown };
  if (Array.isArray(inner.data)) {
    const models = (inner.data as unknown[]).filter(isModel) as PurchaseBookReportModel[];
    if (models.length === 0 && inner.data.length > 0) {
      return {
        kind: "contract-mismatch",
        reason: "LoadResult items did not carry detailItems/postingSummary.",
        shape: shapeOf((inner.data as unknown[])[0]),
      };
    }
    return concatModels(models);
  }

  // Case 3: defensive single PurchaseBookReportModel.
  if (isModel(payload)) return concatModels([payload]);

  return {
    kind: "contract-mismatch",
    reason: "Unrecognised PurchaseBook payload shape.",
    shape: shapeOf(payload),
  };
}

function concatModels(models: PurchaseBookReportModel[]): PurchaseBookNormalized {
  const detailItems: PurchaseBookDetailItem[] = [];
  const postingSummary: PurchaseBookPostingSummaryRow[] = [];
  for (const m of models) {
    if (Array.isArray(m.detailItems)) detailItems.push(...m.detailItems);
    if (Array.isArray(m.postingSummary)) postingSummary.push(...m.postingSummary);
  }
  return { kind: "ok", models: models.length, detailItems, postingSummary };
}

/** Distinct non-cancelled doc codes returned by PurchaseBook. */
export function purchaseBookDocCodes(n: PurchaseBookNormalized): string[] {
  const out = new Set<string>();
  for (const d of n.detailItems) {
    if (d.isCancelled) continue;
    const c = typeof d.docCode === "string" ? d.docCode.trim() : "";
    if (c) out.add(c);
  }
  return [...out];
}
