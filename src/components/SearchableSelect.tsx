import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

// Keyboard-first searchable dropdown. Designed for accounting grids:
//  - Tab / Shift+Tab moves between fields as normal (does not open menu)
//  - Type to filter; ArrowDown/Up highlights; Enter confirms selection
//  - Escape closes menu without selecting
//  - Enter with no menu open moves focus to next form control (via onEnter)

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
}

export interface SearchableSelectProps {
  options: ComboOption[];
  value: string | null;
  onChange: (opt: ComboOption | null) => void;
  onEnter?: () => void;
  placeholder?: string;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  onEnter,
  placeholder,
  loading,
  disabled,
  className,
  ariaLabel,
}: SearchableSelectProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((o) => o.value === value) ?? null,
    [options, value],
  );

  // If the input is not focused, display the label of the current selection.
  const [focused, setFocused] = useState(false);
  const shownValue = focused ? query : (selected?.label ?? "");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 200);
    return options
      .filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          o.value.toLowerCase().includes(q) ||
          (o.hint ?? "").toLowerCase().includes(q),
      )
      .slice(0, 200);
  }, [options, query]);

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered.length, highlight]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const commit = (opt: ComboOption | null) => {
    onChange(opt);
    setQuery("");
    setOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (e.key === "Enter") {
      // Prevent Enter from submitting the surrounding form.
      e.preventDefault();
      e.stopPropagation();
      if (open && filtered[highlight]) {
        commit(filtered[highlight]);
        return;
      }
      onEnter?.();
      return;
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        className="app-input"
        placeholder={placeholder}
        value={shownValue}
        disabled={disabled}
        onFocus={() => {
          setFocused(true);
          setQuery(selected?.label ?? "");
          setOpen(true);
          // Select text for quick overwrite
          requestAnimationFrame(() => inputRef.current?.select());
        }}
        onBlur={() => {
          setFocused(false);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={handleKeyDown}
      />
      {selected && !focused && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => commit(null)}
          aria-label="Clear"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
        >
          ×
        </button>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full min-w-[220px] overflow-auto rounded-md border border-border-strong bg-surface shadow-lg"
        >
          {loading && (
            <li className="px-3 py-2 text-xs text-muted-foreground">Loading…</li>
          )}
          {!loading && filtered.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">No matches</li>
          )}
          {filtered.map((opt, i) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={i === highlight}
              className={`cursor-pointer px-3 py-1.5 text-sm ${
                i === highlight ? "bg-primary text-primary-foreground" : ""
              }`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(opt);
              }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{opt.label}</span>
                {opt.hint && (
                  <span className="text-[11px] text-muted-foreground">
                    {opt.hint}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
