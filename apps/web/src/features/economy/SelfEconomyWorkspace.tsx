"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, Field, StatusPill } from "@youngkingz/ui";
import { ApiError } from "@/lib/api/client";
import { economyApi, formatARS } from "./api";
import "./economy.css";

const todayMonth = () => new Date().toISOString().slice(0, 7);
function monthBounds(month: string) {
  const [year, number] = month.split("-").map(Number);
  return {
    from: new Date(Date.UTC(year!, number! - 1, 1)).toISOString(),
    to: new Date(Date.UTC(year!, number!, 1)).toISOString()
  };
}

type Own = {
  staffMemberId: string;
  agreements: Array<Record<string, unknown>>;
  estimates: Array<Record<string, unknown>>;
  settlements: Array<Record<string, unknown>>;
  obligations: Array<{ kind: string; amountMinor: string | null; status: string; paidMinor: string }>;
  adjustments: Array<{ amountMinor: string; reason: string; createdAt: string }>;
};

/** CL-13 · Sólo la economía propia: el servidor fuerza el staffMemberId. */
export function SelfEconomyWorkspace() {
  const [month, setMonth] = useState(todayMonth());
  const [data, setData] = useState<Own | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const bounds = monthBounds(month);
    try { setData(await economyApi.self(bounds.from, bounds.to) as Own); setError(null); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : "No se pudo cargar tu economía"); }
    finally { setLoading(false); }
  }, [month]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="content">
      <header className="page-header"><div>
        <Link href="/account" className="button ghost">← Mi cuenta</Link>
        <h1 className="page-title">Mi economía</h1>
        <p>Consultá tus acuerdos, estimaciones, liquidaciones y pagos. Sólo ves tu propia información.</p>
      </div></header>

      <div className="panel-section">
        <Field label="Período"><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></Field>
      </div>
      {error && <p role="alert" className="status-pill danger">{error}</p>}
      {loading && <p>Cargando…</p>}

      {data && <>
        <div className="panel-section"><h2>Mi acuerdo</h2>
          {data.agreements.length === 0 ? <EmptyState title="Sin acuerdo vigente" detail="Consultá con la administración." /> : (
            <ul className="record-list">{data.agreements.map((item) => (
              <li key={String(item.id)} className="record-row"><p>{String(item.modality)} · {item.bps ? `${Number(item.bps) / 100}%` : "sin comisión"}</p></li>
            ))}</ul>
          )}
        </div>
        <div className="panel-section"><h2>Mis liquidaciones</h2>
          {data.settlements.length === 0 ? <EmptyState title="Sin liquidaciones" detail="Todavía no hay períodos cerrados para vos." /> : (
            <ul className="record-list">{data.settlements.map((item) => (
              <li key={String(item.id)} className="record-row"><div>
                <strong>{new Date(String(item.periodStart)).toLocaleDateString("es-AR")}</strong>
                <StatusPill tone="positive">{String(item.status)}</StatusPill>
              </div><p>{formatARS(String(item.payableMinor))}</p></li>
            ))}</ul>
          )}
        </div>
        <div className="panel-section"><h2>Pagos y saldos</h2>
          {data.obligations.length === 0 ? <p>No hay obligaciones en este período.</p> : (
            <ul className="record-list">{data.obligations.map((item, index) => (
              <li key={index} className="record-row"><p>{item.kind === "RECEIVABLE" ? "A cobrar" : "A pagar"} · {formatARS(item.amountMinor ?? "0")} · pagado {formatARS(item.paidMinor)}</p></li>
            ))}</ul>
          )}
        </div>
        {data.adjustments.length > 0 && <div className="panel-section"><h2>Ajustes</h2>
          <ul className="audit-list">{data.adjustments.map((item, index) => (
            <li key={index} className="audit-item">{formatARS(item.amountMinor)} · {item.reason}</li>
          ))}</ul>
        </div>}
      </>}
    </section>
  );
}
