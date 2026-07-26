import { describe, it, expect } from "vitest";
import { normalizePurchaseBook, purchaseBookDocCodes } from "../purchase-book";

// Phase 3B focused tests — items 1-4 of the mandated test coverage.

const MODEL = {
  detailItems: [
    { docCode: "PI001", isCancelled: false, supplierCode: "S1" },
    { docCode: "PI002", isCancelled: true, supplierCode: "S2" },
    { docCode: "PI003", isCancelled: false, supplierCode: "S3" },
  ],
  postingSummary: [
    { accountCode: "2100", accountName: "Creditors", amount: -985 },
    { accountCode: "6110", accountName: "Materials", amount: 900 },
    { accountCode: "5210", accountName: "Input Tax", amount: 85 },
  ],
};

describe("normalizePurchaseBook", () => {
  it("unwraps { data: [PurchaseBookReportModel] } (live shape)", () => {
    const r = normalizePurchaseBook({
      success: true,
      code: "0000",
      data: [MODEL],
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error();
    expect(r.detailItems).toHaveLength(3);
    expect(r.postingSummary).toHaveLength(3);
    expect(r.models).toBe(1);
  });

  it("unwraps a LoadResult { data: { data: [model], totalCount } }", () => {
    const r = normalizePurchaseBook({
      success: true,
      data: { data: [MODEL], totalCount: 1 },
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error();
    expect(r.detailItems.map((d) => d.docCode)).toEqual(["PI001", "PI002", "PI003"]);
  });

  it("returns contract-mismatch on an unsupported shape", () => {
    const r = normalizePurchaseBook({ success: true, data: "hello" });
    expect(r.kind).toBe("contract-mismatch");
    if (r.kind === "contract-mismatch") {
      expect(r.reason).toBeTruthy();
      expect(r.shape).toBeTruthy();
    }
  });

  it("empty posting rows are not silently treated as balanced", () => {
    // A well-formed but empty PurchaseBook is still OK, but its posting
    // summary being empty must be visible so the audit reconciler can
    // refuse to certify balance.
    const r = normalizePurchaseBook({
      success: true,
      data: [{ detailItems: [], postingSummary: [] }],
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error();
    expect(r.postingSummary).toHaveLength(0);
    expect(r.detailItems).toHaveLength(0);
  });

  it("purchaseBookDocCodes excludes cancelled rows", () => {
    const r = normalizePurchaseBook({ success: true, data: [MODEL] });
    if (r.kind !== "ok") throw new Error();
    expect(purchaseBookDocCodes(r).sort()).toEqual(["PI001", "PI003"]);
  });
});
