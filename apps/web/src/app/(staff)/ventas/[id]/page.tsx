import { Suspense } from "react";
import { SaleDetail } from "@/features/reporting/SaleDetail";

/** R4 · Detalle de venta; `params` y `searchParams` son promesas en Next 16. */
export default function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return (
    <Suspense fallback={<div className="content" role="status" aria-live="polite">Cargando venta…</div>}>
      <SaleDetail params={params} searchParams={searchParams} />
    </Suspense>
  );
}
