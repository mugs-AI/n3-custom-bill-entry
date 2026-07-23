// Malaysian date standard for the UI (dd/mm/yyyy) with strict ISO conversion
// (yyyy-mm-dd) at the API boundary. Defaults use Asia/Kuala_Lumpur.

const KL_TZ = "Asia/Kuala_Lumpur";

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Current date in Asia/Kuala_Lumpur as yyyy-mm-dd. */
export function todayISOInKL(now: Date = new Date()): string {
  // en-CA renders yyyy-mm-dd.
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: KL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return s;
}

/** Convert yyyy-mm-dd → dd/mm/yyyy. Returns "" for empty/invalid. */
export function isoToMy(iso: string): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Convert dd/mm/yyyy → yyyy-mm-dd if valid, else null. */
export function myToIso(display: string): string | null {
  const trimmed = display.trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (year < 1900 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Insert slashes as the user types digits: dd/mm/yyyy. */
export function autoFormatMy(input: string): string {
  const digits = input.replace(/\D/g, "").slice(0, 8);
  const parts: string[] = [];
  if (digits.length > 0) parts.push(digits.slice(0, Math.min(2, digits.length)));
  if (digits.length > 2) parts.push(digits.slice(2, Math.min(4, digits.length)));
  if (digits.length > 4) parts.push(digits.slice(4, 8));
  return parts.join("/");
}
