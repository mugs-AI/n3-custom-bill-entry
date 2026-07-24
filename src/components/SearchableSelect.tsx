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
// Two modes:
//  - default: trigger input is the search box (compact for grid cells,
//    used for Supplier/Purchaser/Term where behavior must not regress).
//  - withPopoverSearch: the trigger is a display of the committed label;
//    an autofocused search input lives at the top of the popover. This
//    is used for line dropdowns (WBS, GL, Cost Centre, HQ Tax, Order No.)
//    so the search box is always clearly visible.
//
// Selecting an option commits immediately; the input shows the label BEFORE
// any parent effect resolves. Arrow / Home / End move the highlight and
// always scrollIntoView it. Enter commits the highlighted option (or calls
// onEnter if no dropdown is open). We preventDefault so form submission
// never fires, but we do NOT stopPropagation — the enclosing grid handler
// listens for Enter to advance focus to the next field.

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
  /**
   * When true, render an autofocused search input at the top of the popover
   * and turn the trigger into a display of the committed label. Keyboard
   * navigation continues to work identically.
   */
  withPopoverSearch?: boolean;
  /** Shown as an empty-state hint when options.length === 0 and !loading. */
  emptyMessage?: string;
  /**
   * Minimum popover width in CSS pixels. Applies only when popoverPortal is
   * true. Clamped to the viewport so the popover always stays on screen.
   * Used to give Supplier/WBS/GL dropdowns enough room to render one-line
   * option labels without truncation.
   */
  minPopoverWidth?: number;
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
  withPopoverSearch,
  emptyMessage,
  minPopoverWidth,
}: SearchableSelectProps) {
  const listId = useId();
  const optId = (i: number) => `${listId}-opt-${i}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
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

  // Autofocus the popover search input when opened in withPopoverSearch mode.
  useEffect(() => {
    if (!open || !withPopoverSearch) return;
    // requestAnimationFrame lets the portal mount before we focus.
    const raf = requestAnimationFrame(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, withPopoverSearch]);

  // Position the portal popover under the input, using fixed coords so an
  // ancestor scroll container cannot clip it. Reposition on scroll/resize.
  useLayoutEffect(() => {
    if (!open || !popoverPortal) return;
    const update = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const margin = 12;
      const requested = Math.max(r.width, minPopoverWidth ?? 260);
      const maxWidth = Math.max(240, vw - margin * 2);
      const width = Math.min(requested, maxWidth);
      let left = r.left;
      if (left + width > vw - margin) left = Math.max(margin, vw - margin - width);
      setPopStyle({
        position: "fixed",
        top: Math.round(r.bottom + 4),
        left: Math.round(left),
        width: Math.round(width),
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
  }, [open, popoverPortal, filtered.length, minPopoverWidth]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
      setQuery(null);
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
          // Return focus to the trigger so subsequent Tab works predictably.
          if (withPopoverSearch) inputRef.current?.focus();
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

  const searchBox = withPopoverSearch ? (
    <div className="sticky top-0 z-10 border-b border-border bg-surface p-2">
      <input
        ref={searchRef}
        type="text"
        role="searchbox"
        aria-controls={listId}
        aria-label={`${ariaLabel ?? "Options"} search`}
        placeholder="Search code or name"
        className="app-input h-8 px-2 py-1 text-[13px]"
        value={query ?? ""}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={handleKeyDown}
      />
    </div>
  ) : null;

  // ~7 rows visible: 7 * 32px option + 8px padding.
  const listMaxHeight = 232;

  const listUl = (
    <ul
      id={listId}
      ref={listRef}
      role="listbox"
      className="overflow-auto"
      style={{ maxHeight: listMaxHeight }}
    >
      {loading && (
        <li className="px-3 py-2 text-xs text-muted-foreground">Loading…</li>
      )}
      {!loading && filtered.length === 0 && (
        <li className="px-3 py-2 text-xs text-muted-foreground">
          {options.length === 0 && emptyMessage ? emptyMessage : "No matches"}
        </li>
      )}
      {filtered.map((opt, i) => (
        <li
          key={opt.value}
          id={optId(i)}
          role="option"
          aria-selected={opt.value === value}
          title={opt.hint ? `${opt.label}  ·  ${opt.hint}` : opt.label}
          className={`flex h-8 cursor-pointer items-center gap-3 px-3 text-sm ${
            i === highlight ? "bg-primary text-primary-foreground" : ""
          }`}
          onMouseEnter={() => setHighlight(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            commit(opt);
          }}
        >
          <span className="min-w-0 flex-1 truncate font-medium">{opt.label}</span>
          {opt.hint && (
            <span
              className={`shrink-0 truncate text-[11px] ${
                i === highlight ? "text-primary-foreground/80" : "text-muted-foreground"
              }`}
              style={{ maxWidth: "40%" }}
            >
              {opt.hint}
            </span>
          )}
        </li>
      ))}
    </ul>
  );

  const popover = (
    <div
      ref={popRef}
      style={popoverPortal ? popStyle : undefined}
      className={
        popoverPortal
          ? "rounded-md border border-border-strong bg-surface shadow-lg"
          : "absolute z-30 mt-1 w-full min-w-[240px] rounded-md border border-border-strong bg-surface shadow-lg"
      }
    >
      {searchBox}
      {listUl}
    </div>
  );

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete={withPopoverSearch ? "none" : "list"}
        aria-label={ariaLabel}
        aria-activedescendant={
          open && filtered[highlight] ? optId(highlight) : undefined
        }
        readOnly={withPopoverSearch}
        className={compact ? "app-input h-8 px-2 py-1 text-[13px]" : "app-input"}
        placeholder={placeholder}
        value={shownValue}
        disabled={disabled}
        onFocus={() => {
          setOpen(true);
          if (!withPopoverSearch) {
            requestAnimationFrame(() => inputRef.current?.select());
          }
        }}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          if (withPopoverSearch) return;
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={handleKeyDown}
      />
      {committedLabel && !open && !compact && !withPopoverSearch && (
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
          ? createPortal(popover, document.body)
          : popover)}
    </div>
  );
}
