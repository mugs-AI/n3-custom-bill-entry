import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import {
  MASTER_DATASET_COUNT,
  N3_MASTER_KEYS,
  N3_MASTER_LABELS,
  N3_SESSION_INFO_KEY,
  n3SupplierDetailKey,
  resyncTargets,
} from "@/lib/n3-master-keys";
import {
  createResyncGuard,
  formatSyncedAt,
  resyncMessage,
  runResync,
  type ResyncQueryClient,
} from "@/lib/resync";
import { HISTORY_QUERY_KEY } from "@/lib/history-query";
import { isStaleSelection, resolveDisplayLabel, STALE_SELECTION_MESSAGE } from "@/lib/master-sync";
import { normalizeSessionInfo } from "@/lib/session-info";
import {
  coerceDraft,
  DRAFT_SCHEMA_VERSION,
  type BillDraft,
  type DraftLine,
} from "@/lib/draft-store";

function line(over: Partial<DraftLine> = {}): DraftLine {
  return {
    key: "k1",
    n3Id: null,
    stockId: 1,
    stockCode: "WBS-1",
    stockName: "Stock 1",
    itemDescription: "Typed description",
    itemDescriptionTouched: true,
    uomId: 5,
    uomCode: "UNIT",
    glAccountId: "gl-1",
    glAccountCode: "5000",
    glAccountName: "Purchases",
    projectId: 7,
    projectCode: "CC1",
    projectName: "Cost centre 1",
    taxCodeId: 3,
    taxCodeCode: "TX",
    taxCodeName: "Tax",
    tariffCodeId: 9,
    tariffCodeCode: "TF",
    tariffCodeName: "Tariff",
    qty: "2",
    unitPrice: "10.50",
    refNo: "R1",
    ...over,
  };
}

function draft(lines: DraftLine[]): BillDraft {
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    savedAt: 1,
    invoiceId: null,
    docCode: null,
    docDate: "2026-01-05",
    supplierId: 42,
    supplierLabel: "S001 — Acme",
    purchaserId: null,
    purchaserLabel: "",
    termId: 2,
    termLabel: "30 days",
    termTouched: true,
    description: "HQ-1",
    referenceNo: "REF",
    supplierInvNo: "INV-9",
    isTaxInclusive: false,
    lines,
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
}

/** Seed a query so refetchQueries has something to refetch. */
async function seed(client: QueryClient, key: readonly unknown[], fn: () => Promise<unknown>) {
  await client.fetchQuery({ queryKey: key as unknown[], queryFn: fn });
}

describe("Correction H — re-sync allow-list", () => {
  it("covers the eight master datasets plus session info", () => {
    const targets = resyncTargets();
    expect(MASTER_DATASET_COUNT).toBe(8);
    expect(targets).toHaveLength(9);
    expect(targets.at(-1)?.queryKey).toEqual(N3_SESSION_INFO_KEY);
  });

  it("includes the selected supplier's detail only when one is selected", () => {
    expect(resyncTargets({ supplierId: 42 }).map((t) => t.queryKey)).toContainEqual(
      n3SupplierDetailKey(42),
    );
    expect(
      resyncTargets().some((t) => JSON.stringify(t.queryKey).includes("supplier\"]")),
    ).toBe(false);
  });

  it("never targets history, GL Analysis or audit report keys", () => {
    const flat = JSON.stringify(resyncTargets({ supplierId: 1 }).map((t) => t.queryKey));
    expect(flat).not.toContain(JSON.stringify(HISTORY_QUERY_KEY).slice(1, -1));
    expect(flat).not.toContain("gl-analysis");
    expect(flat).not.toContain("purchase-audit");
    expect(flat).not.toContain("report");
  });

  it("refetches each allow-listed key and leaves report/history caches untouched", async () => {
    const client = makeClient();
    const supplierFn = vi.fn().mockResolvedValue(["s"]);
    const historyFn = vi.fn().mockResolvedValue(["h"]);
    const reportFn = vi.fn().mockResolvedValue({ rows: [] });
    await seed(client, N3_MASTER_KEYS.suppliers, supplierFn);
    await seed(client, HISTORY_QUERY_KEY, historyFn);
    await seed(client, ["report", "gl-analysis", "t", "u", {}], reportFn);

    const res = await runResync(client, [
      { label: "Suppliers", queryKey: N3_MASTER_KEYS.suppliers },
    ]);

    expect(res.ok).toBe(true);
    expect(supplierFn).toHaveBeenCalledTimes(2);
    expect(historyFn).toHaveBeenCalledTimes(1);
    expect(reportFn).toHaveBeenCalledTimes(1);
  });

  it("fetches an approved master list even when its query is not mounted", async () => {
    const client = makeClient();
    const fetchSpy = vi.spyOn(client, "fetchQuery").mockResolvedValue(["term"]);
    const refetchSpy = vi.spyOn(client, "refetchQueries");

    const res = await runResync(client, [
      { label: "Terms", queryKey: N3_MASTER_KEYS.terms, dataset: "terms" },
    ]);

    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(refetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces new options after a re-sync", async () => {
    const client = makeClient();
    let rows = [{ id: 1 }];
    const fn = vi.fn(async () => rows);
    await seed(client, N3_MASTER_KEYS.stocks, fn);
    rows = [{ id: 1 }, { id: 2 }];
    await runResync(client, [{ label: "Stocks", queryKey: N3_MASTER_KEYS.stocks }]);
    expect(client.getQueryData([...N3_MASTER_KEYS.stocks])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("keeps the previous cache and reports failed lists on partial failure", async () => {
    const client = makeClient();
    const keep = [{ id: 1 }];
    await seed(client, N3_MASTER_KEYS.projects, vi.fn().mockResolvedValue(keep));
    const failing: ResyncQueryClient = {
      refetchQueries: async (filters) => {
        if (JSON.stringify(filters.queryKey) === JSON.stringify(N3_MASTER_KEYS.projects)) {
          throw new Error("network down");
        }
        return client.refetchQueries(filters);
      },
    };

    const res = await runResync(failing, [
      { label: "Cost Centres", queryKey: N3_MASTER_KEYS.projects },
      { label: "Terms", queryKey: N3_MASTER_KEYS.terms },
    ]);

    expect(res.ok).toBe(false);
    expect(res.failed).toEqual(["Cost Centres"]);
    expect(res.failedTargets.map((t) => t.label)).toEqual(["Cost Centres"]);
    expect(client.getQueryData([...N3_MASTER_KEYS.projects])).toEqual(keep);
    expect(res.message).toContain("could not be refreshed");
  });

  it("does not throw and flags an expired session", async () => {
    const expired: ResyncQueryClient = {
      refetchQueries: async () => {
        throw Object.assign(new Error("Session expired"), { status: 401 });
      },
    };
    const res = await runResync(expired, [
      { label: "Tax Codes", queryKey: N3_MASTER_KEYS.taxCodes },
      { label: "Session information", queryKey: N3_SESSION_INFO_KEY },
    ]);
    expect(res.unauthorized).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.failed).toHaveLength(2);
  });

  it("serialises concurrent re-sync requests", async () => {
    let running = 0;
    let maxConcurrent = 0;
    const guard = createResyncGuard(async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
    });
    await Promise.all([guard.run(), guard.run(), guard.run()]);
    expect(maxConcurrent).toBe(1);
    expect(guard.isRunning()).toBe(false);
  });

  it("formats messages and the synced timestamp", () => {
    const all = Object.values(N3_MASTER_LABELS);
    expect(resyncMessage(all, [])).toBe("N3 data re-synced.");
    const msg = resyncMessage(all.slice(0, 6), all.slice(6));
    expect(msg).toContain("6 of 8");
    expect(msg).toContain("could not be refreshed");
    expect(formatSyncedAt(Date.UTC(2026, 0, 5, 2, 30, 0))).toMatch(
      /^05\/01\/2026 \d{2}:\d{2}:\d{2} (AM|PM)$/,
    );
  });
});

describe("Correction H — drafts survive a re-sync", () => {
  it("round-trips a multi-line draft with edited descriptions unchanged", () => {
    const d = draft([
      line({ key: "a", itemDescription: "Edited one", itemDescriptionTouched: true }),
      line({ key: "b", stockId: 2, itemDescription: "Edited two", qty: "3" }),
    ]);
    const restored = coerceDraft(JSON.parse(JSON.stringify(d)));
    expect(restored).toEqual(d);
    expect(restored?.lines.map((l) => l.itemDescription)).toEqual(["Edited one", "Edited two"]);
  });

  it("never stores credentials in a draft", () => {
    const flat = JSON.stringify(draft([line()])).toLowerCase();
    for (const bad of ["token", "bearer", "password", "authorization", "secret"]) {
      expect(flat).not.toContain(bad);
    }
  });
});

describe("Correction H — stale selections", () => {
  const options = [
    { value: "1", label: "A" },
    { value: "2", label: "B" },
  ];

  it("flags a selection missing from the refreshed list", () => {
    expect(isStaleSelection("3", options, true)).toBe(true);
    expect(isStaleSelection("1", options, true)).toBe(false);
  });

  it("does not flag anything before the list has loaded", () => {
    expect(isStaleSelection("3", [], false)).toBe(false);
    expect(isStaleSelection(null, options, true)).toBe(false);
  });

  it("retains the stored label so the value stays visible", () => {
    expect(resolveDisplayLabel("3", options, "Old supplier")).toBe("Old supplier");
    expect(resolveDisplayLabel("1", options, "stale text")).toBe("A");
    expect(STALE_SELECTION_MESSAGE).toMatch(/no longer active/i);
  });
});

describe("Correction H — session information", () => {
  it("reads company, tenant and login user without exposing credentials", () => {
    const info = normalizeSessionInfo({
      company: { data: { companyName: "MUGS Sdn Bhd", dbCode: "MUGS01" } },
      user: { data: { userName: "admin", email: "admin@mugs.com.my", token: "secret-jwt" } },
    });
    expect(info.company).toBe("MUGS Sdn Bhd");
    expect(info.tenantId).toBe("MUGS01");
    expect(info.loginUser).toBe("admin");
    expect(info.email).toBe("admin@mugs.com.my");
    expect(JSON.stringify(info)).not.toContain("secret-jwt");
  });

  it("does not invent identity when N3 authority responses are unavailable", () => {
    const info = normalizeSessionInfo({
      company: null,
      user: null,
    });
    expect(info.tenantId).toBeNull();
    expect(info.company).toBeNull();
    expect(info.loginUser).toBeNull();
  });

  it("unwraps OData-style value arrays and ignores non-email strings", () => {
    const info = normalizeSessionInfo({
      company: { value: [{ name: "Acme" }] },
      user: { value: [{ loginName: "jane", email: "not-an-email" }] },
    });
    expect(info.company).toBe("Acme");
    expect(info.loginUser).toBe("jane");
    expect(info.email).toBeNull();
  });
});

describe("Correction H — integration guardrails", () => {
  const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("forces the mounted new/edit BillForm to persist its current in-memory draft before refetch", () => {
    const header = read("src/components/SessionHeaderControls.tsx");
    const form = read("src/routes/index.tsx");
    expect(header).toContain("RESYNC_PERSIST_DRAFT_EVENT");
    expect(header).toContain("window.dispatchEvent(new Event(RESYNC_PERSIST_DRAFT_EVENT))");
    expect(form).toContain("window.addEventListener(RESYNC_PERSIST_DRAFT_EVENT");
    expect(form).toContain("saveDraft(draft, draftScope)");
  });

  it("does not use browser JWT claims as session-information authority", () => {
    const hook = read("src/hooks/use-session-info.ts");
    const normalizer = read("src/lib/session-info.ts");
    expect(hook).not.toContain("decodeJwt");
    expect(hook).not.toContain("getToken");
    expect(normalizer).not.toContain("CLAIM_TENANT_KEYS");
    expect(normalizer).not.toContain("claims?:");
  });

  it("updates displayed line master labels from refreshed lists without overwriting typed descriptions", () => {
    const form = read("src/routes/index.tsx");
    expect(form).toContain("resolveDisplayLabel(line.stockId");
    expect(form).toContain("resolveDisplayLabel(line.glAccountId");
    expect(form).toContain("resolveDisplayLabel(line.projectId");
    expect(form).toContain("resolveDisplayLabel(line.taxCodeId");
    expect(form).toContain("resolveDisplayLabel(\n              line.tariffCodeId");
    expect(form).toContain("itemDescriptionTouched: l.itemDescriptionTouched");
  });

  it("shows stale line warnings immediately and only blocks save through validation", () => {
    const form = read("src/routes/index.tsx");
    expect(form).toContain("lineStale={lineStale}");
    expect(form).toContain("const stale = !!ctx.lineStale.get(line.key)?.[id]");
    expect(form).toContain("{STALE_SELECTION_MESSAGE}");
  });

  it("re-sync code uses only the approved read-only master endpoints", () => {
    const resync = read("src/lib/resync.ts");
    const master = read("src/lib/n3-master-data.ts");
    expect(resync).not.toContain("clearToken");
    expect(resync).not.toContain("clearAllDrafts");
    expect(master).not.toMatch(/method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/);
    for (const endpoint of [
      "api/Suppliers/List",
      "api/Purchasers/Query",
      "api/Terms/Query",
      "api/Stocks/List",
      "api/AccountCodes/Leaf/Query",
      "api/Projects/Query",
      "api/TaxCodes/InputTax/Query",
      "api/TariffCodes/Query",
    ]) {
      expect(master).toContain(endpoint);
    }
  });

  it("keeps the authenticated header responsive with explicit accessible controls", () => {
    const shell = read("src/components/AppShell.tsx");
    const header = read("src/components/SessionHeaderControls.tsx");
    expect(shell).toContain("flex-wrap");
    expect(shell).toContain("overflow-x-auto");
    expect(header).toContain('aria-label="N3 session information"');
    expect(header).toContain('aria-label="Re-sync N3 Data"');
    expect(header).toContain('aria-label="Sign Out"');
    expect(header).toContain('className="hidden sm:inline"');
  });
});
