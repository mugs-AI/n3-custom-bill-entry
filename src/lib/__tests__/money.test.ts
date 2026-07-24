import { describe, it, expect } from "vitest";
import { computeLine, sumTo2dp, round2 } from "../money";

describe("round2", () => {
  it("rounds half away from zero", () => {
    expect(round2(0.005)).toBe(0.01);
    expect(round2(-0.005)).toBe(-0.01);
    expect(round2(0.004)).toBe(0);
  });
});

// N3 TaxCodeLookupDto.rate is a decimal factor (0.05 for PT-5%, 0.10 for PT-10%).
// These tests lock the rate-factor contract that the whole app depends on.
describe("computeLine — tax exclusive (rateFactor)", () => {
  it("PT-5% factor 0.05 on Net 100.00 → Tax 5.00 · Grand 105.00", () => {
    const a = computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.05, inclusive: false });
    expect(a.net).toBe(100);
    expect(a.tax).toBe(5);
    expect(a.grand).toBe(105);
  });
  it("PT-10% factor 0.10 on Net 100.00 → Tax 10.00 · Grand 110.00", () => {
    const a = computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.1, inclusive: false });
    expect(a.net).toBe(100);
    expect(a.tax).toBe(10);
    expect(a.grand).toBe(110);
  });
  it("zero rate → tax 0, grand equals net", () => {
    const a = computeLine({ qty: "3", unitPrice: "10", rateFactor: 0, inclusive: false });
    expect(a.tax).toBe(0);
    expect(a.net).toBe(30);
    expect(a.grand).toBe(30);
  });
  it("null rate (no tax code) → tax 0", () => {
    const a = computeLine({ qty: "3", unitPrice: "10", rateFactor: null, inclusive: false });
    expect(a.tax).toBe(0);
    expect(a.grand).toBe(30);
  });
});

describe("computeLine — tax inclusive (rateFactor)", () => {
  it("PT-5% factor 0.05 on Gross 100.00 → Net 95.24 · Tax 4.76", () => {
    const a = computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.05, inclusive: true });
    expect(a.grand).toBe(100);
    expect(a.tax).toBe(4.76);
    expect(a.net).toBe(95.24);
  });
  it("PT-10% factor 0.10 on Gross 100.00 → Net 90.91 · Tax 9.09", () => {
    const a = computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.1, inclusive: true });
    expect(a.grand).toBe(100);
    expect(a.tax).toBe(9.09);
    expect(a.net).toBe(90.91);
  });
});

describe("four-line acceptance totals (Phase 2B Correction B)", () => {
  it("exclusive: 400.00 / 30.00 / 430.00", () => {
    const lines = [
      computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.05, inclusive: false }),
      computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.05, inclusive: false }),
      computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.1, inclusive: false }),
      computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.1, inclusive: false }),
    ];
    expect(sumTo2dp(lines.map((l) => l.net))).toBe(400);
    expect(sumTo2dp(lines.map((l) => l.tax))).toBe(30);
    expect(sumTo2dp(lines.map((l) => l.grand))).toBe(430);
  });
  it("inclusive: 372.30 / 27.70 / 400.00", () => {
    const lines = [
      computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.05, inclusive: true }),
      computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.05, inclusive: true }),
      computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.1, inclusive: true }),
      computeLine({ qty: "1", unitPrice: "100.00", rateFactor: 0.1, inclusive: true }),
    ];
    expect(sumTo2dp(lines.map((l) => l.net))).toBe(372.3);
    expect(sumTo2dp(lines.map((l) => l.tax))).toBe(27.7);
    expect(sumTo2dp(lines.map((l) => l.grand))).toBe(400);
  });
});
