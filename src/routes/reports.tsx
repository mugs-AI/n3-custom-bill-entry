import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/reports")({
  head: () => ({
    meta: [
      { title: "GL Purchase Analysis · Custom Bill Entry" },
      {
        name: "description",
        content:
          "Analyse Purchase Invoices by GL Account with drill-down and Excel/PDF exports, sourced live from N3.",
      },
      { property: "og:title", content: "GL Purchase Analysis" },
      {
        property: "og:description",
        content: "Live GL Purchase Analysis over N3 Purchase Invoices.",
      },
    ],
  }),
  component: ReportsPage,
});

function ReportsPage() {
  return (
    <AppShell>
      <div className="app-card p-6">
        <h1 className="text-lg font-semibold">GL Purchase Analysis</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Coming in Phase 4 — filters, drill-down and Excel/PDF export.
        </p>
      </div>
    </AppShell>
  );
}
