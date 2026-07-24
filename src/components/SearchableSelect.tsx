import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

// Keyboard-first accessible combobox/listbox.
//
// Behaviour contract:
//  - Selecting an option commits immediately; the input shows the label BEFORE
//    any parent effect resolves. `query` stays null unless the user is editing.
//  - Arrow / Home / End move the highlight and always scrollIntoView it.
//  - Enter commits the highlighted option (or calls onEnter if no dropdown is
//    open). We preventDefault so form submission never fires, but we do NOT
//    stopPropagation — the enclosing grid handler listens for Enter to advance
//    focus to the next field. That makes the whole row navigate on Enter.
//  - `popoverPortal` renders the option list in a fixed-positioned portal so
//    it escapes clipping by an ancestor `overflow-*` container (the invoice
//    detail grid needs horizontal scroll but the popover must remain visible).

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
  selectedLabel?: string | null;
  /** Render the popover via a document portal with fixed positioning. */
  popoverPortal?: boolean;
  /** Optional visual variant for embedded grid cells (removes chrome). */
  compact?: boolean;
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
  popoverPortal,
  compact,
}: SearchableSelectProps) {
  const listId = useId();
  const optId = (i: number) => `${listId}-opt-${i}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [popStyle, setPopStyle] = useState<CSSProperties>({});

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

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0);
  }, [filtered.length, highlight]);

  useEffect(() => {
    if (!open) return;
    const ul = listRef.current;
    if (!ul) return;
    const el = ul.querySelector<HTMLElement>(`#${CSS.escape(optId(highlight))}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open, filtered.length]);

  // Position the portal popover under the input, using fixed coords so an
  // ancestor scroll container cannot clip it. Reposition on scroll/resize.
  useLayoutEffect(() => {
    if (!open || !popoverPortal) return;
    const update = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPopStyle({
        position: "fixed",
        top: Math.round(r.bottom + 4),
        left: Math.round(r.left),
        width: Math.round(Math.max(r.width, 240)),
        zIndex: 60,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, popoverPortal, filtered.length]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const commit = (opt: ComboOption | null) => {
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
        setHighlight((h) => Math.min(h + 1, Math.max(0, filtered.length - 1)));
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
        // preventDefault stops form submission. Do NOT stopPropagation — the
        // enclosing grid uses Enter to advance focus to the next field.
        e.preventDefault();
        if (open && filtered[highlight]) {
          commit(filtered[highlight]);
        }
        onEnter?.();
        return;
    }
  };

  const list = (
    <ul
      id={listId}
      ref={listRef}
      role="listbox"
      style={popoverPortal ? popStyle : undefined}
      className={
        popoverPortal
          ? "max-h-64 overflow-auto rounded-md border border-border-strong bg-surface shadow-lg"
          : "absolute z-30 mt-1 max-h-64 w-full min-w-[220px] overflow-auto rounded-md border border-border-strong bg-surface shadow-lg"
      }
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
  );

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
        className={compact ? "app-input h-8 px-2 py-1 text-[13px]" : "app-input"}
        placeholder={placeholder}
        value={shownValue}
        disabled={disabled}
        onFocus={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.select());
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={handleKeyDown}
      />
      {committedLabel && !open && !compact && (
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
      {open &&
        (popoverPortal && typeof document !== "undefined"
          ? createPortal(list, document.body)
          : list)}
    </div>
  );
}
