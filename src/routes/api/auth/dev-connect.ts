import { createFileRoute } from "@tanstack/react-router";

// Dev-only backend route that exchanges an N3 API key for an access token.
// The browser MUST NOT call GET {OPEN_API}/api/auth/connect directly (CORS +
// API key exposure); this route runs server-side.
//
// Disabled in production: returns 404.

export const Route = createFileRoute("/api/auth/dev-connect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (process.env.NODE_ENV === "production") {
          return new Response("Not found", { status: 404 });
        }

        let apiKey: string | undefined;
        try {
          const body = (await request.json()) as { apiKey?: string };
          apiKey = body?.apiKey?.trim();
        } catch {
          // fall through
        }
        if (!apiKey) {
          return Response.json(
            { success: false, message: "apiKey is required in request body" },
            { status: 400 },
          );
        }

        const base = process.env.OPEN_API_BASE_URL || "https://openapi.account.qne.cloud";
        const url = `${base}/api/auth/connect?api-key=${encodeURIComponent(apiKey)}`;

        let upstream: Response;
        try {
          upstream = await fetch(url, {
            method: "GET",
            headers: { accept: "application/json" },
          });
        } catch (err) {
          return Response.json(
            {
              success: false,
              message: err instanceof Error ? err.message : "Upstream fetch failed",
            },
            { status: 502 },
          );
        }

        const text = await upstream.text();
        // Pass through the N3 envelope so the client can inspect it.
        return new Response(text, {
          status: upstream.status,
          headers: {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
          },
        });
      },
    },
  },
});
