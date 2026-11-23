"use client";

import "./orders.css";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { formatARS, ordersApi, type OrderStatus, type OrderView } from "./api";
import { OrderPrimaryAction } from "./OrderPrimaryAction";

type Context = { businessId: string; role: string; capabilities: string[] };

const statics: OrderStatus[] = ["REQUESTED", "CONFIRMED", "PREPARING", "READY", "DELIVERED", "REJECTED", "CANCELLED"];
const statusLabel: Record<OrderStatus, string> = {
  REQUESTED: "Solicitado", CONFIRMED: "Confirmado", PREPARING: "En preparación",
  READY: "Listo para retiro", DELIVERED: "Entregado", REJECTED: "Rechazado", CANCELLED: "Cancelado"
};

/**
 * T065–T069 · Recorridos de Recepción y Owner, anclados bajo Inventario
 * (T064): bandeja con filtros, detalle, preparación/registro de retiro y
 * supervisión. Sin sexta pestaña y sin exponer capacidades H05.
 */
export function OrdersWorkspace() {
  const [context, setContext] = useState<Context | null>(null);
  const [items, setItems] = useState<OrderView[]>([]);
  const [status, setStatus] = useState<string>("ALL");
  const [selected, setSelected] = useState<OrderView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [audit, setAudit] = useState<Array<{ action: string; outcome: string; occurredAt: string; resourceId: string | null; changes: unknown }>>([]);

  const load = useCallback(async (filter: string) => {
    setLoading(true);
    try {
      const [ctx, list] = await Promise.all([
        api<Context>("/v1/iam/context"),
        ordersApi.list({ status: filter })
      ]);
      setContext(ctx);
      setItems(list.data.items);
      setSelected((old) => old ? list.data.items.find((item) => item.id === old.id) ?? null : null);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No pudimos cargar los pedidos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(status); }, [load, status]);

  async function act(action: "confirm" | "prepare" | "ready" | "deliver" | "cancel" | "reject") {
    if (!selected) return;
    setBusy(true);
    setNotice("");
    try {
      if (action === "confirm") await ordersApi.confirm(selected.id, selected.revision);
      if (action === "prepare") await ordersApi.prepare(selected.id, selected.revision);
      if (action === "ready") {
        await ordersApi.ready(selected.id, selected.revision, selected.lines.map((line) => ({
          sku: line.sku, quantity: line.confirmedQuantity ?? line.quantity
        })));
      }
      if (action === "deliver") {
        const name = window.prompt("Nombre de quien retira:", "") ?? "";
        if (!name.trim()) throw new Error("El receptor es obligatorio.");
        const cashSessionId = window.prompt("ID de la sesión de caja abierta:", "") ?? "";
        if (!cashSessionId.trim()) throw new Error("La sesión de caja es obligatoria para el cobro presencial.");
        const total = selected.totalConfirmedMinor ?? selected.totalRequestedMinor;
        await ordersApi.deliver(selected.id, {
          expectedRevision: selected.revision,
          receiver: { kind: "CUSTOMER", name: name.trim(), verificationMethod: "DOCUMENT" },
          // El frontend sólo conoce el importe y el medio: servidor deriva
          // `sourceReference` y decide `reuseCommitments` (CORR-04).
          components: [{ method: "CASH", amountMinor: total, outcome: "CONFIRMED" }],
          cashSessionId: cashSessionId.trim()
        });
      }
      if (action === "cancel") {
        const reason = window.prompt("Motivo de la cancelación:", "") ?? "";
        await ordersApi.cancel(selected.id, selected.revision, reason);
      }
      if (action === "reject") {
        const reason = window.prompt("Motivo del rechazo:", "") ?? "";
        await ordersApi.reject(selected.id, selected.revision, reason);
      }
      setNotice("Operación registrada.");
      await load(status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.");
    } finally {
      setBusy(false);
    }
  }

  function primaryAction() {
    if (!selected) return;
    const map: Partial<Record<OrderStatus, () => void>> = {
      REQUESTED: () => void act("confirm"),
      CONFIRMED: () => void act("prepare"),
      PREPARING: () => void act("ready"),
      READY: () => void act("deliver")
    };
    (map[selected.status] ?? (() => void load(status)))();
  }

  async function showHistory() {
    if (!selected) return;
    try {
      const all = await api<Array<{ action: string; outcome: string; occurredAt: string; resourceId: string | null; changes: unknown }>>(
        "/v1/audit?limit=100"
      );
      // `resourceId` es el PRODUCT_ORDER id; `changes` no lo repite en todos
      // los eventos (G01: defecto detectado en QA de navegador).
      setAudit(all.filter((event) => event.resourceId === selected.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No pudimos leer la auditoría.");
    }
  }

  return (
    <section className="ord-workspace" aria-label="Pedidos de productos">
      <header className="ord-header">
        <h2>Pedidos de productos</h2>
        <label className="ord-filter">
          <span className="sr-only">Filtrar por estado</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="ALL">Todos los estados</option>
            {statics.map((value) => <option key={value} value={value}>{statusLabel[value]}</option>)}
          </select>
        </label>
      </header>

      {error && <div className="ord-banner" role="alert">{error}</div>}
      {notice && <div className="ord-banner ord-ok" role="status">{notice}</div>}
      {loading && <p role="status">Cargando pedidos…</p>}

      <div className="ord-grid">
        <div className="ord-list" role="list">
          {items.map((order) => (
            <button key={order.id} role="listitem" className={`ord-row ${selected?.id === order.id ? "is-active" : ""}`}
              onClick={() => { setSelected(order); setAudit([]); }}>
              <strong>{order.lines[0]?.name ?? "Pedido"}</strong>
              <small>#{order.id.slice(0, 8)} · {order.lines.length} línea(s)</small>
              <span className={`ord-badge ord-${order.status.toLowerCase()}`}>{statusLabel[order.status]}</span>
              <small className="ord-amount">{formatARS(order.totalConfirmedMinor ?? order.totalRequestedMinor)}</small>
            </button>
          ))}
          {!loading && !items.length && <p className="ord-muted" role="status">No hay pedidos con este filtro.</p>}
        </div>

        {selected && (
          <article className="ord-detail" aria-label="Detalle del pedido">
            <header>
              <h3>Pedido #{selected.id.slice(0, 8)}</h3>
              <span className={`ord-badge ord-${selected.status.toLowerCase()}`}>{statusLabel[selected.status]}</span>
            </header>
            <ul className="ord-lines">
              {selected.lines.map((line) => (
                <li key={line.id}>
                  <span>{line.name} <small>{line.sku}</small></span>
                  <span>{line.confirmedQuantity ?? line.quantity} u.</span>
                  <span className="ord-amount">{formatARS(line.confirmedPriceMinor ?? line.unitPriceMinor)}</span>
                </li>
              ))}
            </ul>
            <p className="ord-total">Total <strong>{formatARS(selected.totalConfirmedMinor ?? selected.totalRequestedMinor)}</strong></p>
            <p className="ord-meta">Revisión {selected.revision} · {new Date(selected.createdAt).toLocaleString("es-AR")}</p>
            <OrderPrimaryAction
              status={selected.status}
              role={context?.role}
              capabilities={context?.capabilities}
              busy={busy}
              onAction={primaryAction}
            />
            <div className="ord-secondary">
              {context?.capabilities.includes("orders.cancel") && !["DELIVERED", "CANCELLED"].includes(selected.status) &&
                <button className="button" disabled={busy} onClick={() => void act("cancel")}>Cancelar</button>}
              {context?.capabilities.includes("orders.reject") && selected.status === "REQUESTED" &&
                <button className="button" disabled={busy} onClick={() => void act("reject")}>Rechazar</button>}
              <button className="button" onClick={() => void showHistory()}>Historial y incidencias</button>
            </div>
            {audit.length > 0 && (
              <div className="ord-audit" aria-live="polite">
                <h4>Historial</h4>
                {audit.map((event, index) => (
                  <p key={`${event.action}-${index}`}><strong>{event.action}</strong> · {event.outcome} · {new Date(event.occurredAt).toLocaleString("es-AR")}</p>
                ))}
              </div>
            )}
          </article>
        )}
      </div>
    </section>
  );
}
