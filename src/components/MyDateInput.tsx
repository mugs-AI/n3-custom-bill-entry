import { useEffect, useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";
import { autoFormatMy, isoToMy, myToIso, todayISOInKL } from "@/lib/date-my";

// Reusable Malaysian date input.
//  - Display / typed format: dd/mm/yyyy
//  - Wire (parent) format:  ISO yyyy-mm-dd
//  - Calendar popover uses shadcn `Calendar` (react-day-picker) so the UI
//    never falls back to native <input type="date"> which renders in the
//    browser locale (US = mm/dd/yyyy).
//  - Default month for the calendar is today in Asia/Kuala_Lumpur.

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

// Parse yyyy-mm-dd as a *local* Date so react-day-picker's day comparison
// (which is local-time) lines up with the ISO value we exchange with the API.
function isoToLocalDate(iso: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function localDateToIso(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
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
  const [open, setOpen] = useState(false);

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

  const selectedDate = isoToLocalDate(value);
  const defaultMonth = selectedDate ?? isoToLocalDate(todayISOInKL());

  return (
    <div className={cn("relative", className)}>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        className="app-input tabular pr-9"
        aria-label={ariaLabel}
        aria-invalid={!!error || undefined}
        placeholder={placeholder}
        value={text}
        maxLength={10}
        onChange={(e) => {
          const formatted = autoFormatMy(e.target.value);
          setText(formatted);
          if (formatted.length === 10) commit(formatted);
        }}
        onBlur={() => commit(text)}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Open calendar"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <CalendarIcon className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="end">
          <Calendar
            mode="single"
            selected={selectedDate}
            defaultMonth={defaultMonth}
            onSelect={(d) => {
              if (!d) return;
              const iso = localDateToIso(d);
              onChange(iso);
              setText(isoToMy(iso));
              setError(null);
              setOpen(false);
            }}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>
      {error && (
        <p className="mt-1 text-[11px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
