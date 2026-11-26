"use client";

import Link from "next/link";
import { BlockView } from "./BlockView";
import { ReportDetails, ReportTable, type LinkBuilder } from "./shared";
import type {
  Block, ConflictItem, ConflictsBlockData, CourseOccupancyBlockData, CourseOccupancyItem, CourseSessionsBlockData,
  OperationalResponse, OrdersBlockData, SettlementsBlockData, ShiftsBlockData, StockBlockData,
} from "./api";
import { formatCount, formatInstant, formatMinor } from "./format";

/** J3 · M07–M10 y M13–M16. La economía global no se calcula en el cliente. */
export function OperationalBlocks({
  response,
  link,
  failureBlock,
}: {
  response: OperationalResponse | null;
  link: LinkBuilder;
  failureBlock: <T>() => Block<T> | undefined;
}) {
  const debtRows = (items: SettlementsBlockData["realDebt"]) => items.map((debt) => [
    <Link key={debt.settlementId} href={link("/team/economia", { settlementId: debt.settlementId })}>
      {debt.settlementId}
    </Link>,
    debt.kind,
    formatMinor(debt.balanceMinor, null),
  ]);

  return (
    <div className="report-grid">
      <BlockView title="Turnos por estado" block={response?.shifts ?? failureBlock<ShiftsBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportTable caption="Turnos por estado" columns={["Estado", "Cantidad"]}
            rows={[
              ["Confirmados", formatCount(data.confirmed)],
              ["Atendidos", formatCount(data.attended)],
              ["Cancelados", formatCount(data.cancelled)],
              ["Sin asistencia", formatCount(data.noShow)],
              ["Sesiones de curso (aparte)", formatCount(data.courseSessions)],
            ]} />
          <Link className="button secondary" href={link("/agenda")}>Abrir agenda</Link>
        </div>
      )} />

      <BlockView title="Atenciones realizadas" block={response?.attendance ?? failureBlock<{ count: number }>()} render={(data) => (
        <div className="report-stack">
          <ReportDetails items={[{ label: "Atenciones en estados terminales", value: formatCount(data.count) }]} />
          <Link className="button secondary" href={link("/attendance")}>Abrir atención real</Link>
        </div>
      )} />

      <BlockView title="Stock crítico" block={response?.stock ?? failureBlock<StockBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportTable caption="Artículos por criticidad" columns={["Artículo", "Ubicación", "Criticidad", "Físico", "Vendible", "Mínimo", "Posición"]}
            rows={data.items.map((item) => [
              item.sku, item.locationId, item.criticality, formatCount(item.physical),
              formatCount(item.sellable), formatCount(item.minimum), item.hasPosition ? "Sí" : "No",
            ])} />
          <Link className="button secondary" href={link("/insumos")}>Abrir insumos</Link>
        </div>
      )} />

      <BlockView title="Pedidos pendientes" block={response?.orders ?? failureBlock<OrdersBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportTable caption="Pedidos por estado" columns={["Estado", "Cantidad"]}
            rows={data.byStatus.map((status) => [status.status, formatCount(status.count)])} />
          <Link className="button secondary" href={link("/inventario")}>Abrir pedidos en inventario</Link>
        </div>
      )} />

      <BlockView title="Conflictos de disponibilidad" block={response?.conflicts ?? failureBlock<ConflictsBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportDetails items={[{ label: "Conflictos abiertos", value: formatCount(data.count) }]} />
          <ReportTable caption="Conflictos por origen estable" columns={["Origen", "Referencia", "Motivo", "Detectado"]}
            rows={data.items.map((item: ConflictItem) => [
              item.sourceType,
              <Link key={item.sourceId} href={link("/absences", { sourceId: item.sourceId })}>{item.sourceId}</Link>,
              item.reasonCode,
              formatInstant(item.detectedAt),
            ])} />
        </div>
      )} />

      <BlockView title="Sesiones de cursos" block={response?.courses ?? failureBlock<CourseSessionsBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportTable caption="Sesiones por estado" columns={["Estado", "Cantidad"]}
            rows={data.byStatus.map((status) => [status.status, formatCount(status.count)])} />
          <Link className="button secondary" href={link("/cursos")}>Abrir cursos</Link>
        </div>
      )} />

      <BlockView title="Ocupación de cursos (cursor propio)" block={response?.courseOccupancy ?? failureBlock<CourseOccupancyBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportTable caption="Ocupación de sesiones" columns={["Sesión", "Fecha local", "Profesional", "Título"]}
            rows={data.items.map((item: CourseOccupancyItem) => [
              <Link key={item.allocationId} href={link("/cursos")}>{item.sessionId}</Link>,
              item.localDate,
              item.staffMemberId ?? "Sin asignar",
              item.title ?? "Sin título",
            ])} />
          <p className="muted">
            Cursor propio de esta fuente: {data.nextCursor ?? "No informado"}. No se mezcla con el cursor del historial.
          </p>
        </div>
      )} />

      <BlockView title="Economía propia o autorizada" block={response?.economy ?? failureBlock<SettlementsBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportDetails items={[{
            label: "Estados de dominio",
            value: data.estimateStates.length ? data.estimateStates.join(", ") : "Ninguno informado",
          }]} />
          <ReportTable caption="Deuda real por liquidación" columns={["Liquidación", "Dirección", "Saldo"]} rows={debtRows(data.realDebt)} />
          <Link className="button secondary" href={link("/team/economia")}>Abrir economía</Link>
        </div>
      )} />
    </div>
  );
}
