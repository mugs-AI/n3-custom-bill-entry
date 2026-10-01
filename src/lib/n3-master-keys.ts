// Correction H §7: one shared registry of the exact React Query keys used for
// N3 master data, so AppShell's "Re-sync N3 Data" refetches precisely the same
// queries New Bill Entry reads. Report / history / audit keys are deliberately
// NOT in this registry — re-sync must never trigger expensive reporting work.

export const N3_MASTER_KEYS = {
  suppliers: ["n3", "suppliers"],
  purchasers: ["n3", "purchasers"],
  terms: ["n3", "terms"],
  stocks: ["n3", "stocks"],
  glAccounts: ["n3", "glAccounts"],
  projects: ["n3", "projects"],
  taxCodes: ["n3", "taxCodes"],
  tariffCodes: ["n3", "tariffCodes"],
} as const;

export type MasterDataset = keyof typeof N3_MASTER_KEYS;

export const N3_MASTER_LABELS: Record<MasterDataset, string> = {
  suppliers: "Suppliers",
  purchasers: "Purchasers",
  terms: "Terms",
  stocks: "Stocks / WBS",
  glAccounts: "GL Accounts",
  projects: "Cost Centres",
  taxCodes: "Tax Codes",
  tariffCodes: "Tariff Codes",
};

/** Identity / session information (company, tenant, signed-in user). */
export const N3_SESSION_INFO_KEY = ["n3", "sessionInfo"] as const;

/** Per-supplier detail (contact + default term) for the selected supplier. */
export function n3SupplierDetailKey(supplierId: number | null): readonly unknown[] {
  return ["n3", "supplier", supplierId];
}

export interface ResyncTarget {
  label: string;
  queryKey: readonly unknown[];
  /** Exact key match (default). Supplier detail matches by prefix. */
  exact?: boolean;
}

/**
 * Explicit allow-list of everything a re-sync may refetch: the eight master
 * datasets, the currently selected supplier's detail and the session-information
 * query. History, GL Analysis and Purchase Audit keys are never included.
 */
export function resyncTargets(
  opts: { supplierId?: number | null; includeSupplierDetail?: boolean } = {},
): ResyncTarget[] {
  const targets: ResyncTarget[] = (Object.keys(N3_MASTER_KEYS) as MasterDataset[]).map((k) => ({
    label: N3_MASTER_LABELS[k],
    queryKey: N3_MASTER_KEYS[k],
  }));
  if (opts.supplierId != null) {
    targets.push({ label: "Supplier details", queryKey: n3SupplierDetailKey(opts.supplierId) });
  } else if (opts.includeSupplierDetail) {
    // AppShell does not know which supplier the form selected; refetch any
    // cached supplier-detail entry by prefix.
    targets.push({ label: "Supplier details", queryKey: ["n3", "supplier"], exact: false });
  }
  targets.push({ label: "Session information", queryKey: N3_SESSION_INFO_KEY });
  return targets;
}

/** The eight master datasets only — used for the "n of 8 lists updated" text. */
export const MASTER_DATASET_COUNT = Object.keys(N3_MASTER_KEYS).length;