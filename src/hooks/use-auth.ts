import { useEffect, useState } from "react";
import { getToken, AUTH_EVENT } from "@/lib/auth-store";

/**
 * Client-only reader for the persisted N3 access token. Returns `null` during
 * SSR / first render, then hydrates from localStorage inside `useEffect`. This
 * avoids `window`/`localStorage` access on the server and prevents hydration
 * mismatches.
 */
export function useAuthToken(): string | null {
  const [token, setTokenState] = useState<string | null>(null);
  useEffect(() => {
    setTokenState(getToken());
    const onChange = () => setTokenState(getToken());
    window.addEventListener(AUTH_EVENT, onChange);
    // Cross-tab updates.
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(AUTH_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return token;
}

/** True after the first client render — safe for gating browser-only UI. */
export function useHydrated(): boolean {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
}
