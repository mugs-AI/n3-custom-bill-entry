// Persist the N3 JWT in localStorage under a single stable key. Both Path A
// (production launch from My Apps with ?token=…) and Path B (dev-only connect)
// write to this key so the session survives refreshes and Vite restarts.

const KEY = "n3.accessToken";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, token);
    window.dispatchEvent(new Event("n3-auth-change"));
  } catch {
    // ignore
  }
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
    window.dispatchEvent(new Event("n3-auth-change"));
  } catch {
    // ignore
  }
}

/** Decode a JWT payload without verifying the signature. Returns null on bad input. */
export function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const payload = decodeJwt(token);
  const exp = payload && typeof payload.exp === "number" ? (payload.exp as number) : null;
  if (!exp) return false;
  return Date.now() / 1000 > exp;
}
