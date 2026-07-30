import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PRINT_SETTINGS,
  PRINT_SETTINGS_EVENT,
  applyPrintPageStyle,
  loadPrintSettings,
  type ReportPrintSettings,
} from "@/lib/report-print-settings";
import { runPrintSequence } from "@/lib/print-ready";

/** Client-only reader for the saved report print settings. */
export function useReportPrintSettings(): ReportPrintSettings {
  const [settings, setSettings] = useState<ReportPrintSettings>(DEFAULT_PRINT_SETTINGS);
  useEffect(() => {
    const read = () => setSettings(loadPrintSettings());
    read();
    window.addEventListener(PRINT_SETTINGS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PRINT_SETTINGS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return settings;
}

/** CSS custom properties applied to a report root so print CSS can read them. */
export function reportPrintStyleVars(s: ReportPrintSettings): React.CSSProperties {
  return {
    ["--print-body-pt" as string]: `${s.bodyFontPt}pt`,
    ["--print-head-pt" as string]: `${Math.max(6, s.bodyFontPt - 0.75)}pt`,
  } as React.CSSProperties;
}

/**
 * Shared print trigger used by both the individual report Print button and
 * the Print All Print button.
 */
export function usePrintReport(rootRef: React.RefObject<HTMLElement | null>) {
  const settings = useReportPrintSettings();
  const [preparingPrint, setPreparing] = useState(false);
  const busy = useRef(false);

  // Keep the single dynamic @page element in sync with saved margins.
  useEffect(() => {
    applyPrintPageStyle(settings);
  }, [settings]);

  useEffect(() => {
    const done = () => {
      busy.current = false;
      setPreparing(false);
    };
    window.addEventListener("afterprint", done);
    return () => window.removeEventListener("afterprint", done);
  }, []);

  const print = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setPreparing(true);
    try {
      await runPrintSequence({
        fontsReady: () =>
          typeof document !== "undefined" && "fonts" in document
            ? (document as Document & { fonts: FontFaceSet }).fonts.ready
            : undefined,
        raf: (cb) =>
          typeof window.requestAnimationFrame === "function"
            ? window.requestAnimationFrame(() => cb())
            : window.setTimeout(cb, 0),
        isMounted: () => !!rootRef.current || typeof document === "undefined",
        applyPageStyle: () => applyPrintPageStyle(settings),
        print: () => window.print(),
      });
    } finally {
      // Fallback in case `afterprint` never fires (some mobile browsers).
      window.setTimeout(() => {
        busy.current = false;
        setPreparing(false);
      }, 0);
    }
  }, [rootRef, settings]);

  return { print, preparingPrint, settings, styleVars: reportPrintStyleVars(settings) };
}
