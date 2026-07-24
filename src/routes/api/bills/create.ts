import { createFileRoute } from "@tanstack/react-router";

// Server-side Purchase Invoice creator.
//
// This is the single trusted place the browser calls to save a bill.
// Responsibilities (in order):
//   1. Extract and validate the caller's N3 bearer token (never accept tenant
//      IDs from the request body — tenancy is bound to the JWT).
//   2. Parse the request body against a strict allow-list.
//   3. Server-side validate header + every non-empty line.
//   4. Duplicate check against N3 via /api/PurchaseInvoices/Query filtered by
//      supplierId — compare normalized (trim + lowercased) supplierInvNo,
//      skipping cancelled documents.
//   5. Fetch /api/PurchaseInvoices/New for tenant defaults (currencyId,
//      stockLocationId, etc.) and merge with the allow-listed payload.
//   6. POST /api/PurchaseInvoices/Create exactly once — never auto-retry.
//   7. Return a sanitized result: { ok, docCode, id } on success, otherwise
//      { ok: false, error, kind } with never a token/header leak.
//
// The N3 base URLs are read from process.env INSIDE the handler; there is no
// module-scope env access. The proxy route already validates this pattern.

const MAIN_DEFAULT = "https://openapi.account.qne.cloud";

interface N3Envelope<T> {
  success?: boolean;
  code?: string;
  message?: string;
  data?: T;
}

interface CreatePayload {
  header: {
    supplierId: number;
    docDate: string;
    termId: number | null;
    purchaserId: number | null;
    description: string;
    referenceNo: string;
    supplierInvNo: string;
    isTaxInclusive: boolean;
  };
  lines: Array<{
    stockId: number;
    uomId: number;
    glAccountId: string;
    projectId: number;
    taxCodeId: number;
    tariffCodeId: number;
    description: string;
    qty: number;
    unitPrice: number;
    /** Decimal factor from N3 TaxCodeLookupDto.rate (0.05 for PT-5%). */
    taxRateFactor: number;
    referenceNo: string;
  }>;
}

interface PurchaseInvoiceQueryRow {
  id?: string;
  docCode?: string;
  supplierInvNo?: string;
  isCancelled?: boolean;
  documentStatus?: string | number;
}

interface CreateOk {
  ok: true;
  docCode: string;
  id: string | null;
  message: string;
}
interface CreateErr {
  ok: false;
  kind: "auth" | "validation" | "duplicate" | "n3" | "network";
  error: string;
  duplicate?: { docCode: string };
}

type CreateResult = CreateOk | CreateErr;

function jsonRes(status: number, body: CreateResult): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function normalizeInv(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function coercePayload(raw: unknown): CreatePayload | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Missing body" };
  const r = raw as Record<string, unknown>;
  const h = r.header as Record<string, unknown> | undefined;
  const lines = r.lines;
  if (!h || typeof h !== "object") return { error: "Missing header" };
  if (!Array.isArray(lines)) return { error: "Missing lines" };

  const supplierId = h.supplierId;
  const docDate = h.docDate;
  if (!isFiniteNumber(supplierId) || supplierId <= 0) return { error: "Invalid Supplier" };
  if (typeof docDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(docDate)) {
    return { error: "Invalid Document Date (yyyy-mm-dd required)" };
  }
  const supplierInvNo = typeof h.supplierInvNo === "string" ? h.supplierInvNo.trim() : "";
  if (!supplierInvNo) return { error: "Supplier INV# is required" };
  const termId = isFiniteNumber(h.termId) ? h.termId : null;
  if (termId == null || termId <= 0) return { error: "Term is required" };
  const purchaserId = isFiniteNumber(h.purchaserId) && h.purchaserId > 0 ? h.purchaserId : null;

  const outLines: CreatePayload["lines"] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as Record<string, unknown>;
    if (!l || typeof l !== "object") continue;
    // A line is "empty" iff every selectable field is blank/zero.
    const anyFilled =
      l.stockId != null ||
      l.glAccountId != null ||
      l.projectId != null ||
      l.taxCodeId != null ||
      l.tariffCodeId != null ||
      (typeof l.qty === "number" && l.qty !== 0) ||
      (typeof l.unitPrice === "number" && l.unitPrice !== 0) ||
      (typeof l.description === "string" && l.description.trim().length > 0);
    if (!anyFilled) continue;

    const stockId = l.stockId;
    const uomId = l.uomId;
    const glAccountId = l.glAccountId;
    const projectId = l.projectId;
    const taxCodeId = l.taxCodeId;
    const tariffCodeId = l.tariffCodeId;
    const description = typeof l.description === "string" ? l.description.trim() : "";
    const qty = l.qty;
    const unitPrice = l.unitPrice;

    if (!isFiniteNumber(stockId) || stockId <= 0)
      return { error: `Line ${i + 1}: WBS/Stock is required` };
    if (!isFiniteNumber(uomId) || uomId <= 0)
      return { error: `Line ${i + 1}: Default UOM missing (re-select WBS)` };
    if (typeof glAccountId !== "string" || !glAccountId)
      return { error: `Line ${i + 1}: GL Account is required` };
    if (!isFiniteNumber(projectId) || projectId <= 0)
      return { error: `Line ${i + 1}: Cost Centre is required` };
    if (!isFiniteNumber(taxCodeId) || taxCodeId <= 0)
      return { error: `Line ${i + 1}: HQ Tax is required` };
    if (!isFiniteNumber(tariffCodeId) || tariffCodeId <= 0)
      return { error: `Line ${i + 1}: Order No. / Tariff is required` };
    if (!description) return { error: `Line ${i + 1}: Item Description is required` };
    if (!isFiniteNumber(qty) || qty <= 0) return { error: `Line ${i + 1}: Qty must be > 0` };
    if (!isFiniteNumber(unitPrice) || unitPrice < 0)
      return { error: `Line ${i + 1}: Unit Price must be ≥ 0` };

    // Rate factor: N3 returns decimal (0.05 for PT-5%). Reject unrealistic
    // values so a broken client can't post 500%+ tax.
    const rawRateFactor = (l as Record<string, unknown>).taxRateFactor;
    const taxRateFactor =
      isFiniteNumber(rawRateFactor) && rawRateFactor >= 0 && rawRateFactor <= 1
        ? rawRateFactor
        : 0;

    outLines.push({
      stockId,
      uomId,
      glAccountId,
      projectId,
      taxCodeId,
      tariffCodeId,
      description,
      qty,
      unitPrice,
      taxRateFactor,
      referenceNo: typeof l.referenceNo === "string" ? l.referenceNo.trim() : "",
    });
  }
  if (outLines.length === 0) return { error: "At least one complete line is required" };

  return {
    header: {
      supplierId,
      docDate,
      termId,
      purchaserId,
      description: typeof h.description === "string" ? h.description.trim() : "",
      referenceNo: typeof h.referenceNo === "string" ? h.referenceNo.trim() : "",
      supplierInvNo,
      isTaxInclusive: !!h.isTaxInclusive,
    },
    lines: outLines,
  };
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
    return { ok: false, status: 0, message: err instanceof Error ? err.message : "Network error" };
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
      message: env?.message || `Request failed (${res.status})`,
    };
  }
  return { ok: true, data: (env?.data ?? (parsed as T)) as T };
}

async function n3Post<T>(
  base: string,
  token: string,
  path: string,
  body: unknown,
): Promise<
  { ok: true; data: T; message: string } | { ok: false; status: number; message: string }
> {
  let res: Response;
  try {
    res = await fetch(`${base}/${path.replace(/^\/+/, "")}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, message: err instanceof Error ? err.message : "Network error" };
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
      message: env?.message || `N3 rejected the request (${res.status})`,
    };
  }
  return { ok: true, data: (env?.data ?? (parsed as T)) as T, message: env?.message || "OK" };
}

interface OData<T> {
  value: T[];
  count?: number;
}

async function checkDuplicate(
  base: string,
  token: string,
  supplierId: number,
  supplierInvNo: string,
): Promise<{ dup: true; docCode: string } | { dup: false } | { error: string; status: number }> {
  const normTarget = normalizeInv(supplierInvNo);
  // Iterate at most 5 pages of 200 for safety.
  const PAGE = 200;
  const MAX_PAGES = 10;
  for (let p = 0; p < MAX_PAGES; p++) {
    const res = await n3Get<OData<PurchaseInvoiceQueryRow>>(
      base,
      token,
      "api/PurchaseInvoices/Query",
      {
        $filter: `supplierId eq ${supplierId} and isCancelled eq false`,
        $top: PAGE,
        $skip: p * PAGE,
        $orderby: "docDate desc",
      },
    );
    if (!res.ok) return { error: res.message, status: res.status };
    const rows = Array.isArray(res.data?.value) ? res.data.value : [];
    for (const row of rows) {
      if (row.isCancelled) continue;
      const cur = typeof row.supplierInvNo === "string" ? normalizeInv(row.supplierInvNo) : "";
      if (cur && cur === normTarget) {
        return { dup: true, docCode: row.docCode ?? "(unknown)" };
      }
    }
    if (rows.length < PAGE) break;
  }
  return { dup: false };
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
  const parsed = coercePayload(raw);
  if ("error" in parsed)
    return jsonRes(400, { ok: false, kind: "validation", error: parsed.error });

  const base = process.env.OPEN_API_BASE_URL || MAIN_DEFAULT;

  // Duplicate check (authoritative for this app; N3's own validation stays the
  // final arbiter).
  const dup = await checkDuplicate(
    base,
    token,
    parsed.header.supplierId,
    parsed.header.supplierInvNo,
  );
  if ("error" in dup) {
    if (dup.status === 401) return jsonRes(401, { ok: false, kind: "auth", error: dup.error });
    return jsonRes(502, { ok: false, kind: "n3", error: `Duplicate check failed: ${dup.error}` });
  }
  if (dup.dup) {
    return jsonRes(409, {
      ok: false,
      kind: "duplicate",
      error: `Supplier Invoice Number already exists for this supplier under Purchase Invoice ${dup.docCode}.`,
      duplicate: { docCode: dup.docCode },
    });
  }

  // Tenant defaults (currency, stock location, etc.) — do not trust the browser
  // to supply these.
  const newDef = await n3Get<Record<string, unknown>>(base, token, "api/PurchaseInvoices/New");
  if (!newDef.ok) {
    if (newDef.status === 401)
      return jsonRes(401, { ok: false, kind: "auth", error: newDef.message });
    return jsonRes(502, { ok: false, kind: "n3", error: `Defaults failed: ${newDef.message}` });
  }
  const defaults = newDef.data ?? {};
  const currencyId = isFiniteNumber(defaults.currencyId) ? defaults.currencyId : 1;
  const stockLocationId = isFiniteNumber(defaults.stockLocationId)
    ? defaults.stockLocationId
    : undefined;

  // Build the N3 payload from a strict allow-list. Nothing else from the
  // browser reaches N3.
  const payload: Record<string, unknown> = {
    docDate: parsed.header.docDate,
    supplierId: parsed.header.supplierId,
    currencyId,
    currencyRate: 1,
    termId: parsed.header.termId,
    description: parsed.header.description,
    referenceNo: parsed.header.referenceNo,
    supplierInvNo: parsed.header.supplierInvNo,
    isTaxInclusive: parsed.header.isTaxInclusive,
  };
  if (parsed.header.purchaserId != null) payload.purchaserId = parsed.header.purchaserId;
  if (stockLocationId != null) payload.stockLocationId = stockLocationId;

  payload.itemDetails = parsed.lines.map((l, i) => ({
    pos: i + 1,
    stockId: l.stockId,
    uomId: l.uomId,
    accountId: l.glAccountId,
    projectId: l.projectId,
    taxCodeId: l.taxCodeId,
    tariffCodeId: l.tariffCodeId,
    description: l.description,
    qty: l.qty,
    unitPrice: l.unitPrice,
    discount: "0",
    isTaxInclusive: parsed.header.isTaxInclusive,
    referenceNo: l.referenceNo,
  }));

  const created = await n3Post<Record<string, unknown>>(
    base,
    token,
    "api/PurchaseInvoices/Create",
    payload,
  );
  if (!created.ok) {
    if (created.status === 401)
      return jsonRes(401, { ok: false, kind: "auth", error: created.message });
    return jsonRes(502, { ok: false, kind: "n3", error: created.message });
  }
  const data = created.data;
  const docCode = typeof data.docCode === "string" ? data.docCode : "";
  const id = typeof data.id === "string" ? data.id : null;
  if (!docCode) {
    return jsonRes(502, {
      ok: false,
      kind: "n3",
      error: "N3 returned no document number; please verify in N3 before retrying.",
    });
  }
  return jsonRes(200, { ok: true, docCode, id, message: created.message });
}

export const Route = createFileRoute("/api/bills/create")({
  server: {
    handlers: {
      POST: async ({ request }) => handle(request),
    },
  },
});
