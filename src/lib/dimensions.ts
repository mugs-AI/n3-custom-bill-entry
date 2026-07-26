// Configuration-driven dimension summaries for Phase 3B Views 3-8.
//
// Six reports share one grouper. Each report picks a `key` accessor
// (immutable ID preferred), plus code/name display accessors. The grouper
// runs against the already-normalized GLDrillDownLine[] returned by the
// existing GL Analysis inquiry — zero extra N3 calls.

import { round2, sumTo2dp } from "./money";
import type { GLDrillDownLine } from "./report-model";

export const BLANK_KEY = "__BLANK__";
export const BLANK_LABEL = "BLANK / UNASSIGNED";

export type DimensionKey =
  | "wbs"
  | "hq-sequence"
  | "cost-centre"
  | "order-number"
  | "payment-type"
  | "hq-tax";

export interface DimensionRow {
  /** Stable grouping key: immutable id when available, else trimmed text. */
  key: string;
  /** Displayable code / value (e.g. Stock Code, HQ Sequence text). */
  code: string;
  /** Displayable description / name. */
  description: string;
  invoiceCount: number;
  lineCount: number;
  beforeTax: number;
  taxAmount: number;
  includingTax: number;
}

interface DimensionSpec {
  id: DimensionKey;
  title: string;
  source: string;
  codeHeader: string;
  descriptionHeader: string;
  /** Return [key, code, description] for a line, or null to mark BLANK. */
  extract: (
    l: GLDrillDownLine,
  ) => { key: string; code: string; description: string } | null;
}

// NOTE: `hqSequence` is a text field on the invoice — trimmed text is its
// key. Everything else has an immutable numeric N3 ID paired with a code.
export const DIMENSION_SPECS: Record<DimensionKey, DimensionSpec> = {
  wbs: {
    id: "wbs",
    title: "Summary of WBS",
    source: "N3 Stock Codes",
    codeHeader: "Stock Code",
    descriptionHeader: "Stock Name",
    extract: (l) => {
      if (l.stockId == null && !l.stockCode) return null;
      return {
        key: l.stockId != null ? `id:${l.stockId}` : `code:${l.stockCode}`,
        code: l.stockCode,
        // Stock name isn't on GLDrillDownLine; the description slot shows
        // the item description as the best-available display.
        description: l.itemDescription,
      };
    },
  },
  "hq-sequence": {
    id: "hq-sequence",
    title: "Summary of HQ Sequence",
    source: "N3 Purchase Invoice Description",
    codeHeader: "HQ Sequence",
    descriptionHeader: "PI Count",
    extract: (l) => {
      const t = (l.hqSequence ?? "").trim();
      if (!t) return null;
      return { key: `text:${t}`, code: t, description: "" };
    },
  },
  "cost-centre": {
    id: "cost-centre",
    title: "Summary of Cost Centre",
    source: "N3 Project Codes",
    codeHeader: "Project Code",
    descriptionHeader: "Project Name",
    extract: (l) => {
      if (l.projectId == null && !l.projectCode) return null;
      return {
        key: l.projectId != null ? `id:${l.projectId}` : `code:${l.projectCode}`,
        code: l.projectCode,
        description: "",
      };
    },
  },
  "order-number": {
    id: "order-number",
    title: "Summary of Order Number",
    source: "N3 Tariff Codes",
    codeHeader: "Tariff Code",
    descriptionHeader: "Description",
    extract: (l) => {
      // Tariff/order fields are optional on the mapped line — surface via
      // referenceNo as the visible "Order No." if no tariff was captured.
      const code = l.referenceNo || "";
      if (!code) return null;
      return { key: `text:${code}`, code, description: "" };
    },
  },
  "payment-type": {
    id: "payment-type",
    title: "Summary of Payment Type",
    source: "N3 Purchaser",
    codeHeader: "Purchaser Code",
    descriptionHeader: "Purchaser Name",
    extract: (l) => {
      if (!l.purchaserCode && !l.purchaserName && !l.paymentType) return null;
      return {
        key: `code:${l.purchaserCode || l.paymentType || l.purchaserName}`,
        code: l.purchaserCode,
        description: l.purchaserName || l.paymentType,
      };
    },
  },
  "hq-tax": {
    id: "hq-tax",
    title: "Summary of HQ Tax",
    source: "N3 SST Tax Codes",
    codeHeader: "Tax Code",
    descriptionHeader: "Description",
    extract: (l) => {
      if (l.taxCodeId == null && !l.taxCodeCode) return null;
      return {
        key: l.taxCodeId != null ? `id:${l.taxCodeId}` : `code:${l.taxCodeCode}`,
        code: l.taxCodeCode,
        description: "",
      };
    },
  },
};

interface Accumulator {
  key: string;
  code: string;
  description: string;
  invoiceIds: Set<string>;
  lineCount: number;
  beforeTax: number[];
  taxAmount: number[];
  includingTax: number[];
}

/**
 * Group `lines` by `dim`. Missing keys land in the shared `BLANK / UNASSIGNED`
 * bucket. Each result row's amounts equal the exact sum of its contributing
 * lines (2dp), so the report totals reconcile with the GL Analysis cards.
 */
export function groupByDimension(
  lines: GLDrillDownLine[],
  dim: DimensionKey,
): DimensionRow[] {
  const spec = DIMENSION_SPECS[dim];
  const buckets = new Map<string, Accumulator>();
  const useLine = (l: GLDrillDownLine, key: string, code: string, description: string) => {
    let b = buckets.get(key);
    if (!b) {
      b = {
        key,
        code,
        description,
        invoiceIds: new Set(),
        lineCount: 0,
        beforeTax: [],
        taxAmount: [],
        includingTax: [],
      };
      buckets.set(key, b);
    } else {
      if (!b.code && code) b.code = code;
      if (!b.description && description) b.description = description;
    }
    b.invoiceIds.add(l.invoiceId);
    b.lineCount += 1;
    b.beforeTax.push(round2(l.beforeTax));
    b.taxAmount.push(round2(l.taxAmount));
    b.includingTax.push(round2(l.includingTax));
  };
  for (const l of lines) {
    if (l.isCancelled) continue;
    const got = spec.extract(l);
    if (!got) useLine(l, BLANK_KEY, "", BLANK_LABEL);
    else useLine(l, got.key, got.code, got.description);
  }
  const out: DimensionRow[] = [];
  for (const b of buckets.values()) {
    out.push({
      key: b.key,
      code: b.code,
      description: b.description,
      invoiceCount: b.invoiceIds.size,
      lineCount: b.lineCount,
      beforeTax: sumTo2dp(b.beforeTax),
      taxAmount: sumTo2dp(b.taxAmount),
      includingTax: sumTo2dp(b.includingTax),
    });
  }
  out.sort((a, b) => b.includingTax - a.includingTax);
  return out;
}

/** Sum a dimension summary — used to prove reconciliation vs. GL Analysis. */
export function totalOf(rows: DimensionRow[]): {
  beforeTax: number;
  taxAmount: number;
  includingTax: number;
} {
  return {
    beforeTax: sumTo2dp(rows.map((r) => r.beforeTax)),
    taxAmount: sumTo2dp(rows.map((r) => r.taxAmount)),
    includingTax: sumTo2dp(rows.map((r) => r.includingTax)),
  };
}
