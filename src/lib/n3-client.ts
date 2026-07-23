import { getToken } from "./auth-store";

// Client-side helper for calling N3 Open API through our same-origin backend
// proxy. Every response is unwrapped from the N3 envelope
// { success, code, message, data, error }.

export interface N3Envelope<T> {
  type?: string;
  success?: boolean;
  code?: string;
  message?: string;
  data?: T;
  error?: unknown;
}

export class N3Error extends Error {
  code?: string;
  status?: number;
  raw?: unknown;
  constructor(message: string, opts: { code?: string; status?: number; raw?: unknown } = {}) {
    super(message);
    this.name = "N3Error";
    this.code = opts.code;
    this.status = opts.status;
    this.raw = opts.raw;
  }
}

export interface N3RequestInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Route to reporting host by prefixing "reporting/" internally. */
  reporting?: boolean;
  signal?: AbortSignal;
}

function buildQuery(query?: N3RequestInit["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function n3Call<T = unknown>(
  path: string,
  init: N3RequestInit = {},
): Promise<T> {
  const token = getToken();
  if (!token) {
    throw new N3Error("Not signed in to N3. Please connect first.", { code: "NO_TOKEN" });
  }

  const cleaned = path.replace(/^\/+/, "");
  const prefixed = init.reporting ? `reporting/${cleaned}` : cleaned;
  const url = `/api/proxy/${prefixed}${buildQuery(init.query)}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers,
    body,
    signal: init.signal,
  });

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const env = parsed as N3Envelope<T> | null;
    throw new N3Error(env?.message || `Request failed (${res.status})`, {
      code: env?.code,
      status: res.status,
      raw: parsed,
    });
  }

  const env = parsed as N3Envelope<T>;
  // Success when envelope reports code "0000" or explicit success:true. Some
  // endpoints (docs / non-envelope) may return raw data — treat that as ok.
  if (env && typeof env === "object" && ("success" in env || "code" in env)) {
    const ok = env.success === true || env.code === "0000";
    if (!ok) {
      throw new N3Error(env.message || `N3 error ${env.code ?? ""}`, {
        code: env.code,
        status: res.status,
        raw: env,
      });
    }
    return env.data as T;
  }
  return parsed as T;
}

// OData pagination helper for endpoints under `.../Query` or `.../List` that
// return { value: [...], count: N } inside `data`. Pulls every page.
export interface ODataPage<T> {
  value: T[];
  count?: number;
}

export async function n3ListAll<T = unknown>(
  path: string,
  opts: {
    pageSize?: number;
    query?: Record<string, string | number | boolean | undefined | null>;
    reporting?: boolean;
    signal?: AbortSignal;
    maxRows?: number;
  } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 200;
  const max = opts.maxRows ?? Infinity;
  const rows: T[] = [];
  let skip = 0;
  while (rows.length < max) {
    const page = await n3Call<ODataPage<T>>(path, {
      method: "GET",
      reporting: opts.reporting,
      signal: opts.signal,
      query: {
        ...opts.query,
        $top: pageSize,
        $skip: skip,
        $count: "true",
      },
    });
    const batch = Array.isArray(page?.value) ? page.value : [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    skip += pageSize;
  }
  return rows.slice(0, max);
}
