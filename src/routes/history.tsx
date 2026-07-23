import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Purchase Invoice History · Custom Bill Entry" },
      {
        name: "description",
        content:
          "Search, view and edit Purchase Invoices retrieved live from N3 AI Cloud Accounting.",
      },
      { property: "og:title", content: "Purchase Invoice History" },
      {
        property: "og:description",
        content: "Live-search Purchase Invoices from N3 AI Cloud Accounting.",
      },
    ],
  }),
  component: HistoryPage,
});

function HistoryPage() {
  return (
    <AppShell>
      <div className="app-card p-6">
        <h1 className="text-lg font-semibold">Purchase Invoice History</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Coming in Phase 3 — live N3 search, simplified view, and edit-with-latest-fetch.
        </p>
      </div>
    </AppShell>
  );
}
