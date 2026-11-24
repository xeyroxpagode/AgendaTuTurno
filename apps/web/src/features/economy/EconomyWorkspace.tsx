"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Field, StatusPill } from "@youngkingz/ui";
import { ApiError } from "@/lib/api/client";
import { economyApi, formatARS, type AgreementVersion, type Estimate, type Settlement } from "./api";
import "./economy.css";

function monthBounds(month: string) {
  const [year, number] = month.split("-").map(Number);
  const from = new Date(Date.UTC(year!, number! - 1, 1));
  const to = new Date(Date.UTC(year!, number!, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}
const todayMonth = () => new Date().toISOString().slice(0, 7);
const pesosToMinor = (value: string) => Math.round(Number(value) * 100);

export function EconomyWorkspace({ staffMemberId, staffName }: { staffMemberId: string; staffName: string }) {
  const [versions, setVersions] = useState<AgreementVersion[]>([]);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [history, setHistory] = useState<{ settlements: Settlement[]; adjustments: Array<{ id: string; amountMinor: string; reason: string; createdAt: string }> }>({ settlements: [], adjustments: [] });
  const [month, setMonth] = useState(todayMonth());
  const [modality, setModality] = useState("COMMISSION");
  const [base, setBase] = useState("REALIZED");
  const [bps, setBps] = useState("10");
  const [fixed, setFixed] = useState("");
  const [rent, setRent] = useState("");
  const [validFrom, setValidFrom] = useState(todayMonth() + "-01");
  const [validTo, setValidTo] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [adjustSettlementId, setAdjustSettlementId] = useState("");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustKind, setAdjustKind] = useState("PAYABLE");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [items, log] = await Promise.all([economyApi.agreements(staffMemberId), economyApi.history(staffMemberId)]);
    setVersions(items); setHistory(log); setError(null);
  }, [staffMemberId]);

  useEffect(() => { void load().catch((cause) => setError(cause instanceof ApiError ? cause.message : "No se pudo cargar la economía")); }, [load]);

  async function run(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); setNotice(message); await load(); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : "No se pudo completar la operación"); }
    finally { setBusy(null); }
  }

  const needsBase = modality === "COMMISSION" || modality === "MIXED";
  const needsFixed = modality === "FIXED" || modality === "MIXED";
  const needsRent = modality === "CHAIR_RENT" || modality === "MIXED";

  return (
    <section className="content">
      <header className="page-header"><div>
        <Link href="/team" className="button ghost">← Volver a Equipo</Link>
        <h1 className="page-title">Economía · {staffName}</h1>
        <p>Configurá el acuerdo, revisá la estimación y cerrá el período. Los importes se basan en hechos reales.</p>
      </div></header>

      {error && <p role="alert" className="status-pill danger">{error}</p>}
      {notice && <p role="status" className="status-pill positive">{notice}</p>}

      <div className="panel-section">
        <h2>Acuerdo y versiones</h2>
        <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void run("agreement", async () => {
          const input: Record<string, unknown> = { staffMemberId, modality, validFrom: `${validFrom}T00:00:00.000Z`, validTo: `${validTo}T23:59:59.000Z` };
          // El usuario carga PORCENTAJE; el motor guarda PUNTOS BASE (1% = 100 bps).
          if (needsBase) { input.commissionBase = base; input.bps = Math.round(Number(bps) * 100); }
          if (needsFixed && fixed) input.fixedAmountMinor = pesosToMinor(fixed);
          if (needsRent && rent) input.rentAmountMinor = pesosToMinor(rent);
          await economyApi.createVersion(input);
          setFixed(""); setRent(""); setValidTo("");
        }, "Versión del acuerdo guardada"); }}>
          <Field label="Modalidad">
            <select value={modality} onChange={(event) => setModality(event.target.value)}>
              <option value="COMMISSION">Comisión</option>
              <option value="FIXED">Remuneración fija</option>
              <option value="CHAIR_RENT">Alquiler de silla</option>
              <option value="MIXED">Mixto</option>
            </select>
          </Field>
          {needsBase && <>
            <Field label="Base de cálculo"><select value={base} onChange={(event) => setBase(event.target.value)}><option value="REALIZED">Servicios realizados</option><option value="COLLECTED">Cobros confirmados</option></select></Field>
            <Field label="Comisión (%)"><input type="number" min={0} max={100} value={bps} onChange={(event) => setBps(event.target.value)} /></Field>
          </>}
          {needsFixed && <Field label="Importe fijo por período ($)"><input type="number" min={0} step="0.01" value={fixed} onChange={(event) => setFixed(event.target.value)} /></Field>}
          {needsRent && <Field label="Alquiler de silla por período ($)"><input type="number" min={0} step="0.01" value={rent} onChange={(event) => setRent(event.target.value)} /></Field>}
          <Field label="Vigente desde"><input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} required /></Field>
          <Field label="Vigente hasta"><input type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} required /></Field>
          <Button type="submit" disabled={busy !== null || !validTo}>Guardar versión</Button>
        </form>
        {versions.length === 0 ? <EmptyState title="Sin acuerdo configurado" detail="Las estimaciones mostrarán NOT_CONFIGURED hasta completar los términos." /> : (
          <ul className="record-list">{versions.map((version) => (
            <li key={version.id} className="record-row"><div>
              <strong>{version.modality === "COMMISSION" ? "Comisión" : version.modality === "FIXED" ? "Fijo" : version.modality === "CHAIR_RENT" ? "Alquiler de silla" : "Mixto"}</strong>
              <StatusPill tone={version.status === "ACTIVE" ? "positive" : "neutral"}>{version.status === "ACTIVE" ? "Vigente" : version.status}</StatusPill>
            </div>
            <p>{new Date(version.validFrom).toLocaleDateString("es-AR")} → {new Date(version.validTo).toLocaleDateString("es-AR")}</p>
            <p>{version.commissionBase && version.bps !== null ? `${version.bps / 100}% sobre ${version.commissionBase === "REALIZED" ? "realizado" : "cobrado"}` : "Sin base de comisión"}</p>
          </li>))}</ul>
        )}
      </div>

      <div className="panel-section">
        <h2>Estimación y cierre</h2>
        <div className="form-grid">
          <Field label="Período"><input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setEstimate(null); }} /></Field>
          <Button disabled={busy !== null} onClick={() => void run("estimate", async () => {
            const bounds = monthBounds(month);
            setEstimate(await economyApi.estimate(staffMemberId, bounds.from, bounds.to));
          }, "Estimación actualizada")}>Calcular estimación</Button>
        </div>
        {estimate && <div className="estimate-panel">
          <StatusPill tone={estimate.state === "OPEN_ESTIMATE" ? "positive" : "warning"}>{estimate.state === "OPEN_ESTIMATE" ? "Estimación abierta" : "No configurado"}</StatusPill>
          {estimate.state === "NOT_CONFIGURED" ? <p>Faltan términos del acuerdo. No se muestra un importe de cero como resultado válido.</p> : <>
            <p><strong>A pagar:</strong> {formatARS(estimate.payableMinor)}</p>
            <p><strong>A cobrar (alquiler):</strong> {formatARS(estimate.receivableMinor)}</p>
            <ul className="audit-list">{estimate.lines.map((line, index) => (
              <li key={`${line.sourceId}-${index}`} className="audit-item">{line.component} · {formatARS(line.amountMinor)}</li>
            ))}</ul>
            <Field label="Confirmación para cerrar"><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="CLOSE_SETTLEMENT" /></Field>
            <Button disabled={busy !== null || confirmation !== "CLOSE_SETTLEMENT"} onClick={() => void run("close", async () => {
              const bounds = monthBounds(month);
              await economyApi.close({ staffMemberId, from: bounds.from, to: bounds.to, confirmation });
              setConfirmation(""); setEstimate(null);
            }, "Período cerrado")}>Cerrar período</Button>
          </>}
        </div>}
      </div>

      <div className="panel-section">
        <h2>Liquidaciones y pagos</h2>
        <p>Las operaciones de dinero se registran en <Link href="/cobro">Finanzas → Cobro</Link> y se reflejan acá como saldo.</p>
        {history.settlements.length === 0 ? <EmptyState title="Sin liquidaciones" detail="Cerrá un período para ver el snapshot histórico." /> : (
          <ul className="record-list">{history.settlements.map((item) => (
            <li key={item.id} className="record-row"><div>
              <strong>{new Date(item.periodStart).toLocaleDateString("es-AR")} → {new Date(item.periodEnd).toLocaleDateString("es-AR")}</strong>
              <StatusPill tone="positive">{item.status === "ADJUSTED" ? "Ajustada" : "Cerrada"}</StatusPill>
            </div>
            <p>Pagable {formatARS(item.payableMinor)} · Cobrable {formatARS(item.receivableMinor)}</p>
          </li>))}</ul>
        )}
        {history.settlements.length > 0 && <div className="estimate-panel">
          <h3>Registrar ajuste</h3>
          <div className="form-grid">
            <Field label="Liquidación">
              <select value={adjustSettlementId} onChange={(event) => setAdjustSettlementId(event.target.value)}>
                <option value="">Elegí una liquidación</option>
                {history.settlements.map((item) => <option key={item.id} value={item.id}>{new Date(item.periodStart).toLocaleDateString("es-AR")}</option>)}
              </select>
            </Field>
            <Field label="Lado">
              <select value={adjustKind} onChange={(event) => setAdjustKind(event.target.value)}>
                <option value="PAYABLE">A pagar al profesional</option>
                <option value="RECEIVABLE">A cobrar (alquiler)</option>
              </select>
            </Field>
            <Field label="Importe ($; negativo para reducir)"><input type="number" step="0.01" value={adjustAmount} onChange={(event) => setAdjustAmount(event.target.value)} /></Field>
            <Field label="Motivo"><input value={adjustReason} onChange={(event) => setAdjustReason(event.target.value)} /></Field>
            <Button disabled={busy !== null || !adjustSettlementId || !adjustAmount || adjustReason.trim().length < 3}
              onClick={() => void run("adjust", async () => {
                await economyApi.adjust({ settlementId: adjustSettlementId, amountMinor: Math.round(Number(adjustAmount) * 100), reason: adjustReason, kind: adjustKind });
                setAdjustAmount(""); setAdjustReason(""); setAdjustSettlementId("");
              }, "Ajuste registrado")}>Registrar ajuste</Button>
          </div>
        </div>}
        {history.adjustments.length > 0 && <ul className="audit-list">{history.adjustments.map((item) => (
          <li key={item.id} className="audit-item">Ajuste {formatARS(item.amountMinor)} · {item.reason}</li>
        ))}</ul>}
      </div>
    </section>
  );
}
