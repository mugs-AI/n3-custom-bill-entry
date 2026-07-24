import { describe, it, expect } from "vitest";
import {
  buildHistoryFilter,
  escapeODataString,
  isEmptyFilter,
} from "../history-query";

describe("history-query.buildHistoryFilter", () => {
  it("returns null when no criteria are provided", () => {
    expect(buildHistoryFilter({})).toBeNull();
    expect(isEmptyFilter({})).toBe(true);
  });

  it("emits inclusive docDate bounds", () => {
    const s = buildHistoryFilter({ dateFrom: "2026-07-01", dateTo: "2026-07-24" });
    expect(s).toContain("docDate ge 2026-07-01T00:00:00Z");
    expect(s).toContain("docDate le 2026-07-24T23:59:59Z");
    expect(s).toContain(" and ");
  });

  it("ignores malformed date strings instead of injecting them", () => {
    const s = buildHistoryFilter({ dateFrom: "yesterday" as string, dateTo: "" });
    expect(s).toBeNull();
  });

  it("wraps substring matches in tolower(contains(...))", () => {
    const s = buildHistoryFilter({ docCode: "PI-001" });
    expect(s).toBe("contains(tolower(docCode),tolower('PI-001'))");
  });

  it("escapes single quotes in substring values", () => {
    expect(escapeODataString("O'Reilly")).toBe("O''Reilly");
    const s = buildHistoryFilter({ description: "O'Reilly" });
    expect(s).toContain("'O''Reilly'");
  });

  it("emits exact equality for supplierId / purchaserId", () => {
    const s = buildHistoryFilter({ supplierId: 42, purchaserId: 7 });
    expect(s).toContain("supplierId eq 42");
    expect(s).toContain("purchaserId eq 7");
  });

  it("skips supplier/purchaser id filter when value is not a positive number", () => {
    const s = buildHistoryFilter({
      supplierId: 0,
      purchaserId: Number.NaN,
    });
    expect(s).toBeNull();
  });

  it("maps status to isCancelled", () => {
    expect(buildHistoryFilter({ status: "active" })).toBe("isCancelled eq false");
    expect(buildHistoryFilter({ status: "cancelled" })).toBe("isCancelled eq true");
    expect(buildHistoryFilter({ status: "all" })).toBeNull();
  });

  it("combines multiple criteria with ' and '", () => {
    const s = buildHistoryFilter({
      dateFrom: "2026-07-01",
      supplierId: 5,
      status: "active",
      docCode: "PI",
    });
    // Order of parts is stable — assert each fragment is present.
    expect(s).toContain("docDate ge 2026-07-01T00:00:00Z");
    expect(s).toContain("supplierId eq 5");
    expect(s).toContain("isCancelled eq false");
    expect(s).toContain("contains(tolower(docCode),tolower('PI'))");
    expect(s?.split(" and ").length).toBe(4);
  });
});
