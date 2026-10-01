import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  loadPurchaseReportPrintLayout,
  normalizePurchaseReportPrintLayout,
  purchaseReportLayoutStorageKey,
  savePurchaseReportPrintLayout,
} from "../purchase-report-layout";

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

const ids = [
  "expenditure-audit",
  "posting-account",
  "wbs",
  "hq-tax",
  "audit-trail",
] as const;

const store = makeStorage();
const g = globalThis as unknown as { window?: unknown };
const original = g.window;

beforeEach(() => {
  store.clear();
  g.window = {
    localStorage: store,
    sessionStorage: makeStorage(),
    dispatchEvent: () => true,
  };
});

afterAll(() => {
  g.window = original;
});

describe("tenant Print All report layout", () => {
  it("defaults to canonical order with every report selected", () => {
    expect(normalizePurchaseReportPrintLayout(null, ids)).toEqual({
      schemaVersion: 1,
      order: [...ids],
      selected: [...ids],
    });
  });

  it("preserves custom order and tick choices", () => {
    const saved = savePurchaseReportPrintLayout(
      {
        schemaVersion: 1,
        order: ["audit-trail", "expenditure-audit", "wbs", "posting-account", "hq-tax"],
        selected: ["audit-trail", "wbs"],
      },
      ids,
    );
    expect(saved.order[0]).toBe("audit-trail");
    expect(saved.selected).toEqual(["audit-trail", "wbs"]);
    expect(loadPurchaseReportPrintLayout(ids)).toEqual(saved);
  });

  it("appends and selects newly introduced report ids", () => {
    const out = normalizePurchaseReportPrintLayout(
      {
        schemaVersion: 1,
        order: ["posting-account", "wbs", "hq-tax", "audit-trail"],
        selected: ["posting-account", "hq-tax"],
      },
      ids,
    );
    expect(out.order).toEqual([
      "posting-account",
      "wbs",
      "hq-tax",
      "audit-trail",
      "expenditure-audit",
    ]);
    expect(out.selected).toContain("expenditure-audit");
  });

  it("uses tenant-only storage rather than user-specific storage", () => {
    const a = purchaseReportLayoutStorageKey({ tenantId: "tenant-1", userId: "user-a" });
    const b = purchaseReportLayoutStorageKey({ tenantId: "tenant-1", userId: "user-b" });
    const c = purchaseReportLayoutStorageKey({ tenantId: "tenant-2", userId: "user-a" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe("custom-bill-entry:purchase-report-layout:tenant-1");
  });
});
