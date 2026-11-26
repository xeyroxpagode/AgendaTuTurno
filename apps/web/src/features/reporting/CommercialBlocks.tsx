"use client";

import Link from "next/link";
import { BlockView } from "./BlockView";
import { ReportDetails, ReportTable, type LinkBuilder } from "./shared";
import type {
  Block, CashBlockData, CashSessionValue, CommercialResponse, MoneyBlockData,
  ObligationsBlockData, SalesBlockData, SettlementDebt, SettlementsBlockData, UncertainBlockData,
} from "./api";
import { formatCount, formatInstant, formatMinor } from "./format";

/**
 * J2 · M01–M06, M11, M12 y M13 con la forma real del DTO. Los importes del
 * servidor se muestran tal cual; este archivo no los suma ni deduce estados.
 */
export function CommercialBlocks({
  response,
  link,
  failureBlock,
}: {
  response: CommercialResponse | null;
  link: LinkBuilder;
  failureBlock: <T>() => Block<T> | undefined;
}) {
  const moneyRows = (values: CashSessionValue[]) => values.map((value) => [
    <Link key={value.cashSessionId} href={link("/caja", { sessionId: value.cashSessionId, view: "CAJA" })}>
      {value.cashSessionId}
    </Link>,
    formatMinor(value.amountMinor, null),
  ]);

  const debtRows = (debts: SettlementDebt[]) => debts.map((debt) => [
    <Link key={debt.settlementId} href={link("/team/economia", { settlementId: debt.settlementId })}>
      {debt.settlementId}
    </Link>,
    debt.kind,
    formatMinor(debt.balanceMinor, null),
  ]);

  return (
    <div className="report-grid">
      <BlockView title="Cobrado y cantidad de cobros" block={response?.money ?? failureBlock<MoneyBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportDetails items={[
            { label: "Total confirmado", value: formatMinor(data.totalMinor, data.currency) },
            { label: "Cobros canónicos", value: formatCount(data.count) },
            { label: "Reembolsos (aparte, sin netear)", value: formatMinor(data.refundsMinor, data.currency) },
          ]} />
          <ReportTable caption="Cobrado por medio de pago" columns={["Medio", "Importe", "Cantidad"]}
            rows={data.byMethod.map((method) => [
              method.method, formatMinor(method.amountMinor, data.currency), formatCount(method.count),
            ])} />
          <Link className="button secondary" href={link("/cobro", { view: "COBRO" })}>Abrir cobro</Link>
        </div>
      )} />

      <BlockView title="Ventas del período" block={response?.sales ?? failureBlock<SalesBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportDetails items={[
            { label: "Ventas confirmadas", value: formatMinor(data.salesMinor, data.currency) },
            { label: "Cantidad", value: formatCount(data.count) },
          ]} />
          <div className="report-actions">
            <Link className="button secondary" href={link("/ventas", { view: "VENTAS" })}>Abrir ventas</Link>
            <Link className="button ghost" href={link("/historial", { type: "SALE_CONFIRMED", view: "HISTORIAL" })}>Ver historial de ventas</Link>
          </div>
        </div>
      )} />

      <BlockView title="Efectivo esperado y diferencias" block={response?.cash ?? failureBlock<CashBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportDetails items={[{ label: "Observaciones ambiguas", value: data.ambiguous ? "Sí (UNKNOWN, sin LIMIT 1)" : "No" }]} />
          <ReportTable caption="Efectivo esperado por sesión" columns={["Sesión", "Importe"]} rows={moneyRows(data.expected)} />
          <ReportTable caption="Diferencias actuales" columns={["Sesión", "Importe firmado"]} rows={moneyRows(data.currentDifferences)} />
          <ReportTable caption="Diferencias históricas" columns={["Sesión", "Importe firmado"]} rows={moneyRows(data.historicalDifferences)} />
        </div>
      )} />

      <BlockView title="Obligaciones pendientes y vencidas" block={response?.obligations ?? failureBlock<ObligationsBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportTable caption="Obligaciones por dirección" columns={["Dirección", "Pendientes", "Vencidas", "Importe desconocido", "Saldo"]}
            rows={data.byKind.map((item) => [
              item.kind, formatCount(item.pendingCount), formatCount(item.overdueCount),
              formatCount(item.unknownCount), formatMinor(item.balanceMinor, null),
            ])} />
          <Link className="button secondary" href={link("/finanzas", { view: "OBLIGACIONES" })}>Abrir obligaciones</Link>
        </div>
      )} />

      <BlockView title="Liquidaciones pendientes" block={response?.settlements ?? failureBlock<SettlementsBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportDetails items={[{
            label: "Estados de dominio",
            value: data.estimateStates.length ? data.estimateStates.join(", ") : "Ninguno informado",
          }]} />
          <ReportTable caption="Deuda real por liquidación" columns={["Liquidación", "Dirección", "Saldo"]} rows={debtRows(data.realDebt)} />
          <Link className="button secondary" href={link("/team/economia", { view: "ECONOMIA" })}>Abrir economía del personal</Link>
        </div>
      )} />

      <BlockView title="Operaciones inciertas" block={response?.uncertain ?? failureBlock<UncertainBlockData>()} render={(data) => (
        <div className="report-stack">
          <ReportTable caption="Intentos durables inciertos" columns={["Operación", "Estado", "Comando", "Detectado"]}
            rows={data.items.map((item) => [
              <Link key={item.operationId} href={link("/cobro-incierto", { operationId: item.operationId })}>{item.operationId}</Link>,
              item.status, item.command, formatInstant(item.createdAt),
            ])} />
        </div>
      )} />
    </div>
  );
}
