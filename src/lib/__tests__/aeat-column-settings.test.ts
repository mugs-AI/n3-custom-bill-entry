import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AEAT_OPTIONAL_COLUMN_KEYS,
  DEFAULT_AEAT_COLUMN_SETTINGS,
  aeatColumnSettingsStorageKey,
  loadAeatColumnSettings,
  normalizeAeatColumnSettings,
  resetAeatColumnSettings,
  saveAeatColumnSettings,
} from "../aeat-column-settings";

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
    sessionStorage: makeStorage(),
    dispatchEvent: () => true,
  };
});

afterAll(() => {
  g.window = original;
});

describe("AEAT optional column settings", () => {
  it("defaults all three optional columns to hidden", () => {
    expect(DEFAULT_AEAT_COLUMN_SETTINGS.shownOptionalColumns).toEqual([]);
    expect(loadAeatColumnSettings().shownOptionalColumns).toEqual([]);
    expect(AEAT_OPTIONAL_COLUMN_KEYS).toEqual([
      "companyCurrencyAmount",
      "secondLocalCurrencyAmount",
      "jurisdiction",
    ]);
  });

  it("persists only known optional columns", () => {
    const normalized = normalizeAeatColumnSettings({
      shownOptionalColumns: ["jurisdiction", "unknown", "companyCurrencyAmount"],
    });
    expect(normalized.shownOptionalColumns).toEqual([
      "companyCurrencyAmount",
      "jurisdiction",
    ]);

    saveAeatColumnSettings(normalized);
    expect(loadAeatColumnSettings()).toEqual(normalized);
  });

  it("resets to the hidden default", () => {
    saveAeatColumnSettings({
      schemaVersion: 1,
      shownOptionalColumns: ["secondLocalCurrencyAmount"],
    });
    expect(resetAeatColumnSettings()).toEqual(DEFAULT_AEAT_COLUMN_SETTINGS);
    expect(loadAeatColumnSettings()).toEqual(DEFAULT_AEAT_COLUMN_SETTINGS);
  });

  it("uses the existing tenant/user browser preference scope", () => {
    const a = aeatColumnSettingsStorageKey({ tenantId: "t1", userId: "u1" });
    const b = aeatColumnSettingsStorageKey({ tenantId: "t1", userId: "u2" });
    expect(a).toBe("custom-bill-entry:aeat-columns:t1:u1");
    expect(a).not.toBe(b);
  });

  it("exposes all three controls in Settings and both export buttons in AEAT", () => {
    const settings = readFileSync(resolve(process.cwd(), "src/routes/settings.tsx"), "utf8");
    const report = readFileSync(
      resolve(process.cwd(), "src/routes/reports_.purchase.$view.tsx"),
      "utf8",
    );
    const columnSettings = readFileSync(
      resolve(process.cwd(), "src/lib/aeat-column-settings.ts"),
      "utf8",
    );

    expect(settings).toContain("Advanced Expenditure Audit Trail Columns");
    expect(columnSettings).toContain("Amount in Company Code");
    expect(columnSettings).toContain("Amount in Second Local");
    expect(columnSettings).toContain("Tax Jurisdiction");
    expect(settings).toContain("hidden by default");

    expect(report).toContain("Export Excel");
    expect(report).toContain("Export CSV");
    expect(report).toContain("visibleColumns");
    expect(report).toContain("buildAdvancedExpenditureExcelXml(rows, visibleColumns)");
    expect(report).toContain("buildAdvancedExpenditureCsv(rows, visibleColumns)");
  });
});
