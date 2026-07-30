import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  DEFAULT_PRINT_SETTINGS,
  coercePrintSettings,
  loadPrintSettings,
  printPageStyleCss,
  printSettingsStorageKey,
  resetPrintSettings,
  savePrintSettings,
  validatePrintSettings,
} from "../report-print-settings";
import { layoutStorageKey } from "../item-layout";

// Minimal browser shim (vitest runs in the node environment).
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

const store = makeStorage();
const g = globalThis as unknown as { window?: unknown };
const original = g.window;

beforeEach(() => {
  store.clear();
  g.window = {
    localStorage: store,
    dispatchEvent: () => true,
  };
});
afterAll(() => {
  g.window = original;
});

describe("Correction G — report print settings", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadPrintSettings()).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(DEFAULT_PRINT_SETTINGS).toEqual({
      schemaVersion: 1,
      bodyFontPt: 7.5,
      leftMarginMm: 7,
      rightMarginMm: 7,
    });
  });

  it("saves and loads valid settings", () => {
    savePrintSettings({
      schemaVersion: 1,
      bodyFontPt: 9,
      leftMarginMm: 12,
      rightMarginMm: 10,
    });
    expect(loadPrintSettings()).toEqual({
      schemaVersion: 1,
      bodyFontPt: 9,
      leftMarginMm: 12,
      rightMarginMm: 10,
    });
  });

  it("coerces invalid numerics (NaN, infinity, negative, out of range, off-step)", () => {
    expect(coercePrintSettings({ schemaVersion: 1, bodyFontPt: NaN }).bodyFontPt).toBe(7.5);
    expect(
      coercePrintSettings({ schemaVersion: 1, bodyFontPt: Infinity }).bodyFontPt,
    ).toBe(7.5);
    expect(coercePrintSettings({ schemaVersion: 1, bodyFontPt: 99 }).bodyFontPt).toBe(12);
    expect(coercePrintSettings({ schemaVersion: 1, bodyFontPt: 7.7 }).bodyFontPt).toBe(7.5);
    expect(coercePrintSettings({ schemaVersion: 1, leftMarginMm: -4 }).leftMarginMm).toBe(5);
    expect(coercePrintSettings({ schemaVersion: 1, rightMarginMm: 900 }).rightMarginMm).toBe(25);
    expect(coercePrintSettings({ schemaVersion: 1, leftMarginMm: 8.6 }).leftMarginMm).toBe(9);
  });

  it("drops unknown properties", () => {
    const out = coercePrintSettings({
      schemaVersion: 1,
      bodyFontPt: 8,
      evil: "x",
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual([
      "bodyFontPt",
      "leftMarginMm",
      "rightMarginMm",
      "schemaVersion",
    ]);
  });

  it("falls back on corrupted JSON", () => {
    store.setItem(printSettingsStorageKey(), "{not json");
    expect(loadPrintSettings()).toEqual(DEFAULT_PRINT_SETTINGS);
  });

  it("falls back on an unknown schema version", () => {
    store.setItem(
      printSettingsStorageKey(),
      JSON.stringify({ schemaVersion: 99, bodyFontPt: 11, leftMarginMm: 20, rightMarginMm: 20 }),
    );
    expect(loadPrintSettings()).toEqual(DEFAULT_PRINT_SETTINGS);
  });

  it("namespaces the key per tenant and user", () => {
    const a = printSettingsStorageKey({ tenantId: "t1", userId: "u1" });
    const b = printSettingsStorageKey({ tenantId: "t2", userId: "u1" });
    const c = printSettingsStorageKey({ tenantId: "t1", userId: "u2" });
    expect(a).toBe("custom-bill-entry:report-print-settings:t1:u1");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("resets to defaults", () => {
    savePrintSettings({ schemaVersion: 1, bodyFontPt: 10, leftMarginMm: 15, rightMarginMm: 15 });
    expect(resetPrintSettings()).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(loadPrintSettings()).toEqual(DEFAULT_PRINT_SETTINGS);
  });

  it("never touches Item Line Layout storage", () => {
    const layoutKey = layoutStorageKey();
    store.setItem(layoutKey, JSON.stringify({ schemaVersion: 2, row1: ["wbs"], row2: ["qty"] }));
    const before = store.getItem(layoutKey);
    savePrintSettings({ schemaVersion: 1, bodyFontPt: 8, leftMarginMm: 9, rightMarginMm: 9 });
    resetPrintSettings();
    expect(store.getItem(layoutKey)).toBe(before);
  });

  it("validates ranges and rejects invalid input", () => {
    expect(
      validatePrintSettings({ bodyFontPt: 7.5, leftMarginMm: 7, rightMarginMm: 7 }).ok,
    ).toBe(true);
    expect(
      validatePrintSettings({ bodyFontPt: 20, leftMarginMm: 7, rightMarginMm: 7 }).ok,
    ).toBe(false);
    expect(
      validatePrintSettings({ bodyFontPt: 7.5, leftMarginMm: 2, rightMarginMm: 7 }).ok,
    ).toBe(false);
    expect(
      validatePrintSettings({ bodyFontPt: 7.5, leftMarginMm: 7, rightMarginMm: 8.4 }).ok,
    ).toBe(false);
    expect(
      validatePrintSettings({ bodyFontPt: "abc", leftMarginMm: 7, rightMarginMm: 7 }).ok,
    ).toBe(false);
  });

  it("emits literal millimetre @page CSS in top/right/bottom/left order", () => {
    const css = printPageStyleCss({
      schemaVersion: 1,
      bodyFontPt: 7.5,
      leftMarginMm: 8,
      rightMarginMm: 9,
    });
    expect(css).toContain("size:A4 portrait");
    expect(css).toContain("margin:7mm 9mm 7mm 8mm");
    expect(css).not.toContain("var(");
  });
});
