import { n3ListAll } from "./n3-client";
import type { MasterDataset } from "./n3-master-keys";

/**
 * Read-only fetchers for the eight approved N3 master datasets.
 * Keeping these contracts in one place lets a header re-sync refresh data even
 * when the corresponding screen/query is not currently mounted.
 */
export function fetchMasterDataset(dataset: MasterDataset, signal?: AbortSignal): Promise<unknown> {
  switch (dataset) {
    case "suppliers":
      return n3ListAll("api/Suppliers/List", { pageSize: 500, signal });
    case "purchasers":
      return n3ListAll("api/Purchasers/Query", { pageSize: 500, signal });
    case "terms":
      return n3ListAll("api/Terms/Query", { pageSize: 500, signal });
    case "stocks":
      return n3ListAll("api/Stocks/List", { pageSize: 500, signal });
    case "glAccounts":
      return n3ListAll("api/AccountCodes/Leaf/Query", { pageSize: 500, signal });
    case "projects":
      return n3ListAll("api/Projects/Query", { pageSize: 500, signal });
    case "taxCodes":
      return n3ListAll("api/TaxCodes/InputTax/Query", { pageSize: 500, signal });
    case "tariffCodes":
      return n3ListAll("api/TariffCodes/Query", { pageSize: 500, signal });
  }
}
