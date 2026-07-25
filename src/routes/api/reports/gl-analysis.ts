import { createFileRoute } from "@tanstack/react-router";
import {
  aggregateByGL,
  buildReportHeaderFilter,
  buildSummary,
  filterLines,
  mapBounded,
  mapInvoiceToLines,
  validateCriteria,
  type GLDrillDownLine,
  type RawN3Header,
  type ReportCriteria,
  type ReportData,
} from "@/lib/report-model";

// Server-side GL Analysis / Purchase Audit Trail data fetcher.
//
// Endpoint strategy (Phase 3A §3): the N3 purchase API has no batch line-level
// query — /api/PurchaseInvoices/Query returns headers only, and detail lines
// only come back per-invoice via /api/PurchaseInvoices/{id}. So we:
//   1. Query headers with an OData filter built from immutable IDs plus the
//      date range and isCancelled=false (§5 exclusion). $count=true.
//   2. Enforce a 2,000-invoice safety limit — if N3 reports more matches, we
//      refuse and return { overLimit: true } with no partial totals.
//   3. Fetch each header's detail via bounded concurrency (max 3) so we never
//      fire an unbounded Promise.all.
//   4. Map to typed GLDrillDownLine[], apply line-level filters, aggregate.
//
// No token or upstream payload is echoed. N3 error text is truncated and
// stripped of newlines so raw LINQ / stack traces cannot reach the browser.

const MAIN_DEFAULT = "https://openapi.account.qne.cloud";
const PAGE_SIZE = 200;
const MAX_INVOICES = 2000;
const DETAIL_CONCURRENCY = 3;

interface N3Envelope<T> {
  success?: boolean;
  code?: string;
  message?: string;
  data?: T;
}

interface OData<T> {
  value: T[];
  count?: number;
}

interface HeaderRow {
  id?: string;
  docCode?: string;
  docDate?: string;
  isCancelled?: boolean;
}

type Reply =
  | { ok: true; report: ReportData }
  | {
      ok: false;
      kind: "auth" | "validation" | "over-limit" | "n3" | "network" | "incomplete";
      error: string;
      matchedInvoiceCount?: number;
      failedInvoiceCount?: number;
      limit?: number;
    };

function jsonRes(status: number, body: Reply): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function safeMessage(raw: string, fallback: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed) return fallback;
  // Strip anything that looks like a LINQ expression / stack trace and cap size.
  const scrubbed = trimmed
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/https?:\/\/\S+/gi, "[url]");
  return scrubbed.length > 240 ? `${scrubbed.slice(0, 240)}…` : scrubbed;
}

async function n3Get<T>(
  base: string,
  token: string,
  path: string,
  query?: Record<string, string | number>,
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: safeMessage(err instanceof Error ? err.message : "", "Network error"),
    };
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const env = parsed as N3Envelope<T> | null;
  if (!res.ok || (env && env.success === false) || (env && env.code && env.code !== "0000")) {
    return {
      ok: false,
      status: res.status,
      message: safeMessage(env?.message ?? "", `Request failed (${res.status})`),
    };
  }
  return { ok: true, data: (env?.data ?? (parsed as T)) as T };
}

function coerceCriteria(raw: unknown): ReportCriteria | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Missing body" };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const str = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t ? t : undefined;
  };
  const c: ReportCriteria = {
    dateFrom: typeof r.dateFrom === "string" ? r.dateFrom : "",
    dateTo: typeof r.dateTo === "string" ? r.dateTo : "",
    supplierId: num(r.supplierId),
    purchaserId: num(r.purchaserId),
    projectId: num(r.projectId),
    stockId: num(r.stockId),
    taxCodeId: num(r.taxCodeId),
    hqSequence: str(r.hqSequence),
  };
  const err = validateCriteria(c);
  if (err) return { error: err };
  return c;
}

async function handle(request: Request): Promise<Response> {
  const authz = request.headers.get("authorization") ?? "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) return jsonRes(401, { ok: false, kind: "auth", error: "Not signed in to N3." });
  const token = m[1].trim();
  if (!token) return jsonRes(401, { ok: false, kind: "auth", error: "Not signed in to N3." });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonRes(400, { ok: false, kind: "validation", error: "Invalid JSON body" });
  }
  const parsed = coerceCriteria(raw);
  if ("error" in parsed)
    return jsonRes(400, { ok: false, kind: "validation", error: parsed.error });
  const criteria = parsed;

  const base = process.env.OPEN_API_BASE_URL || MAIN_DEFAULT;
  const filter = buildReportHeaderFilter(criteria);

  // Step 1: count matching headers up front so we can refuse cleanly.
  const first = await n3Get<OData<HeaderRow>>(base, token, "api/PurchaseInvoices/Query", {
    $filter: filter,
    $top: PAGE_SIZE,
    $skip: 0,
    $count: "true",
    $orderby: "docDate desc,docCode desc",
  });
  if (!first.ok) {
    if (first.status === 401)
      return jsonRes(401, { ok: false, kind: "auth", error: first.message });
    return jsonRes(502, { ok: false, kind: "n3", error: first.message });
  }
  const total = typeof first.data.count === "number" ? first.data.count : first.data.value.length;
  if (total > MAX_INVOICES) {
    return jsonRes(413, {
      ok: false,
      kind: "over-limit",
      error: `This inquiry matches ${total.toLocaleString()} Purchase Invoices, which exceeds the safety limit of ${MAX_INVOICES.toLocaleString()}. Please narrow the date range or add filters.`,
      matchedInvoiceCount: total,
      limit: MAX_INVOICES,
    });
  }

  const headers: HeaderRow[] = [...first.data.value];
  for (let skip = PAGE_SIZE; skip < total; skip += PAGE_SIZE) {
    const page = await n3Get<OData<HeaderRow>>(base, token, "api/PurchaseInvoices/Query", {
      $filter: filter,
      $top: PAGE_SIZE,
      $skip: skip,
      $count: "false",
      $orderby: "docDate desc,docCode desc",
    });
    if (!page.ok) {
      if (page.status === 401)
        return jsonRes(401, { ok: false, kind: "auth", error: page.message });
      return jsonRes(502, { ok: false, kind: "n3", error: page.message });
    }
    headers.push(...page.data.value);
    if (page.data.value.length < PAGE_SIZE) break;
  }

  // Step 2: bounded-concurrency detail fetch.
  const ids = headers
    .map((h) => (typeof h.id === "string" ? h.id : ""))
    .filter((s): s is string => !!s);

  let firstErr: string | null = null;
  const details = await mapBounded(ids, DETAIL_CONCURRENCY, async (id) => {
    const r = await n3Get<RawN3Header>(base, token, `api/PurchaseInvoices/${encodeURIComponent(id)}`);
    if (!r.ok) {
      if (!firstErr) firstErr = `${r.status || "network"} ${r.message}`;
      return null;
    }
    return r.data;
  });
  if (firstErr) {
    return jsonRes(502, {
      ok: false,
      kind: "n3",
      error: `Failed to load one or more Purchase Invoice details: ${firstErr}`,
    });
  }

  // Step 3: map + aggregate.
  const allLines: GLDrillDownLine[] = [];
  for (const inv of details) {
    if (!inv) continue;
    for (const line of mapInvoiceToLines(inv)) allLines.push(line);
  }
  const filtered = filterLines(allLines, criteria);
  const groups = aggregateByGL(filtered);
  const summary = buildSummary(filtered, groups);

  const report: ReportData = {
    criteria,
    summary,
    groups,
    lines: filtered,
    matchedInvoiceCount: total,
    fetchedInvoiceCount: details.filter((x) => x != null).length,
    overLimit: false,
  };
  return jsonRes(200, { ok: true, report });
}

export const Route = createFileRoute("/api/reports/gl-analysis")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
    },
  },
});
