"use client";

import "./orders.css";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatARS, ordersApi, type PublicProduct } from "./api";

/**
 * T061 + T062 + T063 · Recorrido Cliente/Guest.
 * Catálogo público sin stock/ubicación/costo; cartera de borrador en
 * sessionStorage (cero filas en servidor hasta el envío) y seguimiento
 * privado por credencial de recurso (nunca en URL ni logs).
 */
type DraftLine = { sku: string; name: string; priceMinor: number; quantity: number };

function useBusinessId(): string {
  const [businessId, setBusinessId] = useState("");
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("businessId");
    if (id) setBusinessId(id);
  }, []);
  return businessId;
}

export function ProductCatalog() {
  const businessId = useBusinessId();
  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [draft, setDraft] = useState<DraftLine[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [credential, setCredential] = useState<{ token: string; orderId: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const storageKey = `ykz-h06-draft:${businessId}`;
  useEffect(() => {
    if (!businessId) return;
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) setDraft(JSON.parse(saved) as DraftLine[]);
    } catch { sessionStorage.removeItem(storageKey); }
  }, [businessId, storageKey]);

  const load = useCallback(async () => {
    if (!businessId) return;
    setState("loading");
    try {
      const result = await ordersApi.publicCatalog(businessId);
      setProducts(result.data.items);
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No pudimos cargar el catálogo.");
      setState("error");
    }
  }, [businessId]);

  useEffect(() => { void load(); }, [load]);

  function add(product: PublicProduct) {
    setDraft((old) => {
      const existing = old.find((line) => line.sku === product.sku);
      const next = existing
        ? old.map((line) => line.sku === product.sku ? { ...line, quantity: line.quantity + 1 } : line)
        : [...old, { sku: product.sku, name: product.name, priceMinor: product.priceMinor, quantity: 1 }];
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }

  function remove(sku: string) {
    setDraft((old) => {
      const next = old.filter((line) => line.sku !== sku);
      sessionStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }

  async function submit() {
    if (!businessId || !draft.length) return;
    setBusy(true);
    setError("");
    try {
      const result = await ordersApi.requestGuest({
        businessId,
        lines: draft.map((line) => ({ sku: line.sku, quantity: line.quantity })),
        contact: { name: "Cliente" }
      });
      const token = result.data.credential?.token;
      if (token) {
        sessionStorage.setItem(`ykz-h06-credential:${result.data.id}`, token);
        setCredential({ token, orderId: result.data.id });
      }
      setDraft([]);
      sessionStorage.removeItem(storageKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo enviar la solicitud.");
    } finally { setBusy(false); }
  }

  return (
    <section className="ord-workspace" aria-label="Catálogo de productos">
      <header className="ord-header"><h2>Productos para retiro</h2></header>
      {!businessId && <p className="ord-banner" role="alert">Indicá un negocio con el parámetro <code>?businessId=…</code>.</p>}
      {error && <div className="ord-banner" role="alert">{error}</div>}
      <p role="status" aria-live="polite">
        {state === "loading" ? "Cargando catálogo…" : state === "error" ? "No se pudo cargar el catálogo." : `${products.length} producto(s) disponible(s)`}
      </p>
      {credential && (
        <div className="ord-banner ord-ok" role="status">
          <p>Solicitud <strong>#{credential.orderId.slice(0, 8)}</strong> enviada. Guardá tu credencial:</p>
          <code>{credential.token.slice(0, 6)}••••••••</code>
          <p><Link href={`/pedidos/${credential.orderId}?businessId=${businessId}`}>Seguir mi pedido</Link></p>
        </div>
      )}
      <div className="ord-grid">
        <div className="ord-list" role="list">
          {products.map((product) => (
            <div key={product.sku} className="ord-row" role="listitem">
              <strong><Link href={`/productos/${product.sku}?businessId=${businessId}`}>{product.name}</Link></strong>
              <small>{product.category}</small>
              <span className="ord-amount">{formatARS(product.priceMinor)}</span>
              <button className="button primary" onClick={() => add(product)}>Agregar</button>
            </div>
          ))}
          {state === "ready" && !products.length && <p className="ord-muted" role="status">No hay productos publicados.</p>}
        </div>
        <aside className="ord-detail" aria-label="Solicitud en borrador">
          <h3>Tu solicitud</h3>
          {draft.length ? (
            <>
              <ul className="ord-lines">
                {draft.map((line) => (
                  <li key={line.sku}>
                    <span>{line.name}<small>{line.sku}</small></span>
                    <span>{line.quantity} u.</span>
                    <span className="ord-amount">{formatARS(line.priceMinor * line.quantity)}</span>
                    <button className="button" onClick={() => remove(line.sku)} aria-label={`Quitar ${line.name}`}>×</button>
                  </li>
                ))}
              </ul>
              <p className="ord-total">Total <strong>{formatARS(draft.reduce((sum, line) => sum + line.priceMinor * line.quantity, 0))}</strong></p>
              <button className="button primary" disabled={busy} onClick={() => void submit()}>Enviar solicitud</button>
            </>
          ) : <p className="ord-muted">Elegí productos para armar tu solicitud. Nada se guarda hasta enviarla.</p>}
        </aside>
      </div>
    </section>
  );
}

export function ProductDetail({ sku }: { sku: string }) {
  const businessId = useBusinessId();
  const [product, setProduct] = useState<PublicProduct | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!businessId) return;
    void ordersApi.publicProduct(businessId, sku).then((result) => setProduct(result.data)).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Producto no disponible.");
    });
  }, [businessId, sku]);
  return (
    <section className="ord-workspace" aria-label="Detalle de producto">
      <p><Link href={`/productos?businessId=${businessId}`}>← Volver al catálogo</Link></p>
      {error && <div className="ord-banner" role="alert">{error}</div>}
      {product && (
        <article className="ord-detail">
          <h2>{product.name}</h2>
          <p>{product.description}</p>
          <p className="ord-amount">{formatARS(product.priceMinor)} · {product.currency}</p>
          {product.variants.length > 0 && <ul>{product.variants.map((variant) => (
            <li key={variant.sku}>{variant.name} · {formatARS(variant.priceMinor)}</li>
          ))}</ul>}
          <small>El catálogo no informa stock exacto ni ubicación.</small>
        </article>
      )}
    </section>
  );
}

export function GuestOrderTracking({ orderId }: { orderId: string }) {
  const businessId = useBusinessId();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [view, setView] = useState<{ status: string; lines: unknown[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const token = sessionStorage.getItem(`ykz-h06-credential:${orderId}`);
    if (!businessId || !token) { setError("No hay una credencial válida para este pedido."); setState("error"); return; }
    void ordersApi.trackGuest(businessId, orderId, token).then((result) => {
      setView(result.data); setState("ready");
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "No pudimos consultar el pedido.");
      setState("error");
    });
  }, [businessId, orderId]);
  return (
    <section className="ord-workspace" aria-label="Seguimiento de pedido">
      <h2>Seguimiento de pedido</h2>
      <p role="status" aria-live="polite">{state === "loading" ? "Consultando…" : ""}</p>
      {error && <div className="ord-banner" role="alert">{error}</div>}
      {view && (
        <article className="ord-detail">
          <h3>Estado: {view.status}</h3>
          <p>{view.lines.length} línea(s) en la solicitud.</p>
          <small>El estado de operación (por ejemplo UNKNOWN) se consulta por operationId y no altera el estado comercial.</small>
        </article>
      )}
    </section>
  );
}
