// Phase 3B Correction G — deterministic print trigger.
//
// A cold first print previously captured layout before webfonts and the
// report grid had settled. `runPrintSequence` waits for font loading and two
// layout frames, verifies the report root is mounted, then calls print once.

export interface PrintSequenceDeps {
  /** Resolves when webfonts are ready. Optional (older browsers). */
  fontsReady?: () => Promise<unknown> | undefined;
  /** Schedules a layout frame. */
  raf: (cb: () => void) => void;
  /** Returns true when the report root exists in the DOM. */
  isMounted: () => boolean;
  /** Applies the literal @page margins before printing. */
  applyPageStyle?: () => void;
  print: () => void;
}

export async function runPrintSequence(deps: PrintSequenceDeps): Promise<boolean> {
  try {
    const p = deps.fontsReady?.();
    if (p && typeof (p as Promise<unknown>).then === "function") await p;
  } catch {
    /* fonts API failure must not block printing */
  }
  // Two layout frames: first flushes style/layout, second guarantees paint.
  await new Promise<void>((resolve) => deps.raf(() => deps.raf(() => resolve())));
  if (!deps.isMounted()) return false;
  deps.applyPageStyle?.();
  deps.print();
  return true;
}
