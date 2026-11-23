"use client";

import type { OrderStatus } from "./api";

/**
 * T070 · CTA principal único por estado. La decisión se deriva de
 * (status, role, capabilities) en CLIENTE, nunca de un flag del servidor.
 * Capacidades H05 no se exponen: el único dato sensible es `operationId`,
 * generado por el wrapper `stableOperationId`.
 */
type Props = {
  status: OrderStatus;
  role?: string;
  capabilities?: string[];
  busy?: boolean;
  onAction: () => void;
};

const label: Record<OrderStatus, string> = {
  REQUESTED: "Confirmar pedido",
  CONFIRMED: "Iniciar preparación",
  PREPARING: "Marcar listo para retiro",
  READY: "Registrar retiro",
  DELIVERED: "Ver comprobante",
  REJECTED: "Ver motivo",
  CANCELLED: "Ver detalle"
};

const capabilityFor: Partial<Record<OrderStatus, string>> = {
  REQUESTED: "orders.confirm",
  CONFIRMED: "orders.prepare",
  PREPARING: "orders.ready",
  READY: "orders.deliver"
};

const terminal: OrderStatus[] = ["DELIVERED", "REJECTED", "CANCELLED"];

export function OrderPrimaryAction({ status, role, capabilities = [], busy = false, onAction }: Props) {
  const staff = Boolean(role && role !== "CLIENT" && role !== "GUEST");
  if (staff) {
    const required = capabilityFor[status];
    const allowed = required ? capabilities.includes(required) : true;
    if (!allowed) return <span className="ord-muted" role="status">Sin autoridad para esta acción</span>;
  }
  return (
    <button
      type="button"
      className="button primary ord-primary"
      onClick={onAction}
      disabled={busy || terminal.includes(status)}
      aria-busy={busy}
      aria-live="polite"
    >
      {busy ? "Procesando…" : label[status]}
    </button>
  );
}
