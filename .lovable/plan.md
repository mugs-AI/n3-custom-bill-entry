
# Custom Bill Entry — N3 AI Cloud Accounting

An alternative, keyboard-friendly Purchase Invoice UI that reads and writes live against N3 Open API. N3 is the only source of truth — no local DB for suppliers, invoices, GL, etc.

## Architecture

This project runs on TanStack Start (React + Vite + TS) which is a same-origin full-stack framework. That fills the "React SPA + small backend proxy" requirement without adding Express:

- **Frontend**: routes under `src/routes/*.tsx`, calls only same-origin `/api/*`.
- **Backend proxy**: TanStack server routes under `src/routes/api/proxy/$.ts` (splat) forward to `OPEN_API_BASE_URL` / `OPEN_API_REPORTING_BASE_URL`, attaching `Authorization: Bearer <token>` from the incoming request. Base URLs live in server env only, never in the browser bundle.
- **Auth**:
  - Path A (prod): app is launched from N3 My Apps with `?token=<jwt>`; store in `localStorage` under one key, reuse until expiry.
  - Path B (dev only): `POST /api/auth/connect` server route accepts an API key, calls `GET {OPEN_API}/api/auth/connect?api-key=…`, returns the access token. Route + UI gated on `import.meta.env.DEV` / `process.env.NODE_ENV !== 'production'`.
- **Envelope handling**: every proxy response passes through unchanged, but a `callN3()` client helper checks `code === "0000"` and surfaces `message` on business errors.

## Phased delivery

Version scope is large; I'll ship in phases and pause for feedback between each.

**Phase 1 — Foundation (this turn):**
- Server env plumbing, proxy splat route, dev connect route.
- Auth store (localStorage) + token capture from `?token=` on `/`.
- Dev sign-in page at `/dev-login` (hidden in prod).
- N3 API client (envelope-aware, OData paging helper that pulls all pages).
- Design system pass in `styles.css` (clean, dense, keyboard-first look — not the placeholder).
- Screen 1 shell (New Bill Entry) with header fields wired to live Suppliers / Purchasers lookups, and the detail grid layout + keyboard nav (Tab/Shift-Tab/Enter, searchable comboboxes, no accidental submit).

**Phase 2:**
- Save flow: duplicate check by (SupplierId, normalized Supplier INV#), POST create Purchase Invoice, show N3-assigned number, View / Create Another.
- All lookup dropdowns (Stock, GL Account, Project as Cost Centre, Tax Code, Tariff Code) with full pagination + client-side search.

**Phase 3:**
- Screen 2 History: search list, view in simplified layout, edit + save with latest-fetch guard.

**Phase 4:**
- Screen 3 GL Purchase Analysis: filters, drilldown, Excel + PDF export.

## Technical notes

- Proxy route: `src/routes/api/proxy/$.ts` handles `GET/POST/PUT/DELETE`. Forwards to `${OPEN_API_BASE_URL}/${_splat}` (or reporting host when path starts `reporting/`). Passes through `Authorization` header from the incoming request and body/query string verbatim. Never logs the token.
- Base URLs default to `https://openapi.account.qne.cloud` and `https://openapi-reporting.account.qne.cloud` if env vars are absent, per brief.
- Dev connect route rejects with 404 when `process.env.NODE_ENV === 'production'`.
- OData paging helper: loops `$skip` in `$top`-sized pages until `data.value.length < $top` or `data.count` reached.
- Scoped OpenAPI usage: fetch `platform-v1` + `purchase-v1` + `gl-v1` + `stock-v1` on demand from `/doc/*.json` during Phase 1/2 to confirm operationIds and payload shapes (via `curl`, at build time, not in the app).

## Out of scope (per brief V1 exclusions)

Local DB, local users, attachments, approvals, HQ Sequence uniqueness, void/cancel, offline entry, Excel import.

## After Phase 1 I'll pause so you can:

- Provide a dev API key (via My Apps → New App) to test the live connect.
- Confirm the visual direction before I wire the remaining screens.
