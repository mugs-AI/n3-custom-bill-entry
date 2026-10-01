// Correction H §3: after a re-sync, a previously selected N3 record may no
// longer be returned by N3 (deleted or made inactive). We never clear the
// user's selection — we keep the ID/label in the draft, flag the field and
// block only the final save.

export const STALE_SELECTION_MESSAGE =
  "This selected N3 record is no longer active or available. Select another record before saving.";

export interface HasValue {
  value: string;
}

/**
 * True when a selection should be flagged: a value is selected, the list was
 * loaded successfully (so an empty list from a failed fetch never flags), and
 * the value is absent from the refreshed options.
 */
export function isStaleSelection(
  selected: string | number | null | undefined,
  options: readonly HasValue[],
  listLoaded: boolean,
): boolean {
  if (selected == null || selected === "") return false;
  if (!listLoaded) return false;
  const want = String(selected);
  return !options.some((o) => o.value === want);
}

export interface LabelSource {
  value: string;
  label: string;
}

/**
 * Prefer the freshly fetched master label so renamed records display their new
 * name, while keeping the selected ID. Falls back to the label captured in the
 * draft when the record is no longer returned.
 */
export function resolveDisplayLabel(
  selected: string | number | null | undefined,
  options: readonly LabelSource[],
  draftLabel: string,
): string {
  if (selected == null || selected === "") return "";
  const hit = options.find((o) => o.value === String(selected));
  return hit ? hit.label : draftLabel;
}