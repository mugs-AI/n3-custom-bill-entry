// Persist the N3 JWT in localStorage under the key mandated by the N3 dev
// brief: `qne_access_token`. Path A (production launch from N3 My Apps with
// `?token=…`) and Path B (dev-only connect) both write here so the session
// survives refreshes and Vite restarts. All reads/writes are guarded so this
// module is safe to import in SSR chains.

const KEY = "qne_access_token";
const EVENT = "qne-auth-change";

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  const s = safeStorage();
  if (!s) return null;
  try {
    return s.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.setItem(KEY, token);
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // ignore
  }
}

export function clearToken(): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(KEY);
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // ignore
  }
}

export const AUTH_EVENT = EVENT;

/** Decode a JWT payload without verifying the signature. */
export function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8");
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
