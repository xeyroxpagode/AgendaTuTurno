"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import {
  financeApi, formatARS, releaseOperationId, stableOperationId,
  type AttemptView, type CashSnapshot, type CheckoutView, type CorrectionView,
  type MoneyView, type ObligationView, type SaleView
} from "./api";
import "./finance.css";

/**
 * H05 · Superficie operativa Owner/Receptionist.
 *
 * Reglas de UX congeladas aplicadas:
 *  · NUNCA se muestra éxito antes de la confirmación real del servidor.
 *  · El `operation_id` es estable y se conserva en reintentos y recargas.
 *  · UNKNOWN se muestra de forma inequívoca (S33) y se consulta por id sin
 *    disparar un segundo cobro.
 *  · Los importes y saldos son derivados de hechos reales del servidor.
 *  · Las acciones se ocultan si el Actor no tiene la capability efectiva.
 */
export type FinanceView = "CAJA" | "VENTAS" | "COBRO" | "OBLIGACIONES" | "CORRECCIONES" | "S33";

type Context = { role: string; capabilities: string[] };
type Status = { kind: "idle" | "loading" | "success" | "error" | "unknown"; message: string; operationId?: string };

const VIEW_LABEL: Record<FinanceView, string> = {
  CAJA: "Caja", VENTAS: "Ventas", COBRO: "Cobro y checkout",
  OBLIGACIONES: "Obligaciones", CORRECCIONES: "Correcciones", S33: "Cobro incierto"
};

export function FinanceWorkspace({ initialView = "CAJA" }: { initialView?: FinanceView }) {
  const [view, setView] = useState<FinanceView>(initialView);
  const [context, setContext] = useState<Context | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });
  const [dirty, setDirty] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const can = useCallback((capability: string) => Boolean(context?.capabilities.includes(capability)), [context]);

  useEffect(() => {
    api<Context>("/v1/iam/context").then(setContext).catch(() => setContext(null));
  }, []);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const changeView = (next: FinanceView) => {
    if (dirty && !window.confirm("Tenés cambios sin guardar. ¿Querés salir de esta pantalla?")) return;
    setDirty(false);
    setStatus({ kind: "idle", message: "" });
    setView(next);
  };

  function reportSuccess(message: string, operationId?: string) {
    if (operationId) releaseOperationId(operationId);
    setDirty(false);
    setStatus({ kind: "success", message, operationId });
    setReloadToken((token) => token + 1);
  }

  function reportError(error: unknown, operationId?: string) {
    if (error instanceof ApiError && error.code === "EXTERNAL_OUTCOME_UNKNOWN") {
      setStatus({ kind: "unknown", message: "Resultado desconocido: consultá el intento original antes de reintentar.", operationId });
      return;
    }
    const code = error instanceof ApiError ? error.code : "ERROR";
    const message = error instanceof Error ? error.message : "No se pudo completar la operación";
    setStatus({ kind: "error", message: `[${code}] ${message}`, operationId });
  }

  const nav = (Object.keys(VIEW_LABEL) as FinanceView[]).filter((item) => {
    if (item === "CAJA") return can("cash.open") || can("cash.close");
    if (item === "VENTAS") return can("sales.create");
    if (item === "COBRO") return can("checkout.create") || can("money.create");
    if (item === "OBLIGACIONES") return can("obligations.manage");
    if (item === "CORRECCIONES") return can("corrections.create") || can("money.refund");
    return true; // S33 siempre accesible para consultar el intento original
  });

  return (
    <div className="finance" data-testid="finance-workspace">
      <header className="finance-header">
        <div><h1>Finanzas</h1><p>Ventas, dinero, caja y obligaciones sobre hechos reales.</p></div>
        <span className="finance-role" data-testid="finance-role">{context?.role ?? "Verificando…"}</span>
      </header>

      <nav className="finance-tabs" aria-label="Secciones financieras">
        {nav.map((item) => (
          <button key={item} type="button" className={view === item ? "active" : ""}
            aria-current={view === item ? "page" : undefined} onClick={() => changeView(item)}>
            {VIEW_LABEL[item]}
          </button>
        ))}
      </nav>

      <div className={`finance-status ${status.kind}`} role="status" aria-live="polite" data-testid="finance-status">
        {status.kind !== "idle" && <span>{status.message}</span>}
        {status.operationId && status.kind === "unknown" && (
          <button type="button" onClick={() => { setView("S33"); window.sessionStorage.setItem("yk-h05-last-attempt", status.operationId!); }}>
            Consultar intento original
          </button>
        )}
      </div>

      {view === "CAJA" && <CashPanel can={can} onChange={reportSuccess} onError={reportError} dirty={setDirty} token={reloadToken} />}
      {view === "VENTAS" && <SalesPanel can={can} onChange={reportSuccess} onError={reportError} dirty={setDirty} token={reloadToken} />}
      {view === "COBRO" && <CheckoutPanel can={can} onChange={reportSuccess} onError={reportError} onUnknown={(id) => setStatus({ kind: "unknown", message: "Resultado desconocido: conservá el número de intento.", operationId: id })} dirty={setDirty} token={reloadToken} />}
      {view === "OBLIGACIONES" && <ObligationsPanel can={can} onChange={reportSuccess} onError={reportError} dirty={setDirty} token={reloadToken} />}
      {view === "CORRECCIONES" && <CorrectionsPanel can={can} onChange={reportSuccess} onError={reportError} dirty={setDirty} token={reloadToken} />}
      {view === "S33" && <UnknownPanel can={can} onError={reportError} />}
    </div>
  );
}

type PanelProps = {
  can: (capability: string) => boolean;
  onChange: (message: string, operationId?: string) => void;
  onError: (error: unknown, operationId?: string) => void;
  dirty: (value: boolean) => void;
  token: number;
};

/* ─────────────────────────────── CAJA ─────────────────────────────── */

function CashPanel({ can, onChange, onError, dirty, token }: PanelProps) {
  const [sessions, setSessions] = useState<Array<CashSnapshot & { cashboxName: string; currentExpectedMinor: number }>>([]);
  const [fund, setFund] = useState("10000");
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");

  const load = useCallback(() => {
    financeApi.cashSessions().then(setSessions).catch(() => setSessions([]));
  }, []);
  useEffect(() => { load(); }, [load, token]);

  const openSession = async () => {
    const operationId = stableOperationId("cash-open");
    try {
      const result = await financeApi.openCash({ openingAmountMinor: Number(fund) }, operationId);
      onChange(result.replayed ? "Sesión de caja ya abierta (replay)." : "Caja abierta y confirmada.", operationId);
      load();
    } catch (error) { onError(error, operationId); }
  };

  const closeSession = async (session: CashSnapshot) => {
    const operationId = stableOperationId(`cash-close-${session.cashSessionId}`);
    try {
      const result = await financeApi.closeCash(session.cashSessionId, {
        countedAmountMinor: Number(counted), expectedRevision: session.revision, reason: reason || undefined
      }, operationId);
      onChange(`Caja cerrada. Diferencia: ${formatARS(result.data.differenceMinor)}`, operationId);
      setCounted(""); setReason(""); load();
    } catch (error) { onError(error, operationId); }
  };

  const addMovement = async (session: CashSnapshot) => {
    const operationId = stableOperationId(`cash-movement-${session.cashSessionId}-${amount}-${movementReason}`);
    try {
      await financeApi.cashMovement({ cashSessionId: session.cashSessionId, type: "INCOME", amountMinor: Number(amount), reason: movementReason }, operationId);
      onChange("Movimiento de efectivo confirmado.", operationId);
      setAmount(""); setMovementReason(""); load();
    } catch (error) { onError(error, operationId); }
  };

  return (
    <section className="finance-panel" data-testid="cash-panel">
      <h2>Sesión de caja</h2>
      {can("cash.open") && <div className="finance-form">
        <label>Fondo inicial (ARS) <input inputMode="numeric" value={fund} onChange={(event) => { setFund(event.target.value); dirty(true); }} /></label>
        <button type="button" onClick={openSession}>Abrir caja</button>
      </div>}
      <div className="finance-list">
        {sessions.length === 0 && <p className="finance-empty">Todavía no hay sesiones de caja.</p>}
        {sessions.map((session) => (
          <article key={session.cashSessionId} className="finance-card" data-testid="cash-session">
            <header><strong>{session.cashboxName}</strong><span className={`pill ${session.status.toLowerCase()}`}>{session.status}</span></header>
            <dl>
              <div><dt>Fondo</dt><dd>{formatARS(session.openingAmountMinor)}</dd></div>
              <div><dt>Esperado</dt><dd>{formatARS(session.currentExpectedMinor)}</dd></div>
              <div><dt>Conteo</dt><dd>{formatARS(session.countedAmountMinor)}</dd></div>
              <div><dt>Diferencia</dt><dd>{formatARS(session.differenceMinor)}</dd></div>
            </dl>
            {session.status === "OPEN" && (
              <div className="finance-form">
                <label>Conteo <input inputMode="numeric" value={counted} onChange={(event) => { setCounted(event.target.value); dirty(true); }} /></label>
                <label>Motivo <input value={reason} onChange={(event) => { setReason(event.target.value); dirty(true); }} /></label>
                {can("cash.close") && <button type="button" onClick={() => closeSession(session)}>Cerrar caja</button>}
                {can("cash.movement.create") && <>
                  <label>Ingreso <input inputMode="numeric" value={amount} onChange={(event) => { setAmount(event.target.value); dirty(true); }} /></label>
                  <label>Concepto <input value={movementReason} onChange={(event) => { setMovementReason(event.target.value); dirty(true); }} /></label>
                  <button type="button" onClick={() => addMovement(session)}>Registrar efectivo</button>
                </>}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────────── VENTAS ───────────────────────────── */

function SalesPanel({ can, onChange, onError, dirty, token }: PanelProps) {
  const [sales, setSales] = useState<Array<SaleView & { settledMinor: number }>>([]);
  const [inventory, setInventory] = useState<{ items: Array<{ sku: string; name: string; priceMinor: number | null; sellable: number }>; locations: Array<{ id: string; name: string }> }>({ items: [], locations: [] });
  const [sku, setSku] = useState("");
  const [locationId, setLocationId] = useState("");
  const [quantity, setQuantity] = useState("1");

  const load = useCallback(() => {
    financeApi.sales().then(setSales).catch(() => setSales([]));
    financeApi.inventory().then((snapshot) => {
      setInventory(snapshot);
      setSku((current) => current || snapshot.items[0]?.sku || "");
      setLocationId((current) => current || snapshot.locations[0]?.id || "");
    }).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load, token]);

  const create = async () => {
    const item = inventory.items.find((entry) => entry.sku === sku);
    if (!item || item.priceMinor === null) { onError(new Error("Elegí un artículo con precio vigente.")); return; }
    const operationId = stableOperationId(`sale-${sku}-${quantity}-${locationId}`);
    try {
      const result = await financeApi.createSale({
        lines: [{ kind: "PRODUCT", sku, locationId, name: item.name, quantity: Number(quantity), unitPriceMinor: item.priceMinor, discountMinor: 0 }]
      }, operationId);
      onChange(result.replayed ? "Venta ya registrada (replay)." : "Venta creada en borrador.", operationId);
      load();
    } catch (error) { onError(error, operationId); }
  };

  const confirm = async (sale: SaleView) => {
    const operationId = stableOperationId(`sale-confirm-${sale.id}`);
    try {
      await financeApi.confirmSale(sale.id, { expectedRevision: sale.revision, acceptPriceChanges: false }, operationId);
      onChange("Venta confirmada.", operationId); load();
    } catch (error) { onError(error, operationId); }
  };

  const cancel = async (sale: SaleView) => {
    const reason = window.prompt("Motivo de la anulación (obligatorio):");
    if (!reason) return;
    const operationId = stableOperationId(`sale-cancel-${sale.id}`);
    try {
      await financeApi.cancelSale(sale.id, { reason, expectedRevision: sale.revision }, operationId);
      onChange("Venta anulada con motivo.", operationId); load();
    } catch (error) { onError(error, operationId); }
  };

  return (
    <section className="finance-panel" data-testid="sales-panel">
      <h2>Ventas</h2>
      {can("sales.create") && <div className="finance-form">
        <label>Artículo <select value={sku} onChange={(event) => { setSku(event.target.value); dirty(true); }}>
          {inventory.items.length === 0 && <option value="">Sin artículos disponibles</option>}
          {inventory.items.map((item) => <option key={item.sku} value={item.sku}>{item.name} · {formatARS(item.priceMinor)} · {item.sellable} u.</option>)}
        </select></label>
        <label>Ubicación <select value={locationId} onChange={(event) => { setLocationId(event.target.value); dirty(true); }}>
          {inventory.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
        </select></label>
        <label>Cantidad <input inputMode="numeric" value={quantity} onChange={(event) => { setQuantity(event.target.value); dirty(true); }} /></label>
        <button type="button" onClick={create}>Crear venta</button>
      </div>}
      <div className="finance-list">
        {sales.length === 0 && <p className="finance-empty">Todavía no hay ventas.</p>}
        {sales.map((sale) => (
          <article key={sale.id} className="finance-card" data-testid="sale-card">
            <header><strong>{sale.lines.map((line) => line.name).join(" + ") || "Venta"}</strong><span className={`pill ${sale.balance.toLowerCase()}`}>{sale.balance}</span></header>
            <dl>
              <div><dt>Total</dt><dd>{formatARS(sale.totalMinor)}</dd></div>
              <div><dt>Cobrado</dt><dd>{formatARS(sale.settledMinor)}</dd></div>
              <div><dt>Origen</dt><dd>{sale.source}</dd></div>
            </dl>
            <div className="finance-actions">
              {sale.status === "DRAFT" && can("sales.confirm") && <button type="button" onClick={() => confirm(sale)}>Confirmar</button>}
              {sale.status !== "CANCELLED" && can("sales.cancel") && <button type="button" className="danger" onClick={() => cancel(sale)}>Anular</button>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ────────────────────────── COBRO / CHECKOUT ───────────────────────── */

function CheckoutPanel({ can, onChange, onError, onUnknown, dirty, token }: PanelProps & { onUnknown: (id: string) => void }) {
  const [sales, setSales] = useState<SaleView[]>([]);
  const [checkouts, setCheckouts] = useState<CheckoutView[]>([]);
  const [cashSessions, setCashSessions] = useState<Array<{ cashSessionId: string; cashboxName: string; status: string }>>([]);
  const [saleId, setSaleId] = useState("");
  const [cashSessionId, setCashSessionId] = useState("");
  const [cashAmount, setCashAmount] = useState("");
  const [cardAmount, setCardAmount] = useState("");
  const [cardOutcome, setCardOutcome] = useState<"CONFIRMED" | "UNKNOWN">("CONFIRMED");
  const [deliver, setDeliver] = useState(true);

  const load = useCallback(() => {
    financeApi.sales().then((items) => { setSales(items); setSaleId((current) => current || items[0]?.id || ""); }).catch(() => undefined);
    financeApi.checkouts().then(setCheckouts).catch(() => undefined);
    financeApi.cashSessions().then((items) => {
      setCashSessions(items);
      setCashSessionId((current) => current || items.find((session) => session.status === "OPEN")?.cashSessionId || "");
    }).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load, token]);

  const checkout = async () => {
    const components: Array<Record<string, unknown>> = [];
    if (Number(cashAmount) > 0) components.push({ method: "CASH", amountMinor: Number(cashAmount), changeMinor: 0 });
    if (Number(cardAmount) > 0) components.push({ method: "CARD", amountMinor: Number(cardAmount), outcome: cardOutcome });
    if (components.length === 0) { onError(new Error("Ingresá un importe en efectivo o tarjeta.")); return; }
    const operationId = stableOperationId(`checkout-${saleId}-${cashAmount}-${cardAmount}-${cardOutcome}`);
    try {
      const result = await financeApi.checkout({
        saleId, components, cashSessionId: cashSessionId || undefined, deliver
      }, operationId);
      if (result.data.status === "UNKNOWN") { onUnknown(operationId); return; }
      onChange(`Checkout ${result.data.status.toLowerCase()} y verificado.`, operationId);
      load();
    } catch (error) { onError(error, operationId); }
  };

  const resume = async (checkout: CheckoutView) => {
    const operationId = stableOperationId(`checkout-resume-${checkout.id}`);
    try {
      const result = await financeApi.resumeCheckout(checkout.id, {
        resolution: "DELIVER", reason: "Entrega reintentada desde la superficie operativa", expectedRevision: checkout.revision
      }, operationId);
      onChange(`Checkout ${result.data.status.toLowerCase()}.`, operationId); load();
    } catch (error) { onError(error, operationId); }
  };

  return (
    <section className="finance-panel" data-testid="checkout-panel">
      <h2>Cobro y checkout</h2>
      {can("checkout.create") && <div className="finance-form">
        <label>Venta <select value={saleId} onChange={(event) => { setSaleId(event.target.value); dirty(true); }}>
          {sales.length === 0 && <option value="">Sin ventas</option>}
          {sales.map((sale) => <option key={sale.id} value={sale.id}>{sale.id.slice(0, 8)} · {formatARS(sale.totalMinor)} · {sale.balance}</option>)}
        </select></label>
        <label>Efectivo <input inputMode="numeric" value={cashAmount} onChange={(event) => { setCashAmount(event.target.value); dirty(true); }} /></label>
        <label>Caja <select value={cashSessionId} onChange={(event) => { setCashSessionId(event.target.value); dirty(true); }}>
          <option value="">Sin caja (sólo medios externos)</option>
          {cashSessions.filter((session) => session.status === "OPEN").map((session) => <option key={session.cashSessionId} value={session.cashSessionId}>{session.cashboxName}</option>)}
        </select></label>
        <label>Tarjeta <input inputMode="numeric" value={cardAmount} onChange={(event) => { setCardAmount(event.target.value); dirty(true); }} /></label>
        <label>Resultado tarjeta <select value={cardOutcome} onChange={(event) => { setCardOutcome(event.target.value as "CONFIRMED" | "UNKNOWN"); dirty(true); }}>
          <option value="CONFIRMED">Confirmada</option><option value="UNKNOWN">Desconocido</option>
        </select></label>
        <label className="check"><input type="checkbox" checked={deliver} onChange={(event) => { setDeliver(event.target.checked); dirty(true); }} /> Entregar stock ahora</label>
        <button type="button" onClick={checkout}>Ejecutar checkout</button>
      </div>}
      <div className="finance-list">
        {checkouts.length === 0 && <p className="finance-empty">Todavía no hay checkouts.</p>}
        {checkouts.map((checkout) => (
          <article key={checkout.id} className="finance-card" data-testid="checkout-card">
            <header><strong>{checkout.id.slice(0, 8)}</strong><span className={`pill ${checkout.status.toLowerCase()}`}>{checkout.status}</span></header>
            <dl>
              <div><dt>Total</dt><dd>{formatARS(checkout.totalMinor)}</dd></div>
              <div><dt>Confirmado</dt><dd>{formatARS(checkout.confirmedMinor)}</dd></div>
              <div><dt>Saldo</dt><dd>{checkout.balance}</dd></div>
            </dl>
            {checkout.incidentReason && <p className="incident" role="alert">Incidencia: {checkout.incidentReason}</p>}
            {(checkout.status === "DELIVERY_PENDING" || checkout.status === "MONEY_CONFIRMED") && can("checkout.resume") && (
              <button type="button" onClick={() => resume(checkout)}>Reintentar entrega</button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

/* ────────────────────────── OBLIGACIONES ───────────────────────────── */

function ObligationsPanel({ can, onChange, onError, dirty, token }: PanelProps) {
  const [obligations, setObligations] = useState<ObligationView[]>([]);
  const [money, setMoney] = useState<MoneyView[]>([]);
  const [title, setTitle] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [amount, setAmount] = useState("");
  const [payTarget, setPayTarget] = useState("");
  const [payMoney, setPayMoney] = useState("");

  const load = useCallback(() => {
    financeApi.obligations().then(setObligations).catch(() => setObligations([]));
    financeApi.moneyOperations().then((items) => { setMoney(items.filter((item) => item.status === "SUCCEEDED" && item.availableMinor > 0)); }).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load, token]);

  const create = async () => {
    const operationId = stableOperationId(`obligation-${title}-${counterparty}-${amount}`);
    try {
      await financeApi.createObligation({
        kind: "PAYABLE", title, counterpartyName: counterparty,
        ...(amount ? { amountMinor: Number(amount) } : {})
      }, operationId);
      onChange(amount ? "Obligación registrada." : "Obligación registrada con importe desconocido (no es cero).", operationId);
      setTitle(""); setCounterparty(""); setAmount(""); load();
    } catch (error) { onError(error, operationId); }
  };

  const pay = async (obligation: ObligationView) => {
    const operationId = stableOperationId(`obligation-pay-${obligation.id}-${payMoney}`);
    try {
      const source = money.find((item) => item.id === payMoney);
      if (!source) throw new Error("Elegí una operación de dinero confirmado.");
      const payable = obligation.balanceMinor ?? source.availableMinor;
      await financeApi.payObligation(obligation.id, { moneyOperationId: payMoney, amountMinor: Math.min(payable, source.availableMinor) }, operationId);
      onChange("Pago aplicado sobre dinero ya confirmado.", operationId); load();
    } catch (error) { onError(error, operationId); }
  };

  return (
    <section className="finance-panel" data-testid="obligations-panel">
      <h2>Obligaciones</h2>
      {can("obligations.manage") && <div className="finance-form">
        <label>Concepto <input value={title} onChange={(event) => { setTitle(event.target.value); dirty(true); }} /></label>
        <label>Contraparte <input value={counterparty} onChange={(event) => { setCounterparty(event.target.value); dirty(true); }} /></label>
        <label>Importe (vacío = desconocido) <input inputMode="numeric" value={amount} onChange={(event) => { setAmount(event.target.value); dirty(true); }} /></label>
        <button type="button" onClick={create}>Registrar obligación</button>
      </div>}
      <div className="finance-list">
        {obligations.length === 0 && <p className="finance-empty">Todavía no hay obligaciones.</p>}
        {obligations.map((obligation) => (
          <article key={obligation.id} className="finance-card" data-testid="obligation-card">
            <header><strong>{obligation.title}</strong><span className={`pill ${obligation.status.toLowerCase()}`}>{obligation.status}</span></header>
            <dl>
              <div><dt>Contraparte</dt><dd>{obligation.counterpartyName}</dd></div>
              <div><dt>Importe</dt><dd>{obligation.amountState === "UNKNOWN_AMOUNT" ? "Desconocido (≠ 0)" : formatARS(obligation.amountMinor)}</dd></div>
              <div><dt>Saldo</dt><dd>{obligation.balanceMinor === null ? "Desconocido" : formatARS(obligation.balanceMinor)}</dd></div>
            </dl>
            {can("obligations.pay") && obligation.status !== "SETTLED" && <div className="finance-form">
              <label>Dinero confirmado <select value={payTarget || payMoney} onChange={(event) => { setPayTarget(event.target.value); setPayMoney(event.target.value); dirty(true); }}>
                <option value="">Elegir operación</option>
                {money.map((item) => <option key={item.id} value={item.id}>{formatARS(item.availableMinor)} disponible</option>)}
              </select></label>
              <button type="button" onClick={() => pay(obligation)}>Aplicar pago</button>
            </div>}
          </article>
        ))}
      </div>
    </section>
  );
}

/* ─────────────────────────── CORRECCIONES ──────────────────────────── */

function CorrectionsPanel({ can, onChange, onError, dirty, token }: PanelProps) {
  const [corrections, setCorrections] = useState<CorrectionView[]>([]);
  const [money, setMoney] = useState<MoneyView[]>([]);
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(() => {
    financeApi.corrections().then(setCorrections).catch(() => setCorrections([]));
    financeApi.moneyOperations().then((items) => { setMoney(items.filter((item) => item.kind === "PAYMENT" && item.confirmedMinor - item.refundedMinor > 0)); }).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load, token]);

  const refund = async () => {
    const operationId = stableOperationId(`refund-${target}-${amount}-${reason}`);
    try {
      await financeApi.refund(target, { amountMinor: Number(amount), reason }, operationId);
      onChange("Refund registrado como operación nueva; original conservado.", operationId);
      setAmount(""); setReason(""); load();
    } catch (error) { onError(error, operationId); }
  };

  return (
    <section className="finance-panel" data-testid="corrections-panel">
      <h2>Correcciones y refunds</h2>
      {can("money.refund") && <div className="finance-form">
        <label>Cobro original <select value={target} onChange={(event) => { setTarget(event.target.value); dirty(true); }}>
          <option value="">Elegir cobro</option>
          {money.map((item) => <option key={item.id} value={item.id}>{formatARS(item.confirmedMinor - item.refundedMinor)} disponible</option>)}
        </select></label>
        <label>Importe <input inputMode="numeric" value={amount} onChange={(event) => { setAmount(event.target.value); dirty(true); }} /></label>
        <label>Motivo <input value={reason} onChange={(event) => { setReason(event.target.value); dirty(true); }} /></label>
        <button type="button" onClick={refund}>Registrar refund</button>
      </div>}
      <div className="finance-list">
        {corrections.length === 0 && <p className="finance-empty">Todavía no hay correcciones.</p>}
        {corrections.map((correction) => (
          <article key={correction.id} className="finance-card" data-testid="correction-card">
            <header><strong>{correction.type}</strong><span className={`pill ${correction.status.toLowerCase()}`}>{correction.status}</span></header>
            <p>{correction.reason}</p>
            <details><summary>Historial antes / después</summary><pre>{JSON.stringify({ before: correction.before, after: correction.after }, null, 2)}</pre></details>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ──────────────────────────── S33 UNKNOWN ──────────────────────────── */

function UnknownPanel({ can, onError }: { can: (capability: string) => boolean; onError: (error: unknown) => void }) {
  const [operationId, setOperationId] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.sessionStorage.getItem("yk-h05-last-attempt") ?? "";
  });
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [evidence, setEvidence] = useState("");
  const [verdict, setVerdict] = useState<"SUCCEEDED" | "PROVEN_FAILED">("SUCCEEDED");

  const query = async () => {
    if (!operationId) { onError(new Error("Ingresá el identificador del intento original.")); return; }
    try { setAttempt(await financeApi.operationStatus(operationId)); }
    catch (error) { onError(error); }
  };

  const resolve = async () => {
    if (!attempt) return;
    // El response_body del checkout es { data, replayed }; el de un cobro
    // directo es el snapshot de la operación de dinero.
    const body = attempt.responseBody as { id?: string; data?: { moneyOperationId?: string; id?: string } } | null;
    const moneyOperationId = body?.data?.moneyOperationId ?? body?.id ?? body?.data?.id;
    if (!moneyOperationId) { onError(new Error("El intento no expone una operación de dinero resoluble.")); return; }
    const id = stableOperationId(`resolve-${operationId}`);
    try {
      await financeApi.resolve(moneyOperationId, { outcome: verdict, evidenceReference: evidence }, id);
      releaseOperationId(id);
      window.sessionStorage.removeItem("yk-h05-last-attempt");
      await query();
    } catch (error) { onError(error); }
  };

  const semantic = useMemo(() => {
    if (!attempt) return "";
    if (attempt.status === "SUCCEEDED") return "Confirmado";
    if (attempt.status === "FAILED") return "Fallido probado";
    if (attempt.status === "UNKNOWN") return "Desconocido — revisar";
    return "Pendiente de resultado";
  }, [attempt]);

  return (
    <section className="finance-panel" data-testid="unknown-panel">
      <h2>S33 · Cobro incierto</h2>
      <p className="finance-hint">Consultá el resultado ORIGINAL por su operation_id. Esta consulta NO dispara un nuevo cobro.</p>
      <div className="finance-form">
        <label>Identificador del intento <input value={operationId} onChange={(event) => setOperationId(event.target.value)} placeholder="UUID del operation_id" /></label>
        <button type="button" onClick={query}>Consultar resultado original</button>
      </div>
      {attempt && <article className="finance-card" data-testid="attempt-card">
        <header><strong>{semantic}</strong><span className="pill">intento conservado</span></header>
        <dl>
          <div><dt>Estado durable</dt><dd>{attempt.status}</dd></div>
          <div><dt>Respuesta</dt><dd>{attempt.responseStatus ?? "—"}</dd></div>
          <div><dt>Finalizado</dt><dd>{attempt.completedAt ?? "No"}</dd></div>
        </dl>
        {attempt.status !== "SUCCEEDED" && attempt.status !== "FAILED" && (
          <p className="incident" role="alert">No se asumió fallo por tiempo de espera. La resolución requiere evidencia.</p>
        )}
        {can("operations.resolve") && attempt.status !== "SUCCEEDED" && attempt.status !== "FAILED" && (
          <div className="finance-form">
            <label>Resultado <select value={verdict} onChange={(event) => setVerdict(event.target.value as "SUCCEEDED" | "PROVEN_FAILED")}>
              <option value="SUCCEEDED">Confirmado con evidencia</option>
              <option value="PROVEN_FAILED">Fallo probado con evidencia</option>
            </select></label>
            <label>Evidencia <input value={evidence} onChange={(event) => setEvidence(event.target.value)} /></label>
            <button type="button" onClick={resolve}>Resolver intento original</button>
          </div>
        )}
      </article>}
    </section>
  );
}
