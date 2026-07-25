import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { useAuthToken, useHydrated } from "@/hooks/use-auth";
import { n3Call } from "@/lib/n3-client";
import { invoiceToDraft, type RawInvoice } from "@/lib/invoice-to-draft";
import { BillForm } from "@/routes/index";

// Full-screen edit route for an existing Purchase Invoice. Loads live from N3
// (no local cache) so what the user edits is always what N3 currently holds.
// The BillForm renders in "edit" mode; unsaved changes are persisted to a
// per-invoice sessionStorage draft key so a browser reload does not lose work.

export const Route = createFileRoute("/purchase-invoices/$id/edit")({
  head: ({ params }) => ({
    meta: [
      { title: `Edit Purchase Invoice · ${params.id} · Custom Bill Entry` },
      {
        name: "description",
        content: "Edit an existing N3 Purchase Invoice with the same keyboard-first grid.",
      },
      { property: "og:title", content: "Edit Purchase Invoice · Custom Bill Entry" },
      {
        property: "og:description",
        content: "Edit an existing N3 Purchase Invoice with the same keyboard-first grid.",
      },
    ],
  }),
  component: EditPurchaseInvoicePage,
});

function EditPurchaseInvoicePage() {
  const hydrated = useHydrated();
  const token = useAuthToken();
  const { id } = Route.useParams();

  const q = useQuery({
    queryKey: ["n3", "purchaseInvoice", id],
    enabled: hydrated && !!token && !!id,
    queryFn: ({ signal }) =>
      n3Call<RawInvoice>(`api/PurchaseInvoices/${encodeURIComponent(id)}`, { signal }),
    // Don't reuse stale copies — the user might have edited in N3 directly.
    staleTime: 0,
  });

  return (
    <AppShell>
      <div className="mb-3 flex items-center justify-end">
        <Link to="/history" className="app-btn">
          Back to History
        </Link>
      </div>
      {!hydrated || !token ? (
        <div className="app-card p-6 text-sm text-muted-foreground">
          Sign in to N3 to edit this Purchase Invoice.
        </div>
      ) : q.isLoading ? (
        <div className="app-card p-6 text-sm text-muted-foreground">
          Loading Purchase Invoice {id}…
        </div>
      ) : q.isError ? (
        <div className="app-card p-6 text-sm text-destructive">
          Failed to load Purchase Invoice: {q.error instanceof Error ? q.error.message : "Unknown"}
        </div>
      ) : q.data ? (
        <BillForm mode="edit" editInvoice={invoiceToDraft(q.data)} />
      ) : null}
    </AppShell>
  );
}
