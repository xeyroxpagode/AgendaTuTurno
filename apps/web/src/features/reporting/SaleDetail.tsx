"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Button, StatusPill } from "@youngkingz/ui";
import { api } from "@/lib/api/client";
import { ReportDetails, ReportTable } from "./shared";
import { formatInstant, formatMinor, safeReturnTo } from "./format";
import { classifyFailure, type Failure } from "./failure";
import "./reporting.css";

/** Forma real de `GET /v1/sales/:id` (H05), sin reescribir D20. */
type SaleDetailView = {
  id: string;
  status: string;
  source: string;
  totalMinor: number;
  settledMinor: number;
  balance: string;
  revision: number;
  createdAt: string;
  lines: Array<{
    name: string;
    kind: string;
    quantity: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }>;
};

type Query = { [key: string]: string | string[] | undefined };

const minor = (value: number | null | undefined) =>
  formatMinor(value === null || value === undefined ? null : String(value), null);

/** R4 · Detalle real de venta, destino de los hechos `SALE_CONFIRMED`. */
export function SaleDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Query>;
}) {
  const { id } = use(params);
  const query = use(searchParams);
  const rawReturnTo = typeof query.returnTo === "string" ? query.returnTo : null;
  const [sale, setSale] = useState<SaleDetailView | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let alive = true;
    setSale(null);   // LOADING explícito
    setFailure(null);
    api<SaleDetailView>(`/v1/sales/${encodeURIComponent(id)}`, { operationId: `h09-sale-${id}` })
      .then((value) => { if (alive) setSale(value); })
      .catch((error) => {
        if (alive) {
          setSale(null);
          setFailure(classifyFailure(error));
        }
      });
    return () => { alive = false; };
  }, [id, reloadToken]);

  const isAlert = Boolean(failure);
  return (
    <div className="content report-content" data-testid="sale-detail">
      <header className="page-header">
        <div>
          <p className="eyebrow">Reporting · Origen del hecho</p>
          <h1 className="page-title">Venta {id}</h1>
          <p>Detalle leído del endpoint real de Ventas; sin importes calculados aquí.</p>
        </div>
        <Link className="button ghost" href={safeReturnTo(rawReturnTo, "/resumen")}>Volver al resumen</Link>
      </header>

      <section className="report-block" role={isAlert ? "alert" : "status"} aria-live={isAlert ? "assertive" : "polite"} aria-busy={!sale && !failure}>
        <header className="report-block-head">
          <h3>Hecho canónico</h3>
          <StatusPill tone={failure ? "danger" : sale ? "positive" : "neutral"}>
            {failure ? "Error de lectura" : sale ? "Correcto" : "Cargando"}
          </StatusPill>
        </header>

        {failure && <p className="report-error">[{failure.code}] {failure.message}</p>}
        {!sale && !failure && <p className="report-loading">Cargando datos reales…</p>}
        {failure?.recoverable && (
          <Button type="button" onClick={() => setReloadToken((token) => token + 1)}>Reintentar</Button>
        )}

        {sale && (
          <div className="report-stack">
            <ReportDetails items={[
              { label: "Identificador", value: sale.id },
              { label: "Estado", value: sale.status },
              { label: "Origen", value: sale.source },
              { label: "Total (unidades menores; moneda no informada)", value: minor(sale.totalMinor) },
              { label: "Conciliado", value: minor(sale.settledMinor) },
              { label: "Balance", value: sale.balance },
              { label: "Revisión", value: sale.revision },
              { label: "Creado", value: formatInstant(sale.createdAt) },
            ]} />
            <ReportTable caption="Líneas de la venta" columns={["Ítem", "Tipo", "Cantidad", "Precio unitario", "Subtotal"]}
              rows={sale.lines.map((line) => [
                line.name, line.kind, line.quantity, minor(line.unitPriceMinor), minor(line.lineTotalMinor),
              ])} />
          </div>
        )}
      </section>
    </div>
  );
}
