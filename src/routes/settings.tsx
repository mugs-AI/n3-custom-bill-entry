import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import {
  DEFAULT_LAYOUT,
  FIELD_IDS,
  FIELD_LABELS,
  MAX_PER_ROW,
  coerceLayout,
  loadLayout,
  resetLayout,
  saveLayout,
  validateLayout,
  type FieldId,
  type ItemLayout,
} from "@/lib/item-layout";
import {
  DEFAULT_PRINT_SETTINGS,
  FONT_PT_MAX,
  FONT_PT_MIN,
  FONT_PT_STEP,
  MARGIN_MM_MAX,
  MARGIN_MM_MIN,
  loadPrintSettings,
  resetPrintSettings,
  savePrintSettings,
  validatePrintSettings,
  type ReportPrintSettings,
} from "@/lib/report-print-settings";
import { useHydrated } from "@/hooks/use-auth";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings · Custom Bill Entry" },
      {
        name: "description",
        content:
          "Configure the two-row Item line layout and the Purchase Report print layout. Preferences are stored per N3 user and browser.",
      },
      { property: "og:title", content: "Settings · Custom Bill Entry" },
      {
        property: "og:description",
        content:
          "Item line layout and report print preferences for the Custom Bill Entry app.",
      },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const hydrated = useHydrated();
  return (
    <AppShell>
      <div className="space-y-4">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Preferences are stored for this N3 user in this browser.
          </p>
        </header>
        {hydrated ? (
          <>
            <LayoutEditor />
            <PrintLayoutCard />
          </>
        ) : (
          <div className="app-card p-6 text-sm text-muted-foreground">Loading…</div>
        )}
      </div>
    </AppShell>
  );
}

function LayoutEditor() {
  const [saved, setSaved] = useState<ItemLayout>(() => loadLayout());
  const [draft, setDraft] = useState<ItemLayout>(saved);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    const l = loadLayout();
    setSaved(l);
    setDraft(l);
  }, []);

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  const validation = useMemo(() => validateLayout(draft), [draft]);

  const rowOf = (id: FieldId): 1 | 2 => (draft.row1.includes(id) ? 1 : 2);

  const move = (id: FieldId, delta: -1 | 1) => {
    setDraft((d) => {
      const row: 1 | 2 = d.row1.includes(id) ? 1 : 2;
      const list = row === 1 ? [...d.row1] : [...d.row2];
      const i = list.indexOf(id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return d;
      [list[i], list[j]] = [list[j], list[i]];
      return row === 1 ? { ...d, row1: list } : { ...d, row2: list };
    });
  };

  const moveTo = (id: FieldId, target: 1 | 2) => {
    setDraft((d) => {
      const from: 1 | 2 = d.row1.includes(id) ? 1 : 2;
      if (from === target) return d;
      const fromList = from === 1 ? [...d.row1] : [...d.row2];
      const toList = target === 1 ? [...d.row1] : [...d.row2];
      if (toList.length >= MAX_PER_ROW) return d;
      fromList.splice(fromList.indexOf(id), 1);
      toList.push(id);
      return target === 1
        ? { ...d, row1: toList, row2: fromList }
        : { ...d, row1: fromList, row2: toList };
    });
  };

  const onSave = () => {
    if (!validation.ok) return;
    saveLayout(draft);
    setSaved(draft);
    setFlash("Layout saved");
    window.setTimeout(() => setFlash(null), 2000);
  };
  const onReset = () => {
    resetLayout();
    setSaved({ ...DEFAULT_LAYOUT });
    setDraft({ ...DEFAULT_LAYOUT });
    setFlash("Layout reset to default");
    window.setTimeout(() => setFlash(null), 2000);
  };
  const onCancel = () => setDraft(saved);

  return (
    <section className="app-card p-4" aria-label="Item Line Layout">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <h2 className="text-sm font-semibold">Item Line Layout</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            dirty
              ? "bg-destructive/10 text-destructive"
              : "bg-success/10 text-success"
          }`}
        >
          {dirty ? "Unsaved changes" : "Saved"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="app-btn app-btn-primary h-8 px-2.5 text-xs"
            disabled={!dirty || !validation.ok}
            onClick={onSave}
          >
            Save Layout
          </button>
          <button
            type="button"
            className="app-btn h-8 px-2.5 text-xs"
            disabled={!dirty}
            onClick={onCancel}
          >
            Cancel Changes
          </button>
          <button type="button" className="app-btn h-8 px-2.5 text-xs" onClick={onReset}>
            Reset Default
          </button>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Every one of the {FIELD_IDS.length} fields must appear exactly once. Each row can hold
        up to {MAX_PER_ROW} fields.
      </p>

      {flash && (
        <div
          className="mt-2 rounded-md border border-success/40 bg-success/10 px-3 py-1.5 text-xs text-success"
          role="status"
        >
          {flash}
        </div>
      )}
      {!validation.ok && (
        <div
          className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
          role="alert"
        >
          <strong>Fix these before saving:</strong>
          <ul className="ml-5 mt-1 list-disc">
            {validation.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <RowEditor
          label={`Row 1 (${draft.row1.length}/${MAX_PER_ROW})`}
          fields={draft.row1}
          onMove={move}
          onMoveTo={moveTo}
          otherFull={draft.row2.length >= MAX_PER_ROW}
          targetRow={2}
        />
        <RowEditor
          label={`Row 2 (${draft.row2.length}/${MAX_PER_ROW})`}
          fields={draft.row2}
          onMove={move}
          onMoveTo={moveTo}
          otherFull={draft.row1.length >= MAX_PER_ROW}
          targetRow={1}
        />
      </div>

      <div className="mt-3 border-t border-border pt-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Preview
        </div>
        <LayoutPreview layout={draft} />
      </div>

      <details className="mt-2 text-[11px] text-muted-foreground">
        <summary>All fields (for reference)</summary>
        <ul className="mt-1 grid grid-cols-2 gap-x-4 md:grid-cols-3">
          {FIELD_IDS.map((id) => (
            <li key={id}>
              {FIELD_LABELS[id]} · Row {rowOf(id)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function RowEditor({
  label,
  fields,
  onMove,
  onMoveTo,
  otherFull,
  targetRow,
}: {
  label: string;
  fields: FieldId[];
  onMove: (id: FieldId, delta: -1 | 1) => void;
  onMoveTo: (id: FieldId, target: 1 | 2) => void;
  otherFull: boolean;
  targetRow: 1 | 2;
}) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <ul className="mt-1 flex flex-col divide-y divide-border rounded-md border border-border">
        {fields.map((id, i) => (
          <li key={id} className="flex flex-wrap items-center gap-1.5 px-2 py-1 text-[13px]">
            <span className="w-5 text-right text-[11px] text-muted-foreground tabular">
              {i + 1}.
            </span>
            <span className="font-medium">{FIELD_LABELS[id]}</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                className="app-btn h-6 px-1.5 text-[11px]"
                onClick={() => onMove(id, -1)}
                disabled={i === 0}
                aria-label={`Move ${FIELD_LABELS[id]} up`}
              >
                ↑
              </button>
              <button
                type="button"
                className="app-btn h-6 px-1.5 text-[11px]"
                onClick={() => onMove(id, 1)}
                disabled={i === fields.length - 1}
                aria-label={`Move ${FIELD_LABELS[id]} down`}
              >
                ↓
              </button>
              <button
                type="button"
                className="app-btn h-6 px-1.5 text-[11px]"
                onClick={() => onMoveTo(id, targetRow)}
                disabled={otherFull || fields.length <= 1}
                aria-label={`Move ${FIELD_LABELS[id]} to Row ${targetRow}`}
              >
                → Row {targetRow}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LayoutPreview({ layout }: { layout: ItemLayout }) {
  const cell = (id: FieldId) => (
    <div
      key={id}
      className="min-w-[92px] flex-1 rounded border border-dashed border-border bg-surface-2 px-1.5 py-0.5 text-[10px]"
    >
      {FIELD_LABELS[id]}
    </div>
  );
  return (
    <div className="mt-1.5 rounded-md border border-border p-2">
      <div className="flex flex-wrap gap-1.5">{layout.row1.map(cell)}</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">{layout.row2.map(cell)}</div>
    </div>
  );
}

// ----- Report Print Layout -------------------------------------------------

function PrintLayoutCard() {
  const [saved, setSaved] = useState<ReportPrintSettings>(() => loadPrintSettings());
  const [font, setFont] = useState(String(saved.bodyFontPt));
  const [left, setLeft] = useState(String(saved.leftMarginMm));
  const [right, setRight] = useState(String(saved.rightMarginMm));
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    const s = loadPrintSettings();
    setSaved(s);
    setFont(String(s.bodyFontPt));
    setLeft(String(s.leftMarginMm));
    setRight(String(s.rightMarginMm));
  }, []);

  const validation = useMemo(
    () =>
      validatePrintSettings({
        bodyFontPt: font,
        leftMarginMm: left,
        rightMarginMm: right,
      }),
    [font, left, right],
  );
  const dirty =
    Number(font) !== saved.bodyFontPt ||
    Number(left) !== saved.leftMarginMm ||
    Number(right) !== saved.rightMarginMm;

  const onSave = () => {
    if (!validation.ok) return;
    const next = savePrintSettings({
      schemaVersion: 1,
      bodyFontPt: Number(font),
      leftMarginMm: Number(left),
      rightMarginMm: Number(right),
    });
    setSaved(next);
    setFont(String(next.bodyFontPt));
    setLeft(String(next.leftMarginMm));
    setRight(String(next.rightMarginMm));
    setFlash("Print settings saved");
    window.setTimeout(() => setFlash(null), 2000);
  };
  const onReset = () => {
    const next = resetPrintSettings();
    setSaved(next);
    setFont(String(next.bodyFontPt));
    setLeft(String(next.leftMarginMm));
    setRight(String(next.rightMarginMm));
    setFlash("Print settings reset to default");
    window.setTimeout(() => setFlash(null), 2000);
  };

  const previewLeft = Number(left);
  const previewRight = Number(right);
  const okLeft = Number.isFinite(previewLeft) ? previewLeft : DEFAULT_PRINT_SETTINGS.leftMarginMm;
  const okRight = Number.isFinite(previewRight)
    ? previewRight
    : DEFAULT_PRINT_SETTINGS.rightMarginMm;
  const okFont = Number.isFinite(Number(font)) ? Number(font) : DEFAULT_PRINT_SETTINGS.bodyFontPt;

  return (
    <section className="app-card p-4" aria-label="Report Print Layout">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <h2 className="text-sm font-semibold">Report Print Layout</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            dirty ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"
          }`}
        >
          {dirty ? "Unsaved changes" : "Saved"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="app-btn app-btn-primary h-8 px-2.5 text-xs"
            disabled={!dirty || !validation.ok}
            onClick={onSave}
          >
            Save Print Settings
          </button>
          <button type="button" className="app-btn h-8 px-2.5 text-xs" onClick={onReset}>
            Reset Print Defaults
          </button>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Applies to all eight Purchase Reports and Print All. Screen layout is unchanged.
      </p>

      {flash && (
        <div
          className="mt-2 rounded-md border border-success/40 bg-success/10 px-3 py-1.5 text-xs text-success"
          role="status"
        >
          {flash}
        </div>
      )}
      {!validation.ok && (
        <div
          className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
          role="alert"
        >
          <ul className="ml-5 list-disc">
            {validation.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <NumField
            id="print-body-font"
            label="Result font size"
            unit="pt"
            value={font}
            step={FONT_PT_STEP}
            min={FONT_PT_MIN}
            max={FONT_PT_MAX}
            onChange={setFont}
          />
          <NumField
            id="print-left-margin"
            label="Left margin"
            unit="mm"
            value={left}
            step={1}
            min={MARGIN_MM_MIN}
            max={MARGIN_MM_MAX}
            onChange={setLeft}
          />
          <NumField
            id="print-right-margin"
            label="Right margin"
            unit="mm"
            value={right}
            step={1}
            min={MARGIN_MM_MIN}
            max={MARGIN_MM_MAX}
            onChange={setRight}
          />
        </div>
        <A4Preview leftMm={okLeft} rightMm={okRight} fontPt={okFont} />
      </div>
    </section>
  );
}

function NumField({
  id,
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  unit: string;
  value: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="w-32 shrink-0 text-[12px] font-medium">
        {label}
      </label>
      <input
        id={id}
        type="number"
        className="h-8 w-24 rounded border border-border bg-surface px-2 text-sm tabular"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="text-[12px] text-muted-foreground">{unit}</span>
      <span className="text-[11px] text-muted-foreground">
        ({min}–{max})
      </span>
    </div>
  );
}

/** Pure-CSS A4 aid — no image asset. */
function A4Preview({
  leftMm,
  rightMm,
  fontPt,
}: {
  leftMm: number;
  rightMm: number;
  fontPt: number;
}) {
  const pageWidthMm = 210;
  const leftPct = (leftMm / pageWidthMm) * 100;
  const rightPct = (rightMm / pageWidthMm) * 100;
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        A4 portrait preview
      </div>
      <div
        className="relative mt-1.5 overflow-hidden rounded border border-border bg-surface"
        style={{ aspectRatio: "210 / 297" }}
        aria-hidden="true"
      >
        <div
          className="absolute inset-y-0 left-0 bg-surface-2"
          style={{ width: `${leftPct}%` }}
        />
        <div
          className="absolute inset-y-0 right-0 bg-surface-2"
          style={{ width: `${rightPct}%` }}
        />
        <div
          className="absolute inset-y-2 border-x border-dashed border-border p-1"
          style={{ left: `${leftPct}%`, right: `${rightPct}%` }}
        >
          <div style={{ fontSize: `${fontPt * 1.6}px`, lineHeight: 1.25 }}>
            <div className="font-semibold">Purchase Audit Trail</div>
            <div>PI-000123 · 2 lines · Before 1,200.00 · Tax 72.00 · Incl 1,272.00</div>
            <div>PI-000124 · 3 lines · Before 980.00 · Tax 58.80 · Incl 1,038.80</div>
          </div>
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular">
        <span>Left {leftMm} mm</span>
        <span>Body {fontPt} pt</span>
        <span>Right {rightMm} mm</span>
      </div>
    </div>
  );
}

// re-export for coerceLayout unused warning suppression in strict builds
void coerceLayout;
