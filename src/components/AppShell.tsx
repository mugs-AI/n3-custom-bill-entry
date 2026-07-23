import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { clearToken } from "@/lib/auth-store";
import { useAuthToken } from "@/hooks/use-auth";

export function AppShell({ children }: { children: ReactNode }) {
  const token = useAuthToken();
  const [isDev, setIsDev] = useState(false);
  useEffect(() => {
    setIsDev(import.meta.env.DEV);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-3">
          <Link to="/" className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground font-bold">
              N3
            </span>
            <div className="leading-tight">
              <div className="text-sm font-semibold">Custom Bill Entry</div>
              <div className="text-[11px] text-muted-foreground">
                N3 AI Cloud Accounting
              </div>
            </div>
          </Link>
          <nav className="ml-4 flex items-center gap-1 text-sm">
            <NavLink to="/">New Bill</NavLink>
            <NavLink to="/history">History</NavLink>
            <NavLink to="/reports">GL Analysis</NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {isDev && (
              <Link
                to="/dev-login"
                className="rounded-md border border-warning/60 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning"
              >
                DEV
              </Link>
            )}
            {token ? (
              <button
                onClick={() => {
                  if (confirm("Sign out of N3?")) clearToken();
                }}
                className="app-btn"
              >
                Sign out
              </button>
            ) : (
              isDev && (
                <Link to="/dev-login" className="app-btn app-btn-primary">
                  Dev connect
                </Link>
              )
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-6 py-6">{children}</main>
    </div>
  );
}

function NavLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground"
      activeProps={{ className: "!bg-primary/10 !text-primary" }}
    >
      {children}
    </Link>
  );
}
