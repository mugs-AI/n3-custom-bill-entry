// Phase 3B Correction G — report print preference model.
//
// Per-user, per-tenant print preferences for the eight Purchase Reports and
// the Print All document. Stored in localStorage under a key namespaced by
// the immutable N3 tenant + user ids, completely separate from the Item Line
// Layout preference, drafts and the GL Analysis snapshot.

import { getAuthScope } from "./draft-store";

export interface ReportPrintSettings {
  schemaVersion: 1;
  bodyFontPt: number;
  leftMarginMm: number;
  rightMarginMm: number;
}

export const PRINT_SCHEMA_VERSION = 1 as const;

export const DEFAULT_PRINT_SETTINGS: ReportPrintSettings = {
  schemaVersion: PRINT_SCHEMA_VERSION,
  bodyFontPt: 7.5,
  leftMarginMm: 7,
  rightMarginMm: 7,
};

export const FONT_PT_MIN = 6.5;
export const FONT_PT_MAX = 12;
export const FONT_PT_STEP = 0.5;
export const MARGIN_MM_MIN = 5;
export const MARGIN_MM_MAX = 25;

/** Fixed vertical margins — only left/right are user-configurable. */
export const TOP_MARGIN_MM = 7;
export const BOTTOM_MARGIN_MM = 7;

export const PRINT_SETTINGS_EVENT = "custom-bill-entry:report-print-settings-change";
export const PRINT_PAGE_STYLE_ID = "custom-bill-entry-print-page-style";

export function printSettingsStorageKey(scope = getAuthScope()): string {
  return `custom-bill-entry:report-print-settings:${scope.tenantId}:${scope.userId}`;
}

function finite(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Coerce any input into a valid body font size (pt), snapped to 0.5 steps. */
export function coerceBodyFontPt(v: unknown): number {
  const n = finite(v);
  if (n === null) return DEFAULT_PRINT_SETTINGS.bodyFontPt;
  const snapped = Math.round(n / FONT_PT_STEP) * FONT_PT_STEP;
  return Number(clamp(snapped, FONT_PT_MIN, FONT_PT_MAX).toFixed(1));
}

/** Coerce any input into a valid whole-millimetre margin. */
export function coerceMarginMm(v: unknown): number {
  const n = finite(v);
  if (n === null) return DEFAULT_PRINT_SETTINGS.leftMarginMm;
  return clamp(Math.round(n), MARGIN_MM_MIN, MARGIN_MM_MAX);
}

/** Never throws. Unknown properties are dropped; bad schema falls back. */
export function coercePrintSettings(raw: unknown): ReportPrintSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PRINT_SETTINGS };
  const r = raw as Record<string, unknown>;
  const version = finite(r.schemaVersion);
  if (version !== PRINT_SCHEMA_VERSION) return { ...DEFAULT_PRINT_SETTINGS };
  return {
    schemaVersion: PRINT_SCHEMA_VERSION,
    bodyFontPt: coerceBodyFontPt(r.bodyFontPt),
    leftMarginMm: coerceMarginMm(r.leftMarginMm),
    rightMarginMm: coerceMarginMm(r.rightMarginMm),
  };
}

export interface PrintSettingsValidation {
  ok: boolean;
  errors: string[];
}

export function validatePrintSettings(input: {
  bodyFontPt: unknown;
  leftMarginMm: unknown;
  rightMarginMm: unknown;
}): PrintSettingsValidation {
  const errors: string[] = [];
  const f = finite(input.bodyFontPt);
  if (f === null || f < FONT_PT_MIN || f > FONT_PT_MAX) {
    errors.push(`Result font size must be between ${FONT_PT_MIN} and ${FONT_PT_MAX} pt.`);
  } else if (Math.abs(f / FONT_PT_STEP - Math.round(f / FONT_PT_STEP)) > 1e-9) {
    errors.push(`Result font size must use ${FONT_PT_STEP} pt steps.`);
  }
  const l = finite(input.leftMarginMm);
  if (l === null || l < MARGIN_MM_MIN || l > MARGIN_MM_MAX || !Number.isInteger(l)) {
    errors.push(`Left margin must be a whole number between ${MARGIN_MM_MIN} and ${MARGIN_MM_MAX} mm.`);
  }
  const r = finite(input.rightMarginMm);
  if (r === null || r < MARGIN_MM_MIN || r > MARGIN_MM_MAX || !Number.isInteger(r)) {
    errors.push(`Right margin must be a whole number between ${MARGIN_MM_MIN} and ${MARGIN_MM_MAX} mm.`);
  }
  return { ok: errors.length === 0, errors };
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadPrintSettings(): ReportPrintSettings {
  const s = safeStorage();
  if (!s) return { ...DEFAULT_PRINT_SETTINGS };
  try {
    const raw = s.getItem(printSettingsStorageKey());
    if (!raw) return { ...DEFAULT_PRINT_SETTINGS };
    return coercePrintSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PRINT_SETTINGS };
  }
}

export function savePrintSettings(input: ReportPrintSettings): ReportPrintSettings {
  const safe = coercePrintSettings({ ...input, schemaVersion: PRINT_SCHEMA_VERSION });
  const s = safeStorage();
  if (!s) return safe;
  try {
    s.setItem(printSettingsStorageKey(), JSON.stringify(safe));
    window.dispatchEvent(new Event(PRINT_SETTINGS_EVENT));
  } catch {
    /* ignore */
  }
  return safe;
}

export function resetPrintSettings(): ReportPrintSettings {
  const s = safeStorage();
  if (s) {
    try {
      s.removeItem(printSettingsStorageKey());
      window.dispatchEvent(new Event(PRINT_SETTINGS_EVENT));
    } catch {
      /* ignore */
    }
  }
  return { ...DEFAULT_PRINT_SETTINGS };
}

/** Literal @page CSS (browsers don't reliably resolve custom properties there). */
export function printPageStyleCss(s: ReportPrintSettings): string {
  const safe = coercePrintSettings(s);
  return `@media print{@page{size:A4 portrait;margin:${TOP_MARGIN_MM}mm ${safe.rightMarginMm}mm ${BOTTOM_MARGIN_MM}mm ${safe.leftMarginMm}mm;}}`;
}

/**
 * Create-or-update the single dynamic @page style element. Never appends a
 * second competing element.
 */
export function applyPrintPageStyle(s: ReportPrintSettings): void {
  if (typeof document === "undefined") return;
  let el = document.getElementById(PRINT_PAGE_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = PRINT_PAGE_STYLE_ID;
    document.head.appendChild(el);
  }
  const css = printPageStyleCss(s);
  if (el.textContent !== css) el.textContent = css;
}
