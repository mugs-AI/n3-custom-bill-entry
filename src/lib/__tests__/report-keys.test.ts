import { describe, it, expect } from "vitest";
import { canonicalAccountCode, canonicalDocCode } from "../report-keys";

// Phase 3B Correction B — the canonical key helpers are the single source of
// truth for doc-code and account-code joins. If these tests regress, PB↔PI↔GL
// intersections silently drop rows.

describe("canonicalDocCode / canonicalAccountCode", () => {
  it("uppercases and trims", () => {
    expect(canonicalDocCode(" pi-001 ")).toBe("PI-001");
    expect(canonicalAccountCode(" s100 ")).toBe("S100");
  });

  it("folds NFKC width variants together", () => {
    // Full-width digits/letters used in some N3 payloads must collapse onto
    // the ASCII form so PB, PI and GL join.
    expect(canonicalDocCode("ＰＩ－００１")).toBe(canonicalDocCode("PI-001"));
    expect(canonicalAccountCode("Ｓ１００")).toBe(canonicalAccountCode("s100"));
  });

  it("returns empty string for non-string / empty inputs", () => {
    expect(canonicalDocCode(null)).toBe("");
    expect(canonicalDocCode(undefined)).toBe("");
    expect(canonicalDocCode(123)).toBe("");
    expect(canonicalDocCode("   ")).toBe("");
    expect(canonicalAccountCode(null)).toBe("");
  });
});
