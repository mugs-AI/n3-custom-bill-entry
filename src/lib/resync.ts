// Correction H §2/§4: read-only re-sync of N3 master data.
//
// The runner only ever *refetches* existing React Query entries from the
// allow-list in n3-master-keys.ts. It never writes to N3, never touches the
// auth token and never touches the draft store, so an unfinished New Bill
// Entry keeps every value the user typed. Failures are per-dataset: a list
// that fails keeps its last successfully cached data.

import { fetchMasterDataset } from "./n3-master-data";
import { MASTER_DATASET_COUNT, N3_MASTER_LABELS, type ResyncTarget } from "./n3-master-keys";

const MASTER_LABELS = new Set(Object.values(N3_MASTER_LABELS));

/** BillForm listens for this event and immediately persists its current in-memory draft. */
export const RESYNC_PERSIST_DRAFT_EVENT = "custom-bill-entry:resync-persist-draft";

export interface ResyncQueryClient {
  fetchQuery?(options: {
    queryKey: readonly unknown[];
    queryFn: (context: { signal: AbortSignal }) => Promise<unknown>;
    staleTime?: number;
  }): Promise<unknown>;
  refetchQueries(filters: {
    queryKey: readonly unknown[];
    exact: boolean;
    type?: "active" | "inactive" | "all";
    throwOnError?: boolean;
  }): Promise<unknown>;
}

export interface ResyncResult {
  ok: boolean;
  syncedAt: number;
  /** Labels that refreshed successfully (includes non-list targets). */
  updated: string[];
  /** Labels that failed to refresh. Their cached data is still in place. */
  failed: string[];
  /** Keys of the failed targets, for "Retry failed". */
  failedTargets: ResyncTarget[];
  unauthorized: boolean;
  message: string;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function isUnauthorized(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return !!e && (e.status === 401 || e.code === "UNAUTHORIZED");
}

export function resyncMessage(updated: string[], failed: string[]): string {
  if (failed.length === 0) return "N3 data re-synced.";
  const updatedLists = updated.filter((l) => MASTER_LABELS.has(l)).length;
  const failedLists = failed.filter((l) => MASTER_LABELS.has(l));
  const head = `${updatedLists} of ${MASTER_DATASET_COUNT} N3 lists updated.`;
  const tail = failedLists.length
    ? ` ${joinLabels(failedLists)} could not be refreshed.`
    : ` ${joinLabels(failed)} could not be refreshed.`;
  return head + tail;
}

/**
 * Refetch each allow-listed target independently. Resolves with a per-target
 * report; never throws and never rejects.
 */
export async function runResync(
  client: ResyncQueryClient,
  targets: ResyncTarget[],
  now: number = Date.now(),
): Promise<ResyncResult> {
  const updated: string[] = [];
  const failed: string[] = [];
  const failedTargets: ResyncTarget[] = [];
  let unauthorized = false;

  const settled = await Promise.all(
    targets.map(async (t) => {
      try {
        if (t.dataset && client.fetchQuery) {
          // Unlike refetchQueries, fetchQuery also works when the target query
          // has not been mounted in the current route yet.
          await client.fetchQuery({
            queryKey: t.queryKey,
            queryFn: ({ signal }) => fetchMasterDataset(t.dataset!, signal),
            staleTime: 0,
          });
        } else {
          await client.refetchQueries({
            queryKey: t.queryKey,
            exact: t.exact !== false,
            type: "all",
            throwOnError: true,
          });
        }
        return { t, err: null as unknown };
      } catch (err) {
        return { t, err: err ?? new Error("Refresh failed") };
      }
    }),
  );

  for (const { t, err } of settled) {
    if (err) {
      failed.push(t.label);
      failedTargets.push(t);
      if (isUnauthorized(err)) unauthorized = true;
    } else {
      updated.push(t.label);
    }
  }

  return {
    ok: failed.length === 0,
    syncedAt: now,
    updated,
    failed,
    failedTargets,
    unauthorized,
    message: resyncMessage(updated, failed),
  };
}

/**
 * Wrap a re-sync so a second click while one is in flight is ignored
 * (Correction H §2 "prevent a second concurrent re-sync").
 */
export function createResyncGuard<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): { run: (...args: A) => Promise<R | null>; isRunning: () => boolean } {
  let running = false;
  return {
    isRunning: () => running,
    run: async (...args: A) => {
      if (running) return null;
      running = true;
      try {
        return await fn(...args);
      } finally {
        running = false;
      }
    },
  };
}

const KL_TZ = "Asia/Kuala_Lumpur";

/** `DD/MM/YYYY hh:mm:ss AM/PM` in Malaysia time. */
export function formatSyncedAt(ts: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: KL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const ampm = (get("dayPeriod") || "").toUpperCase().replace(/\./g, "").replace(/\s/g, "");
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}:${get("second")} ${ampm}`;
}