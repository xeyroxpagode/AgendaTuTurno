import { ProductDetail } from "@/features/orders/ProductCatalog";

export default async function ProductoPage({ params }: { params: Promise<{ sku: string }> }) {
  const { sku } = await params;
  return <main className="content"><ProductDetail sku={sku.toUpperCase()} /></main>;
}
