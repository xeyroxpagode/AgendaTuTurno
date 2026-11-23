import { GuestOrderTracking } from "@/features/orders/ProductCatalog";

export default async function PedidoPublicoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="content"><GuestOrderTracking orderId={id} /></main>;
}
