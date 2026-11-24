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
  const [base, setBase] = useState("");
  const [bps, setBps] = useState("");
  const [fixed, setFixed] = useState("");
  const [rent, setRent] = useState("");
  const [periodUnit, setPeriodUnit] = useState("");
  const [periodInterval, setPeriodInterval] = useState("");
  const [periodAnchor, setPeriodAnchor] = useState("");
  const [customPeriod, setCustomPeriod] = useState(false);
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
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
  const includesPeriodicAmount = (needsFixed && fixed !== "") || (needsRent && rent !== "");
  const periodAvailable = customPeriod ? Boolean(periodFrom && periodTo && periodTo > periodFrom) : Boolean(month);
  const bounds = () => customPeriod
    ? { from: `${periodFrom}T00:00:00.000Z`, to: `${periodTo}T00:00:00.000Z` }
    : monthBounds(month);

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
          const end = new Date(`${validTo}T00:00:00.000Z`);
          end.setUTCDate(end.getUTCDate() + 1);
          const input: Record<string, unknown> = { staffMemberId, modality, validFrom: `${validFrom}T00:00:00.000Z`, validTo: end.toISOString() };
          // El usuario carga PORCENTAJE; el motor guarda PUNTOS BASE (1% = 100 bps).
          if (needsBase && (base || bps !== "")) {
            if (base) input.commissionBase = base;
            if (bps !== "") input.bps = Math.round(Number(bps) * 100);
          }
          if (needsFixed && fixed) input.fixedAmountMinor = pesosToMinor(fixed);
          if (needsRent && rent) input.rentAmountMinor = pesosToMinor(rent);
          if (includesPeriodicAmount) input.periodCadence = { unit: periodUnit, interval: Number(periodInterval), anchorDate: periodAnchor };
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
            <Field label="Base de cálculo"><select value={base} onChange={(event) => setBase(event.target.value)}><option value="">Seleccioná una base</option><option value="REALIZED">Servicios realizados</option><option value="COLLECTED">Cobros confirmados</option></select></Field>
            <Field label="Comisión (%)"><input type="number" min={0} max={100} step="0.01" value={bps} onChange={(event) => setBps(event.target.value)} /></Field>
          </>}
          {needsFixed && <Field label="Importe fijo por período ($)"><input type="number" min={0} step="0.01" value={fixed} onChange={(event) => setFixed(event.target.value)} /></Field>}
          {needsRent && <Field label="Alquiler de silla por período ($)"><input type="number" min={0} step="0.01" value={rent} onChange={(event) => setRent(event.target.value)} /></Field>}
          {includesPeriodicAmount && <>
            <Field label="Unidad del período">
              <select value={periodUnit} onChange={(event) => setPeriodUnit(event.target.value)} required>
                <option value="">Elegí una unidad</option><option value="DAYS">Días</option><option value="MONTHS">Meses calendario</option>
              </select>
            </Field>
            <Field label="Cantidad por período"><input type="number" min={1} max={365} value={periodInterval} onChange={(event) => setPeriodInterval(event.target.value)} required /></Field>
            <Field label="Fecha de inicio del ciclo"><input type="date" value={periodAnchor} onChange={(event) => setPeriodAnchor(event.target.value)} required /></Field>
          </>}
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
          <label className="check-row"><input type="checkbox" checked={customPeriod} onChange={(event) => { setCustomPeriod(event.target.checked); setEstimate(null); }} /> Elegir fechas del período</label>
          {customPeriod ? <>
            <Field label="Inicio del período"><input type="date" value={periodFrom} onChange={(event) => { setPeriodFrom(event.target.value); setEstimate(null); }} /></Field>
            <Field label="Fin del período (excluido)"><input type="date" value={periodTo} onChange={(event) => { setPeriodTo(event.target.value); setEstimate(null); }} /></Field>
          </> : <Field label="Período"><input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setEstimate(null); }} /></Field>}
          <Button disabled={busy !== null || !periodAvailable} onClick={() => void run("estimate", async () => {
            const period = bounds();
            setEstimate(await economyApi.estimate(staffMemberId, period.from, period.to));
          }, "Estimación actualizada")}>Calcular estimación</Button>
        </div>
        {estimate && <div className="estimate-panel">
          <StatusPill tone={estimate.state === "OPEN_ESTIMATE" ? "positive" : "warning"}>{estimate.state === "OPEN_ESTIMATE" ? "Estimación abierta" : "No configurado"}</StatusPill>
          {estimate.state === "NOT_CONFIGURED" ? <p>Revisá la vigencia, la periodicidad y los importes del acuerdo para el período elegido.</p> : <>
            <p><strong>A pagar:</strong> {formatARS(estimate.payableMinor)}</p>
            <p><strong>A cobrar (alquiler):</strong> {formatARS(estimate.receivableMinor)}</p>
            <ul className="audit-list">{estimate.lines.map((line, index) => (
              <li key={`${line.sourceId}-${index}`} className="audit-item">{line.component} · {formatARS(line.amountMinor)}</li>
            ))}</ul>
            <Field label="Confirmación para cerrar"><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="CLOSE_SETTLEMENT" /></Field>
            <Button disabled={busy !== null || confirmation !== "CLOSE_SETTLEMENT"} onClick={() => void run("close", async () => {
              const period = bounds();
              await economyApi.close({ staffMemberId, from: period.from, to: period.to, confirmation, expectedFingerprint: estimate.sourceFingerprint });
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
            {item.snapshot && <details>
              <summary>Ver cálculo al cierre</summary>
              <p>Versiones del acuerdo: {item.snapshot.terms?.versions?.length ?? (item.snapshot.terms?.agreementVersionId ? 1 : 0)}</p>
              <ul className="audit-list">{(item.snapshot.sources ?? []).map((line) => (
                <li key={`${line.sourceType}-${line.sourceId}`}>{line.component} · {formatARS(line.amountMinor)}
                  {line.basis && ` · base ${formatARS(line.basis.baseMinor)}`}
                </li>
              ))}</ul>
            </details>}
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
