import { createFileRoute } from "@tanstack/react-router";

// Same-origin proxy to N3 Open API. The browser NEVER calls openapi.account.qne.cloud
// directly (CORS). All requests go through /api/proxy/<n3-path>.
//
// Route the path:
//   /api/proxy/api/Suppliers/List              -> {OPEN_API_BASE_URL}/api/Suppliers/List
//   /api/proxy/reporting/api/reporting/...     -> {OPEN_API_REPORTING_BASE_URL}/api/reporting/...
//
// The Authorization: Bearer <jwt> header from the incoming request is forwarded
// verbatim. The N3 base URLs live only in server env and are never exposed to
// the browser bundle.

const MAIN_DEFAULT = "https://openapi.account.qne.cloud";
const REPORTING_DEFAULT = "https://openapi-reporting.account.qne.cloud";

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
]);

async function handle(request: Request, splat: string | undefined) {
  const mainBase = process.env.OPEN_API_BASE_URL || MAIN_DEFAULT;
  const reportingBase = process.env.OPEN_API_REPORTING_BASE_URL || REPORTING_DEFAULT;

  const rest = (splat ?? "").replace(/^\/+/, "");
  let base = mainBase;
  let targetPath = rest;
  if (rest.startsWith("reporting/")) {
    base = reportingBase;
    targetPath = rest.slice("reporting/".length);
  }

  const url = new URL(request.url);
  const target = `${base}/${targetPath}${url.search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("accept", headers.get("accept") ?? "application/json");

  const method = request.method.toUpperCase();
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    return new Response(
      JSON.stringify({
        success: false,
        code: "PROXY_FETCH_FAILED",
        message: err instanceof Error ? err.message : "Upstream request failed",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders.set(key, value);
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

export const Route = createFileRoute("/api/proxy/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => handle(request, params._splat),
      POST: async ({ request, params }) => handle(request, params._splat),
      PUT: async ({ request, params }) => handle(request, params._splat),
      PATCH: async ({ request, params }) => handle(request, params._splat),
      DELETE: async ({ request, params }) => handle(request, params._splat),
    },
  },
});
