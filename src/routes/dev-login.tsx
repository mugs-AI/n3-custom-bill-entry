import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { setToken, getToken } from "@/lib/auth-store";

export const Route = createFileRoute("/dev-login")({
  head: () => ({
    meta: [
      { title: "Dev connect · Custom Bill Entry" },
      {
        name: "description",
        content: "Development-only sign-in for N3 Open API. Not available in production.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DevLogin,
});

function DevLogin() {
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDev, setIsDev] = useState(false);
  const [hasToken, setHasToken] = useState<string | null>(null);

  useEffect(() => {
    setIsDev(import.meta.env.DEV);
    setHasToken(getToken());
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/dev-connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const body = (await res.json()) as {
        success?: boolean;
        code?: string;
        message?: string;
        data?: { token?: string; accessToken?: string };
      };
      if (!res.ok || (body.code && body.code !== "0000" && body.success !== true)) {
        throw new Error(body.message || `Connect failed (${res.status})`);
      }
      const token = body?.data?.token ?? body?.data?.accessToken;
      if (!token) throw new Error("Connect response did not include a token.");
      setToken(token);
      navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto max-w-lg">
        <div className="app-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <span className="rounded-md bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
              DEVELOPMENT ONLY
            </span>
          </div>
          <h1 className="text-xl font-semibold">Connect to N3 (dev)</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Paste an N3 API key from <em>My Apps → New App</em>. The server exchanges it for a JWT
            and stores the token in your browser so you stay signed in across reloads. This screen
            is disabled in production; production users launch the app from N3 My Apps with
            <code className="mx-1 rounded bg-muted px-1">?token=…</code>.
          </p>
          {!isDev && (
            <div className="mt-4 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              This route is dev-only and will be disabled in production builds.
            </div>
          )}
          {hasToken && (
            <div className="mt-4 rounded-md border border-success bg-success/10 p-3 text-xs text-success">
              A token is already stored. Submitting again will replace it.
            </div>
          )}
          <form onSubmit={submit} className="mt-5 space-y-3">
            <div>
              <label className="app-label" htmlFor="apiKey">
                N3 API key
              </label>
              <input
                id="apiKey"
                autoFocus
                className="app-input font-mono"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="TjNQQQ…"
              />
            </div>
            {error && (
              <div className="rounded-md border border-destructive bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <button
              type="submit"
              className="app-btn app-btn-primary w-full"
              disabled={busy || !apiKey.trim()}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </form>
        </div>
      </div>
    </AppShell>
  );
}
