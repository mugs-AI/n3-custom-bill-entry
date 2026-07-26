// Shared canonical key helpers for Phase 3B PB/PI/GL joins.
//
// One rule, used everywhere: NFKC-normalize, trim, uppercase. The canonical
// value is only ever used as a Map/Set key or for comparison — never rendered.
// Original N3-supplied strings are preserved for display so users see the
// exact document/account code the accounting system stored.

function canonicalize(value: unknown): string {
  if (typeof value !== "string") return "";
  const s = value.normalize("NFKC").trim();
  if (!s) return "";
  return s.toUpperCase();
}

export function canonicalDocCode(value: unknown): string {
  return canonicalize(value);
}

export function canonicalAccountCode(value: unknown): string {
  return canonicalize(value);
}
