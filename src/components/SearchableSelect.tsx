import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

// Keyboard-first accessible combobox/listbox.
//
// Behaviour contract (Phase 1 Correction B):
//  - Selecting an option commits immediately: the visible text updates to the
//    selected label BEFORE any parent effect (e.g. detail fetch) resolves.
//    We do NOT rely on the input losing focus to reveal the selected label.
//  - `query` is null unless the user is actively editing; the display then
//    falls back to `selectedLabel` (parent-supplied) or the label found in
//    `options` for `value`.
//  - Arrow keys / Home / End move the active option and always scroll it into
//    view (`scrollIntoView({ block: "nearest" })`) so the highlight stays
//    visible past the initial viewport of the popover.
//  - preventDefault on all navigation keys stops the page itself from
//    scrolling.
//  - `aria-activedescendant` links input focus to the active option; roles
//    combobox / listbox / option are applied per WAI-ARIA APG.

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
  /**
   * Optional label to display for the currently-selected value when it may
   * not yet exist in `options` (e.g. selection made from an outer list while
   * the option list is still hydrating). Falls back to a lookup in `options`.
   */
  selectedLabel?: string | null;
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
  selectedLabel,
}: SearchableSelectProps) {
  const listId = useId();
  const optId = (i: number) => `${listId}-opt-${i}`;
  const [open, setOpen] = useState(false);
  // `null` = not editing; the display then shows the committed label.
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const committedLabel = useMemo(() => {
    if (selectedLabel != null) return selectedLabel;
    const hit = options.find((o) => o.value === value);
    return hit?.label ?? "";
  }, [options, value, selectedLabel]);

  const shownValue = query ?? committedLabel;

  const filtered = useMemo(() => {
    const q = (query ?? "").trim().toLowerCase();
    if (!q) return options.slice(0, 500);
    return options
      .filter(
        (o) =>
          o.label.toLowerCase().includes(q) ||
          o.value.toLowerCase().includes(q) ||
          (o.hint ?? "").toLowerCase().includes(q),
      )
      .slice(0, 500);
  }, [options, query]);

  // Keep highlight in range as the filtered list changes.
  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered.length, highlight]);

  // Scroll the active option into view whenever it changes while open.
  useEffect(() => {
    if (!open) return;
    const ul = listRef.current;
    if (!ul) return;
    const el = ul.querySelector<HTMLElement>(`#${CSS.escape(optId(highlight))}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open, filtered.length]);

  // Close on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const commit = (opt: ComboOption | null) => {
    // Commit synchronously: parent receives new value AND our own display
    // stops showing the query, so the label appears on the very next render.
    onChange(opt);
    setQuery(null);
    setOpen(false);
    setHighlight(0);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setOpen(true);
        setHighlight((h) =>
          Math.min(h + 1, Math.max(0, filtered.length - 1)),
        );
        return;
      case "ArrowUp":
        e.preventDefault();
        setOpen(true);
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      case "Home":
        if (open) {
          e.preventDefault();
          setHighlight(0);
        }
        return;
      case "End":
        if (open) {
          e.preventDefault();
          setHighlight(Math.max(0, filtered.length - 1));
        }
        return;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
          setQuery(null);
        }
        return;
      case "Enter":
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
        aria-activedescendant={
          open && filtered[highlight] ? optId(highlight) : undefined
        }
        className="app-input"
        placeholder={placeholder}
        value={shownValue}
        disabled={disabled}
        onFocus={() => {
          setOpen(true);
          // Select existing text so typing replaces it, but leave `query`
          // as-null so the committed label stays visible until the user
          // actually edits.
          requestAnimationFrame(() => inputRef.current?.select());
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={handleKeyDown}
      />
      {committedLabel && !open && (
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={(e) => {
            e.preventDefault();
            commit(null);
          }}
          aria-label="Clear"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
        >
          ×
        </button>
      )}
      {open && (
        <ul
          id={listId}
          ref={listRef}
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
              id={optId(i)}
              role="option"
              aria-selected={opt.value === value}
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
