import { describe, it, expect } from "vitest";
import { computeLine, sumTo2dp, round2 } from "../money";

describe("round2", () => {
  it("rounds half away from zero", () => {
    expect(round2(0.005)).toBe(0.01);
    expect(round2(-0.005)).toBe(-0.01);
    expect(round2(0.004)).toBe(0);
  });
});

describe("computeLine — tax exclusive", () => {
  it("PT-10% · qty 2 · price 33 → net 66 · tax 6.60 · grand 72.60", () => {
    const a = computeLine({ qty: "2", unitPrice: "33.00", rate: 10, inclusive: false });
    expect(a.net).toBe(66);
    expect(a.tax).toBe(6.6);
    expect(a.grand).toBe(72.6);
  });
  it("PT-5% · qty 2 · price 100 → net 200 · tax 10 · grand 210", () => {
    const a = computeLine({ qty: "2", unitPrice: "100.00", rate: 5, inclusive: false });
    expect(a.net).toBe(200);
    expect(a.tax).toBe(10);
    expect(a.grand).toBe(210);
  });
  it("zero rate → tax 0, grand equals net", () => {
    const a = computeLine({ qty: "3", unitPrice: "10", rate: 0, inclusive: false });
    expect(a.tax).toBe(0);
    expect(a.net).toBe(30);
    expect(a.grand).toBe(30);
  });
  it("null rate (no tax code) → tax 0", () => {
    const a = computeLine({ qty: "3", unitPrice: "10", rate: null, inclusive: false });
    expect(a.tax).toBe(0);
    expect(a.grand).toBe(30);
  });
});

describe("computeLine — tax inclusive", () => {
  it("PT-10% · qty 2 · price 33 → net 60 · tax 6.00 · grand 66", () => {
    const a = computeLine({ qty: "2", unitPrice: "33.00", rate: 10, inclusive: true });
    expect(a.grand).toBe(66);
    expect(a.tax).toBe(6);
    expect(a.net).toBe(60);
  });
  it("PT-5% · qty 2 · price 100 → net 190.48 · tax 9.52 · grand 200", () => {
    const a = computeLine({ qty: "2", unitPrice: "100.00", rate: 5, inclusive: true });
    expect(a.grand).toBe(200);
    expect(a.tax).toBe(9.52);
    expect(a.net).toBe(190.48);
  });
});

describe("document totals", () => {
  it("exclusive sums: 66+200 net, 6.60+10 tax", () => {
    const l1 = computeLine({ qty: "2", unitPrice: "33.00", rate: 10, inclusive: false });
    const l2 = computeLine({ qty: "2", unitPrice: "100.00", rate: 5, inclusive: false });
    expect(sumTo2dp([l1.net, l2.net])).toBe(266);
    expect(sumTo2dp([l1.tax, l2.tax])).toBe(16.6);
    expect(sumTo2dp([l1.grand, l2.grand])).toBe(282.6);
  });
  it("inclusive sums: 60+190.48 net, 6.00+9.52 tax", () => {
    const l1 = computeLine({ qty: "2", unitPrice: "33.00", rate: 10, inclusive: true });
    const l2 = computeLine({ qty: "2", unitPrice: "100.00", rate: 5, inclusive: true });
    expect(sumTo2dp([l1.net, l2.net])).toBe(250.48);
    expect(sumTo2dp([l1.tax, l2.tax])).toBe(15.52);
    expect(sumTo2dp([l1.grand, l2.grand])).toBe(266);
  });
});
