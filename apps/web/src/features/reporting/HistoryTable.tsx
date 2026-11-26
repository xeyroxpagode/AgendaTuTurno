"use client";

import Link from "next/link";
import { Button } from "@youngkingz/ui";
import { BlockView } from "./BlockView";
import { ReportTable, type LinkBuilder } from "./shared";
import type { Block, HistoryEntry, HistoryResponse } from "./api";
import { formatCount, formatInstant } from "./format";

/** J5 · Hechos canónicos con cursor estable; nunca `/v1/audit` como href. */
export function HistoryTable({
  response,
  link,
  failureBlock,
  onCursor,
  onRetry,
}: {
  response: HistoryResponse | null;
  link: LinkBuilder;
  failureBlock: <T>() => Block<T> | undefined;
  onCursor: (cursor: string | null) => void;
  onRetry: () => void;
}) {
  const block: Block<HistoryEntry[]> | undefined = response
    ? {
      state: response.state,
      data: response.items,
      completeness: response.completeness,
      asOf: response.asOf,
      interval: response.interval,
    }
    : failureBlock<HistoryEntry[]>();
  const nextCursor = response?.nextCursor ?? null;

  return (
    <BlockView
      title="Historial operativo"
      block={block}
      onRetry={onRetry}
      render={(items) => (
        <div className="report-stack">
          <p className="muted">Entradas en esta página: {formatCount(items.length)}</p>
          <ReportTable
            caption="Hechos autorizados del historial"
            columns={["Fecha", "Tipo", "Objeto", "Secuencia", "Estado", "Acción", "Origen"]}
            rows={items.map((entry) => [
              formatInstant(entry.occurredAt),
              entry.type,
              entry.objectId,
              entry.sequence === null ? "—" : String(entry.sequence),
              entry.state ?? "Desconocido",
              entry.action ?? "—",
              entry.destination
                ? <Link href={link(entry.destination)}>Abrir hecho</Link>
                : <span className="muted">Sin acceso de detalle</span>,
            ])}
          />
          <nav className="report-pagination" aria-label="Paginación del historial">
            <Button type="button" disabled={!nextCursor} onClick={() => onCursor(nextCursor)}>
              Siguiente página
            </Button>
            <Button type="button" onClick={() => onCursor(null)}>Volver al inicio</Button>
          </nav>
        </div>
      )}
    />
  );
}
