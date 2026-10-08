import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { SessionHeaderControls } from "@/components/SessionHeaderControls";
import { useAuthToken } from "@/hooks/use-auth";

const APP_VERSION = "v1.0.2026.10.08";

export function AppShell({ children }: { children: ReactNode }) {
  const token = useAuthToken();
  const [isDev, setIsDev] = useState(false);
  useEffect(() => {
    setIsDev(import.meta.env.DEV);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:gap-6 sm:px-6">
          <Link to="/" className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground font-bold">
              N3
            </span>
            <div className="leading-tight">
              <div className="flex items-baseline gap-2">
                <div className="text-sm font-semibold">Custom Bill Entry</div>
                <span className="text-[9px] font-medium text-muted-foreground">{APP_VERSION}</span>
              </div>
              <div className="text-[11px] text-muted-foreground">N3 AI Cloud Accounting</div>
            </div>
          </Link>
          <nav className="ml-0 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm sm:ml-4">
            <NavLink to="/">New Bill</NavLink>
            <NavLink to="/history">History</NavLink>
            <NavLink to="/reports">GL Analysis</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {isDev && (
              <Link
                to="/dev-login"
                className="hidden rounded-md border border-warning/60 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning sm:inline-block"
              >
                DEV
              </Link>
            )}
            {token ? (
              <SessionHeaderControls />
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