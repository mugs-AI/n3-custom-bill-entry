import { useEffect, useState } from "react";
import { autoFormatMy, isoToMy, myToIso } from "@/lib/date-my";

// Reusable Malaysian date input. Displays and accepts dd/mm/yyyy.
// Communicates with parent using ISO yyyy-mm-dd (API/transport format).
// Rejects invalid or ambiguous dates on blur.

export interface MyDateInputProps {
  /** ISO yyyy-mm-dd. Empty string when cleared. */
  value: string;
  onChange: (iso: string) => void;
  id?: string;
  required?: boolean;
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
}

export function MyDateInput({
  value,
  onChange,
  id,
  required,
  ariaLabel,
  className,
  placeholder = "dd/mm/yyyy",
}: MyDateInputProps) {
  const [text, setText] = useState(() => isoToMy(value));
  const [error, setError] = useState<string | null>(null);

  // Sync when parent value changes (e.g. Reset).
  useEffect(() => {
    setText(isoToMy(value));
    setError(null);
  }, [value]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setError(required ? "Required" : null);
      onChange("");
      return;
    }
    const iso = myToIso(trimmed);
    if (!iso) {
      setError("Use dd/mm/yyyy");
      return;
    }
    setError(null);
    onChange(iso);
  };

  return (
    <div className={className}>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        className="app-input tabular"
        aria-label={ariaLabel}
        aria-invalid={!!error || undefined}
        placeholder={placeholder}
        value={text}
        maxLength={10}
        onChange={(e) => {
          const formatted = autoFormatMy(e.target.value);
          setText(formatted);
          // Commit as soon as we have a full valid date so downstream reads
          // stay in sync without waiting for blur.
          if (formatted.length === 10) commit(formatted);
        }}
        onBlur={() => commit(text)}
      />
      {error && (
        <p className="mt-1 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
