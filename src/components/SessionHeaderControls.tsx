import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearToken } from "@/lib/auth-store";
import { clearAllDrafts } from "@/lib/draft-store";
import { resyncTargets, type ResyncTarget } from "@/lib/n3-master-keys";
import {
  formatSyncedAt,
  RESYNC_PERSIST_DRAFT_EVENT,
  runResync,
  type ResyncResult,
} from "@/lib/resync";
import { hasAnySessionInfo } from "@/lib/session-info";
import { useSessionInfo } from "@/hooks/use-session-info";

// Correction H §1: session information [i], Re-sync N3 Data and Sign Out,
// grouped at the right of the header on every authenticated page. The
// re-sync never reloads the page, never navigates and never clears the token
// or any unfinished draft.

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

export function SessionHeaderControls() {
  const queryClient = useQueryClient();
  const sessionQ = useSessionInfo();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const runningRef = useRef(false);
  const [result, setResult] = useState<ResyncResult | null>(null);
  const [lastSynced, setLastSynced] = useState<number | null>(null);

  const doResync = useCallback(
    async (targets?: ResyncTarget[]) => {
      // Guard a second concurrent re-sync (double click / retry spam).
      if (runningRef.current) return;
      runningRef.current = true;
      setBusy(true);
      // Extra safeguard: ask the mounted BillForm (new or edit) to persist
      // its current in-memory state immediately before any refetch begins.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(RESYNC_PERSIST_DRAFT_EVENT));
      }
      try {
        const res = await runResync(
          queryClient,
          targets ?? resyncTargets({ includeSupplierDetail: true }),
        );
        setResult(res);
        if (res.updated.length > 0) setLastSynced(res.syncedAt);
      } finally {
        runningRef.current = false;
        setBusy(false);
      }
    },
    [queryClient],
  );

  // Auto-dismiss a fully successful status after a few seconds.
  useEffect(() => {
    if (!result?.ok) return;
    const t = setTimeout(() => setResult(null), 6000);
    return () => clearTimeout(t);
  }, [result]);

  const info = sessionQ.data;

  return (
    <div className="relative flex items-center gap-2">
      <button
        type="button"
        aria-label="N3 session information"
        title="N3 session information"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border text-sm font-semibold text-muted-foreground hover:bg-surface-2 hover:text-foreground"
      >
        i
      </button>

      <button
        type="button"
        onClick={() => void doResync()}
        disabled={busy}
        aria-label="Re-sync N3 Data"
        title="Re-sync N3 Data"
        className="app-btn flex shrink-0 items-center gap-1.5"
      >
        <RefreshIcon spinning={busy} />
        <span className="hidden sm:inline">{busy ? "Re-syncing…" : "Re-sync N3 Data"}</span>
      </button>

      <button
        type="button"
        aria-label="Sign Out"
        onClick={() => {
          if (confirm("Sign out of N3?")) {
            clearAllDrafts();
            clearToken();
          }
        }}
        className="app-btn shrink-0"
      >
        Sign Out
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="N3 Session"
          className="absolute right-0 top-10 z-30 w-[min(20rem,calc(100vw-2rem))] rounded-md border border-border bg-surface p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold">N3 Session</div>
            <button
              type="button"
              aria-label="Close session information"
              className="app-btn px-2 py-0.5 text-xs"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
          {sessionQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading session information…</div>
          ) : hasAnySessionInfo(info) ? (
            <dl className="space-y-1 text-sm">
              <Row label="Company" value={info?.company} />
              <Row label="Tenant ID" value={info?.tenantId} />
              <Row
                label="Login User"
                value={
                  info?.loginUser
                    ? info.email
                      ? `${info.loginUser} (${info.email})`
                      : info.loginUser
                    : null
                }
              />
            </dl>
          ) : (
            <div className="space-y-2 text-sm text-muted-foreground">
              <div>Session information is unavailable right now.</div>
              <button
                type="button"
                className="app-btn"
                onClick={() => void sessionQ.refetch()}
                disabled={sessionQ.isFetching}
              >
                {sessionQ.isFetching ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
          {lastSynced != null && (
            <div className="mt-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
              Last synced: {formatSyncedAt(lastSynced)}
            </div>
          )}
        </div>
      )}

      {result && (
        <div
          role="status"
          className={`absolute right-0 top-10 z-20 w-[min(22rem,calc(100vw-2rem))] rounded-md border p-3 text-sm shadow-lg ${
            result.ok
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-warning/50 bg-warning/10 text-foreground"
          }`}
        >
          <div>{result.message}</div>
          {result.ok ? (
            <div className="mt-1 text-[11px] text-muted-foreground">
              Last synced: {formatSyncedAt(result.syncedAt)}
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className="app-btn"
                disabled={busy}
                onClick={() => void doResync(result.failedTargets)}
              >
                Retry failed
              </button>
              <button type="button" className="app-btn" onClick={() => setResult(null)}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words font-medium">{value || "—"}</dd>
    </div>
  );
}