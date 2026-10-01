// Correction H §5: normalize N3 identity into the three read-only values shown
// in the header information panel.
//
// Sources (all through the existing same-origin proxy + current session):
//   GET api/CompanyProfile/BasicInfo  -> company name, db/tenant code
//   GET api/Users/Current             -> signed-in user's display name, email
//
// N3 tenants differ in field casing/naming, so every field is resolved from a
// small candidate list. The tenant ID must come from N3 authority: the company
// profile's db/tenant code when present, otherwise the tenant claim inside the
// N3-issued JWT. Nothing from this module ever carries the bearer token, the
// raw JWT, API keys or a claims dump.

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

const CLAIM_TENANT_KEYS = ["tid", "tenantId", "tenant_id", "dbcode", "dbCode", "dbId"];
const CLAIM_USER_KEYS = ["name", "unique_name", "preferred_username", "given_name", "sub"];
const CLAIM_EMAIL_KEYS = ["email"];

function isEmailLike(v: string | null): boolean {
  return !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * Build the panel values from the company-profile response, the current-user
 * response and (only as a last resort for tenant/user) the N3-issued JWT
 * payload. Any source may be null / a failed request.
 */
export function normalizeSessionInfo(input: {
  company?: unknown;
  user?: unknown;
  claims?: Record<string, unknown> | null;
}): SessionInfo {
  const company = unwrapIdentityPayload(input.company);
  const user = unwrapIdentityPayload(input.user);
  const claims = input.claims ?? null;

  const companyName = pick(company, COMPANY_KEYS);
  const tenantId =
    pick(company, TENANT_KEYS) ?? pick(user, TENANT_KEYS) ?? pick(claims, CLAIM_TENANT_KEYS);
  const loginUser = pick(user, USER_KEYS) ?? pick(claims, CLAIM_USER_KEYS);
  const emailRaw = pick(user, EMAIL_KEYS) ?? pick(claims, CLAIM_EMAIL_KEYS);

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