// Correction H §5: normalize N3 identity into the three read-only values shown
// in the header information panel.
//
// Sources (all through the existing same-origin proxy + current session):
//   GET api/CompanyProfile/BasicInfo  -> company name, db/tenant code
//   GET api/Users/Current             -> signed-in user's display name, email
//
// N3 tenants differ in field casing/naming, so every field is resolved from a
// small candidate list. The stable tenant ID must come from the authenticated
// N3 BasicInfo/current-user responses. Browser token claims are deliberately
// not accepted as identity authority here. Nothing from this module ever
// carries a bearer token, raw JWT, API key or claims dump.

export interface SessionInfo {
  company: string | null;
  tenantId: string | null;
  loginUser: string | null;
  email: string | null;
}

export const EMPTY_SESSION_INFO: SessionInfo = {
  company: null,
  tenantId: null,
  loginUser: null,
  email: null,
};

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

function pick(source: unknown, keys: string[]): string | null {
  const r = asRec(source);
  if (!r) return null;
  for (const k of keys) {
    // Case-insensitive match so PascalCase and camelCase tenants both work.
    const hit = Object.keys(r).find((x) => x.toLowerCase() === k.toLowerCase());
    if (!hit) continue;
    const v = r[hit];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Unwrap common N3 shapes: envelope `data`, `value[0]`, or the object itself. */
export function unwrapIdentityPayload(raw: unknown): unknown {
  let cur: unknown = raw;
  for (let i = 0; i < 3; i++) {
    const r = asRec(cur);
    if (!r) break;
    if ("data" in r && r.data != null) {
      cur = r.data;
      continue;
    }
    if (Array.isArray(r.value)) {
      cur = (r.value as unknown[])[0] ?? null;
      continue;
    }
    break;
  }
  if (Array.isArray(cur)) return cur[0] ?? null;
  return cur;
}

const COMPANY_KEYS = [
  "companyName",
  "name",
  "company",
  "registeredName",
  "companyName1",
  "description",
];
const TENANT_KEYS = [
  "dbCode",
  "dbcode",
  "databaseCode",
  "tenantId",
  "tenantCode",
  "companyCode",
  "dbId",
  "tenant",
  "code",
];
const USER_KEYS = ["displayName", "fullName", "userName", "name", "loginName", "user", "userId"];
const EMAIL_KEYS = ["email", "emailAddress", "userEmail"];

function isEmailLike(v: string | null): boolean {
  return !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * Build the panel values only from authenticated N3 authority responses.
 * Either response may be null when its endpoint is unavailable.
 */
export function normalizeSessionInfo(input: {
  company?: unknown;
  user?: unknown;
}): SessionInfo {
  const company = unwrapIdentityPayload(input.company);
  const user = unwrapIdentityPayload(input.user);

  const companyName = pick(company, COMPANY_KEYS);
  const tenantId = pick(company, TENANT_KEYS) ?? pick(user, TENANT_KEYS);
  const loginUser = pick(user, USER_KEYS);
  const emailRaw = pick(user, EMAIL_KEYS);

  return {
    company: companyName,
    tenantId,
    loginUser,
    // Only surface an address that actually looks like an email.
    email: isEmailLike(emailRaw) ? emailRaw : null,
  };
}

export function hasAnySessionInfo(info: SessionInfo | null | undefined): boolean {
  return !!info && !!(info.company || info.tenantId || info.loginUser);
}