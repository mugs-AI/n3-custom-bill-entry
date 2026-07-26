import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { useAuthToken, useHydrated } from "@/hooks/use-auth";
import { getToken } from "@/lib/auth-store";

// Temporary read-only PurchaseBook probe screen (Phase 3B Prerequisite).
//
// Default dates 24/07/2026. Zero request is fired until the user clicks
// "Run Read-Only Probe". The screen never displays the bearer token and only
// shows the sanitized diagnostic JSON returned by
// POST /api/reports/purchasebook-probe.

export const Route = createFileRoute("/reports_/purchasebook-probe")({
  head: () => ({
    meta: [
      { title: "PurchaseBook Probe · Custom Bill Entry" },
      {
        name: "description",
        content:
          "Temporary read-only diagnostic against the N3 PurchaseBook reporting endpoint.",
      },
      { property: "og:title", content: "PurchaseBook Probe · Custom Bill Entry" },
      {
        property: "og:description",
        content:
          "Temporary read-only diagnostic against the N3 PurchaseBook reporting endpoint.",
      },
    ],
  }),
  component: ProbePage,
});

interface ProbeResp {
  ok: boolean;
  error?: string;
  result?: unknown;
}

function ProbePage() {
  const hydrated = useHydrated();
  const token = useAuthToken();
  const [dateFrom, setDateFrom] = useState("2026-07-24");
  const [dateTo, setDateTo] = useState("2026-07-24");
  const [copied, setCopied] = useState(false);

  const mut = useMutation<ProbeResp, Error, { dateFrom: string; dateTo: string }>({
    mutationFn: async (vars) => {
      const t = getToken();
      if (!t) throw new Error("Not signed in to N3.");
      const res = await fetch("/api/reports/purchasebook-probe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
        },
        body: JSON.stringify(vars),
      });
      const json = (await res.json()) as ProbeResp;
      return json;
    },
  });

  const sanitized = mut.data
    ? JSON.stringify(
        mut.data.ok ? mut.data.result : { error: mut.data.error, result: mut.data.result },
        null,
        2,
      )
    : "";

  return (
    <AppShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              PurchaseBook Probe
            </h1>
            <p className="text-sm text-destructive">
              Temporary diagnostic — read-only. No N3 write requests are made.
            </p>
          </div>
          <Link to="/reports" className="app-btn">
            Back to GL Analysis
          </Link>
        </div>

        {!hydrated || !token ? (
          <div className="app-card p-6 text-sm text-muted-foreground">
            Sign in to N3 to run the read-only probe.
          </div>
        ) : (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setCopied(false);
                mut.mutate({ dateFrom, dateTo });
              }}
              className="app-card grid grid-cols-1 gap-3 p-3 md:grid-cols-3"
            >
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                  Date From
                </span>
                <input
                  type="date"
                  className="app-input h-8 text-[13px]"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  required
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                  Date To
                </span>
                <input
                  type="date"
                  className="app-input h-8 text-[13px]"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  required
                />
              </label>
              <div className="flex items-end">
                <button type="submit" className="app-btn" disabled={mut.isPending}>
                  {mut.isPending ? "Running…" : "Run Read-Only Probe"}
                </button>
              </div>
            </form>

            {mut.isError ? (
              <div className="app-card p-4 text-sm text-destructive">
                {mut.error.message}
              </div>
            ) : null}

            {mut.data ? (
              <div className="app-card space-y-3 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">
                    {mut.data.ok ? "Sanitized Probe Result" : "Sanitized Error Result"}
                  </div>
                  <button
                    type="button"
                    className="app-btn"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(sanitized);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      } catch {
                        setCopied(false);
                      }
                    }}
                  >
                    {copied ? "Copied" : "Copy Sanitized Result"}
                  </button>
                </div>
                <pre className="max-h-[560px] overflow-auto rounded bg-surface-2 p-3 text-[11px] leading-4">
                  {sanitized}
                </pre>
                <p className="text-[11px] text-muted-foreground">
                  Bearer tokens, request headers, tenant IDs and unrelated documents are
                  never included in this output.
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </AppShell>
  );
}
