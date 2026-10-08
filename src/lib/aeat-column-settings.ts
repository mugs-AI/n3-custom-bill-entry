import { getLayoutScope } from "./item-layout";

export const AEAT_OPTIONAL_COLUMN_KEYS = [
  "companyCurrencyAmount",
  "secondLocalCurrencyAmount",
  "jurisdiction",
] as const;

export type AeatOptionalColumnKey = (typeof AEAT_OPTIONAL_COLUMN_KEYS)[number];

export const AEAT_OPTIONAL_COLUMN_LABELS: Record<AeatOptionalColumnKey, string> = {
  companyCurrencyAmount: "Amount in Company Code",
  secondLocalCurrencyAmount: "Amount in Second Local",
  jurisdiction: "Tax Jurisdiction",
};

export interface AeatColumnSettings {
  schemaVersion: 1;
  shownOptionalColumns: AeatOptionalColumnKey[];
}

export const DEFAULT_AEAT_COLUMN_SETTINGS: AeatColumnSettings = {
  schemaVersion: 1,
  shownOptionalColumns: [],
};

export const AEAT_COLUMN_SETTINGS_EVENT = "custom-bill-entry:aeat-column-settings-change";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function aeatColumnSettingsStorageKey(
  scope = getLayoutScope(),
): string {
  return `custom-bill-entry:aeat-columns:${scope.tenantId}:${scope.userId}`;
}

export function normalizeAeatColumnSettings(raw: unknown): AeatColumnSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_AEAT_COLUMN_SETTINGS };
  const candidate = raw as Partial<AeatColumnSettings>;
  const source = Array.isArray(candidate.shownOptionalColumns)
    ? candidate.shownOptionalColumns
    : [];
  const shownOptionalColumns = AEAT_OPTIONAL_COLUMN_KEYS.filter((key) =>
    source.includes(key),
  );
  return { schemaVersion: 1, shownOptionalColumns };
}

export function loadAeatColumnSettings(): AeatColumnSettings {
  const s = storage();
  if (!s) return { ...DEFAULT_AEAT_COLUMN_SETTINGS };
  try {
    const raw = s.getItem(aeatColumnSettingsStorageKey());
    return normalizeAeatColumnSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_AEAT_COLUMN_SETTINGS };
  }
}

export function saveAeatColumnSettings(
  settings: AeatColumnSettings,
): AeatColumnSettings {
  const safe = normalizeAeatColumnSettings(settings);
  const s = storage();
  if (s) {
    try {
      s.setItem(aeatColumnSettingsStorageKey(), JSON.stringify(safe));
      window.dispatchEvent(new Event(AEAT_COLUMN_SETTINGS_EVENT));
    } catch {
      /* preference storage failure must not block reporting */
    }
  }
  return safe;
}

export function resetAeatColumnSettings(): AeatColumnSettings {
  const s = storage();
  if (s) {
    try {
      s.removeItem(aeatColumnSettingsStorageKey());
      window.dispatchEvent(new Event(AEAT_COLUMN_SETTINGS_EVENT));
    } catch {
      /* ignore */
    }
  }
  return { ...DEFAULT_AEAT_COLUMN_SETTINGS };
}
