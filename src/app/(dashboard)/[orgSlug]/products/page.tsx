import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { ProductsList } from "@/components/products/products-list";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function ProductsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Products" description="Catalog of products and services" maxWidth="7xl">
      <ProductsList orgId={ctx.orgId} />
    </PageShell>
  );
}
