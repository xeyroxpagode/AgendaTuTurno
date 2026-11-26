"use client";

import Link from "next/link";
import { BlockView } from "./BlockView";
import {
  ReportDetails, ReportTable, InterventionCards, type LinkBuilder,
} from "./shared";
import type { Block, Intervention, MoneyBlockData, OwnerSummaryResponse, ShiftsBlockData } from "./api";
import { formatCount, formatMinor } from "./format";

/**
 * J1 · Tres bloques del Resumen. Cada bloque muestra su propio `ReadState`,
 * `asOf`, `interval` y zona horaria del negocio. No se calcula ningún total.
 */
export function SummaryBlocks({
  summary,
  link,
  failureBlock,
}: {
  summary: OwnerSummaryResponse | null;
  link: LinkBuilder;
  failureBlock: <T>() => Block<T> | undefined;
}) {
  const timezone = summary?.businessTimezone;
  const collected = summary?.collectedToday ?? failureBlock<MoneyBlockData>();
  const shifts = summary?.shiftsToday ?? failureBlock<ShiftsBlockData>();
  const attention = summary?.requiresAttention ?? failureBlock<Intervention[]>();

  return (
    <div className="report-stack">
      <p className="report-live-date">
        Jornada local informada por el servidor: <strong>{summary?.localDate ?? "Desconocido"}</strong>
        <span> · Zona: {timezone ?? "Desconocida"}</span>
      </p>
      <div className="report-summary-grid">
        <BlockView title="Cobrado hoy" block={collected} businessTimezone={timezone} render={(data) => (
          <div className="report-stack">
            <ReportDetails items={[
              { label: "Total confirmado", value: formatMinor(data.totalMinor, data.currency) },
              { label: "Cobros canónicos", value: formatCount(data.count) },
              { label: "Reembolsos (aparte, sin netear)", value: formatMinor(data.refundsMinor, data.currency) },
            ]} />
            <ReportTable
              caption="Cobrado hoy por medio de pago"
              columns={["Medio", "Importe", "Cantidad"]}
              rows={data.byMethod.map((method) => [
                method.method, formatMinor(method.amountMinor, data.currency), formatCount(method.count),
              ])}
            />
            <div className="report-actions">
              <Link className="button secondary" href={link("/resumen", { view: "COMERCIAL" })}>Ver desglose comercial</Link>
              <Link className="button ghost" href={link("/cobro", { view: "COBRO" })}>Abrir cobro</Link>
            </div>
          </div>
        )} />

        <BlockView title="Turnos de hoy" block={shifts} businessTimezone={timezone} render={(data) => (
          <div className="report-stack">
            <ReportTable
              caption="Turnos de hoy por estado operativo"
              columns={["Estado", "Cantidad"]}
              rows={[
                ["Confirmados (sin atención terminal)", formatCount(data.confirmed)],
                ["Atendidos", formatCount(data.attended)],
                ["Cancelados", formatCount(data.cancelled)],
                ["Sin asistencia (no show)", formatCount(data.noShow)],
                ["Sesiones de curso (aparte)", formatCount(data.courseSessions)],
              ]}
            />
            <div className="report-actions">
              <Link className="button secondary" href={link("/agenda")}>Abrir agenda</Link>
              <Link className="button ghost" href={link("/attendance")}>Ver atención real</Link>
              <Link className="button ghost" href={link("/resumen", { view: "OPERATIVO" })}>Ver operativo</Link>
            </div>
          </div>
        )} />
      </div>

      <BlockView title="Requiere atención" block={attention} businessTimezone={timezone} render={(items) => (
        <InterventionCards items={items} link={link} businessTimezone={timezone} />
      )} />

      <div className="report-actions">
        <Link className="button secondary" href={link("/historial", { view: "HISTORIAL" })}>Abrir historial operativo</Link>
        <Link className="button ghost" href={link("/resumen", { view: "INDICADORES" })}>Ver definiciones de indicadores</Link>
      </div>
    </div>
  );
}
