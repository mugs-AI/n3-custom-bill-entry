import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runPrintSequence } from "../print-ready";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("Correction G — print readiness sequence", () => {
  it("waits for document.fonts.ready before printing", async () => {
    const order: string[] = [];
    let resolveFonts: () => void = () => {};
    const fonts = new Promise<void>((r) => {
      resolveFonts = () => {
        order.push("fonts");
        r();
      };
    });
    const run = runPrintSequence({
      fontsReady: () => fonts,
      raf: (cb) => setTimeout(cb, 0),
      isMounted: () => true,
      print: () => order.push("print"),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([]);
    resolveFonts();
    await run;
    expect(order).toEqual(["fonts", "print"]);
  });

  it("waits for two animation frames", async () => {
    let frames = 0;
    let framesAtPrint = -1;
    await runPrintSequence({
      raf: (cb) => {
        frames += 1;
        setTimeout(cb, 0);
      },
      isMounted: () => true,
      print: () => {
        framesAtPrint = frames;
      },
    });
    expect(framesAtPrint).toBe(2);
  });

  it("does not print when the report root is not mounted", async () => {
    let printed = 0;
    const ok = await runPrintSequence({
      raf: (cb) => setTimeout(cb, 0),
      isMounted: () => false,
      print: () => (printed += 1),
    });
    expect(ok).toBe(false);
    expect(printed).toBe(0);
  });

  it("applies the @page style before calling print", async () => {
    const order: string[] = [];
    await runPrintSequence({
      raf: (cb) => setTimeout(cb, 0),
      isMounted: () => true,
      applyPageStyle: () => order.push("page-style"),
      print: () => order.push("print"),
    });
    expect(order).toEqual(["page-style", "print"]);
  });

  it("survives a rejecting fonts promise", async () => {
    let printed = 0;
    await runPrintSequence({
      fontsReady: () => Promise.reject(new Error("no fonts")),
      raf: (cb) => setTimeout(cb, 0),
      isMounted: () => true,
      print: () => (printed += 1),
    });
    expect(printed).toBe(1);
  });
});

describe("Correction G — shared print helper wiring", () => {
  const hook = read("src/hooks/use-report-print-settings.ts");

  it("the hook guards against a double print while preparing", () => {
    expect(hook).toContain("if (busy.current) return;");
    expect(hook).toContain("setPreparing(true)");
  });

  it("afterprint restores the button state", () => {
    expect(hook).toContain('window.addEventListener("afterprint"');
  });

  it("both the single report and Print All use the same helper", () => {
    for (const f of [
      "src/routes/reports_.purchase.$view.tsx",
      "src/routes/reports_.purchase.print-all.tsx",
    ]) {
      const src = read(f);
      expect(src).toContain("usePrintReport(reportRootRef)");
      expect(src).toContain("Preparing print…");
      expect(src).not.toContain("window.print()");
    }
  });

  it("only one dynamic @page style element is ever created", () => {
    const lib = read("src/lib/report-print-settings.ts");
    expect(lib).toContain("custom-bill-entry-print-page-style");
    expect(lib).toContain("document.getElementById(PRINT_PAGE_STYLE_ID)");
    const appends = lib.match(/appendChild\(/g) ?? [];
    expect(appends.length).toBe(1);
  });
});

describe("Correction G — print CSS guardrails", () => {
  const css = read("src/styles.css");
  const printBlock = css.slice(css.indexOf("@media print"));

  it("cancels screen-only table minimum widths in print", () => {
    expect(printBlock).toMatch(/table\[class\*="min-w-"\][\s\S]{0,200}min-width:\s*0\s*!important/);
  });

  it("makes overflow wrappers visible in print", () => {
    expect(printBlock).toMatch(/overflow-x-auto[\s\S]{0,240}overflow:\s*visible\s*!important/);
  });

  it("clamps every print root to the printable width", () => {
    expect(printBlock).toMatch(/\.print-all-container,[\s\S]{0,200}max-width:\s*100%\s*!important/);
    expect(printBlock).toMatch(/box-sizing:\s*border-box\s*!important/);
    expect(printBlock).toMatch(/min-width:\s*0\s*!important/);
  });

  it("uses the configurable body font size variable for result tables", () => {
    expect(printBlock).toMatch(/font-size:\s*var\(--print-body-pt,\s*7\.5pt\)/);
  });

  it("keeps screen horizontal scrolling intact outside print", () => {
    const screenPart = css.slice(0, css.indexOf("@media print"));
    expect(screenPart).not.toContain("overflow: visible !important");
  });
});
