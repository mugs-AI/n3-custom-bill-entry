import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import {
  DEFAULT_LAYOUT,
  FIELD_IDS,
  FIELD_LABELS,
  MAX_PER_ROW,
  coerceLayout,
  layoutStorageKey,
  loadLayout,
  resetLayout,
  saveLayout,
  validateLayout,
  type FieldId,
  type ItemLayout,
} from "@/lib/item-layout";
import { useHydrated } from "@/hooks/use-auth";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings · Custom Bill Entry" },
      {
        name: "description",
        content:
          "Configure the two-row Item line layout for New Bill Entry. Preference stored per N3 user and browser.",
      },
      { property: "og:title", content: "Settings · Custom Bill Entry" },
      {
        property: "og:description",
        content:
          "Personal item-line layout preferences for the Custom Bill Entry app.",
      },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const hydrated = useHydrated();
  return (
    <AppShell>
      {hydrated ? <LayoutEditor /> : <div className="app-card p-6 text-sm text-muted-foreground">Loading…</div>}
    </AppShell>
  );
}

function LayoutEditor() {
  const [saved, setSaved] = useState<ItemLayout>(() => loadLayout());
  const [draft, setDraft] = useState<ItemLayout>(saved);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    // Reload when tenant/user scope changes underneath us.
    const l = loadLayout();
    setSaved(l);
    setDraft(l);
  }, []);

  const dirty = useMemo(() => JSON.stringify(saved) !== JSON.stringify(draft), [saved, draft]);
  const validation = useMemo(() => validateLayout(draft), [draft]);
  const scopeKey = layoutStorageKey();

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
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This layout preference applies to your current browser and N3 user.
          Clearing browser data or using another device will restore the default
          layout.
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Storage key: <code className="rounded bg-surface-2 px-1">{scopeKey}</code>
        </p>
      </header>

      {flash && (
        <div
          className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
          role="status"
        >
          {flash}
        </div>
      )}
      {!validation.ok && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
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

      <section className="app-card p-4">
        <h2 className="text-sm font-semibold">Item Line Layout</h2>
        <p className="text-[11px] text-muted-foreground">
          Every one of the 11 fields must appear exactly once. Each row can hold
          up to {MAX_PER_ROW} fields.
        </p>
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
      </section>

      <section className="app-card p-4">
        <h3 className="text-sm font-semibold">Preview</h3>
        <p className="text-[11px] text-muted-foreground">
          A rough preview of how each Item line card will render.
        </p>
        <LayoutPreview layout={draft} />
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="app-btn app-btn-primary"
          disabled={!dirty || !validation.ok}
          onClick={onSave}
        >
          Save Layout
        </button>
        <button
          type="button"
          className="app-btn"
          disabled={!dirty}
          onClick={onCancel}
        >
          Cancel Unsaved Changes
        </button>
        <button type="button" className="app-btn" onClick={onReset}>
          Reset to Default
        </button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {dirty ? "Unsaved changes" : "No changes"} · schema v{draft.schemaVersion}
        </span>
      </div>

      {/* Sanity coverage: every field id present */}
      <details className="text-[11px] text-muted-foreground">
        <summary>All fields (for reference)</summary>
        <ul className="mt-1 grid grid-cols-2 gap-x-4 md:grid-cols-3">
          {FIELD_IDS.map((id) => (
            <li key={id}>
              {FIELD_LABELS[id]} · Row {rowOf(id)}
            </li>
          ))}
        </ul>
      </details>
    </div>
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
    <div className="mt-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <ul className="mt-1 flex flex-col divide-y divide-border rounded-md border border-border">
        {fields.map((id, i) => (
          <li
            key={id}
            className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
          >
            <span className="w-6 text-right text-xs text-muted-foreground tabular">
              {i + 1}.
            </span>
            <span className="font-medium">{FIELD_LABELS[id]}</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                className="app-btn h-7 px-2 text-xs"
                onClick={() => onMove(id, -1)}
                disabled={i === 0}
                aria-label={`Move ${FIELD_LABELS[id]} up`}
              >
                ↑
              </button>
              <button
                type="button"
                className="app-btn h-7 px-2 text-xs"
                onClick={() => onMove(id, 1)}
                disabled={i === fields.length - 1}
                aria-label={`Move ${FIELD_LABELS[id]} down`}
              >
                ↓
              </button>
              <button
                type="button"
                className="app-btn h-7 px-2 text-xs"
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
      className="min-w-[120px] flex-1 rounded border border-dashed border-border bg-surface-2 px-2 py-1 text-[11px]"
    >
      {FIELD_LABELS[id]}
    </div>
  );
  return (
    <div className="mt-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap gap-2">{layout.row1.map(cell)}</div>
      <div className="mt-2 flex flex-wrap gap-2">{layout.row2.map(cell)}</div>
    </div>
  );
}

// re-export for coerceLayout unused warning suppression in strict builds
void coerceLayout;
