"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, EmptyState, StatusPill } from "@youngkingz/ui";
import { ApiError, api } from "@/lib/api/client";
import {
  approveAbsence, applyAbsence, getAbsence, listAbsenceConflicts, listAbsenceProfessionals,
  listAbsences, rejectAbsence, requestAbsence, syncAbsenceConflicts, withdrawAbsence,
  type AbsenceConflict, type AbsenceDetail, type AbsenceStatus, type StaffOption,
} from "./api";

/**
 * H03.U06 · CAP-03-07 · Ausencias y conflictos.
 *
 * Recorrido operativo completo:
 *   solicitar → revisar (aprobar / rechazar / retirar) → detectar conflictos →
 *   resolverlos con las operaciones de Booking → aplicar.
 *
 * El frontend NO decide la autoridad: refleja las capabilities del contexto y
 * deja que el servidor rechace lo que no corresponde (403, 409 por conflicto,
 * 409 por revisión obsoleta).
 */

const statusTone = (status: AbsenceStatus): "neutral" | "positive" | "warning" | "danger" => {
  if (status === "APPLIED") return "positive";
  if (status === "APPROVED") return "warning";
  if (status === "REJECTED" || status === "WITHDRAWN") return "danger";
  return "neutral";
};

const statusLabel = (status: AbsenceStatus): string => ({
  PENDING: "Pendiente",
  APPROVED: "Aprobada",
  APPLIED: "Aplicada",
  REJECTED: "Rechazada",
  WITHDRAWN: "Retirada"
}[status]);

const minuteToClock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const clockToMinute = (value: string) => {
  const [hour, minute] = value.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
};
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

export function AbsenceWorkspace() {
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [role, setRole] = useState("");
  const [staffMemberId, setStaffMemberId] = useState("");
  const [items, setItems] = useState<Awaited<ReturnType<typeof listAbsences>>["items"]>([]);
  const [professionals, setProfessionals] = useState<StaffOption[]>([]);
  const [statusFilter, setStatusFilter] = useState<"ALL" | AbsenceStatus>("ALL");
  const [staffFilter, setStaffFilter] = useState("");
  const [detail, setDetail] = useState<AbsenceDetail | null>(null);
  const [conflicts, setConflicts] = useState<AbsenceConflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ staffMemberId: "", localDate: "", start: "09:00", end: "13:00", reason: "" });
  const [rejectReason, setRejectReason] = useState("");

  const can = useCallback((capability: string) => capabilities.includes(capability), [capabilities]);
  const canRequest = can("absence.request");
  const canApprove = can("absence.approve");
  const canReject = can("absence.reject");
  const canWithdraw = can("absence.withdraw");
  const canApply = can("absence.apply");
  // El BARBER opera sólo sobre sus propias ausencias; el resto, sobre el Business.
  const sharedScope = role !== "BARBER";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [context, absences] = await Promise.all([
        getContext(),
        listAbsences({ status: statusFilter, staffMemberId: staffFilter || undefined }),
      ]);
      setRole(context.role);
      setCapabilities(context.capabilities);
      setStaffMemberId(context.staffMemberId);
      setItems(absences.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudieron cargar las ausencias.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, staffFilter]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    listAbsenceProfessionals().then(setProfessionals).catch(() => undefined);
  }, []);

  const open = useCallback(async (id: string) => {
    setDetailLoading(true);
    setError("");
    try {
      const [absence, affected] = await Promise.all([getAbsence(id), listAbsenceConflicts(id)]);
      setDetail(absence);
      setConflicts(affected.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo abrir la ausencia.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
      await load();
      if (detail) await open(detail.absence.id);
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : "";
      if (code === "AVAILABILITY_IMPACT_CONFLICT") setError("La ausencia pisa turnos confirmados: resolvelos antes de aplicar.");
      else if (code === "STALE_REVISION") setError("La solicitud cambió en otra sesión. Recargá el detalle.");
      else if (code === "CONFLICT") setError("La solicitud ya no admite esa operación.");
      else if (code === "FORBIDDEN") setError("No tenés autoridad sobre esta solicitud.");
      else if (code === "OUTSIDE_BOOKING_HORIZON") setError("La fecha está fuera del horizonte de reservas del negocio.");
      else setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.");
    } finally {
      setBusy(false);
    }
  }

  const grouped = useMemo(() => {
    const byDate = new Map<string, typeof items>();
    for (const item of items) {
      const list = byDate.get(item.localDate) ?? [];
      list.push(item);
      byDate.set(item.localDate, list);
    }
    return [...byDate.entries()];
  }, [items]);

  const blocking = conflicts.filter((conflict) => (conflict.reservationId || conflict.courseId)
    && ["CONFIRMED", "RESCHEDULED"].includes(conflict.status ?? ""));

  return (
    <div className="content absence-content">
      <header className="page-header">
        <div>
          <span className="eyebrow">CAP-03-07</span>
          <h1 className="page-title">Ausencias</h1>
          <p>{sharedScope ? "Solicitudes y cobertura del negocio." : "Tus solicitudes de ausencia."}</p>
        </div>
        {canRequest && (
          <Button onClick={() => { setCreating((value) => !value); setMessage(""); setError(""); }} disabled={busy}>
            {creating ? "Cerrar" : "Solicitar ausencia"}
          </Button>
        )}
      </header>

      {error && <div className="notice error" role="alert">{error} <Button className="ghost" onClick={() => void load()}>Reintentar</Button></div>}
      {message && <div className="notice success" role="status">{message}</div>}

      <div className="agenda-toolbar" role="group" aria-label="Filtros de ausencias">
        <label className="agenda-date">Estado
          <select aria-label="Filtro de estado de ausencia" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="ALL">Todas</option>
            <option value="PENDING">Pendientes</option>
            <option value="APPROVED">Aprobadas</option>
            <option value="APPLIED">Aplicadas</option>
            <option value="REJECTED">Rechazadas</option>
            <option value="WITHDRAWN">Retiradas</option>
          </select>
        </label>
        {sharedScope && professionals.length > 0 && (
          <label className="agenda-date">Profesional
            <select aria-label="Filtro de profesional" value={staffFilter} onChange={(event) => setStaffFilter(event.target.value)}>
              <option value="">Todos</option>
              {professionals.map((professional) => (
                <option key={professional.staffMemberId} value={professional.staffMemberId}>{professional.displayName}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {creating && canRequest && (
        <section className="agenda-create" aria-label="Solicitar ausencia">
          <h2>Nueva solicitud</h2>
          <div className="agenda-form">
            {sharedScope && (
              <label>Profesional de la ausencia
                <select value={form.staffMemberId} onChange={(event) => setForm((value) => ({ ...value, staffMemberId: event.target.value }))}>
                  <option value="">Elegí un profesional</option>
                  {professionals.map((professional) => (
                    <option key={professional.staffMemberId} value={professional.staffMemberId}>{professional.displayName}</option>
                  ))}
                </select>
              </label>
            )}
            <label>Fecha<input type="date" value={form.localDate} onChange={(event) => setForm((value) => ({ ...value, localDate: event.target.value }))} /></label>
            <label>Desde<input type="time" value={form.start} onChange={(event) => setForm((value) => ({ ...value, start: event.target.value }))} /></label>
            <label>Hasta<input type="time" value={form.end} onChange={(event) => setForm((value) => ({ ...value, end: event.target.value }))} /></label>
            <label>Motivo<input value={form.reason} onChange={(event) => setForm((value) => ({ ...value, reason: event.target.value }))} placeholder="Opcional" /></label>
          </div>
          <Button
            disabled={busy || !(sharedScope ? form.staffMemberId : staffMemberId) || !form.localDate || clockToMinute(form.end) <= clockToMinute(form.start)}
            onClick={() => run(async () => {
              await requestAbsence({
                staffMemberId: sharedScope ? form.staffMemberId : staffMemberId,
                localDate: form.localDate,
                startMinute: clockToMinute(form.start),
                endMinute: clockToMinute(form.end),
                ...(form.reason.trim() ? { reason: form.reason.trim() } : {})
              });
              setCreating(false);
              setForm({ staffMemberId: "", localDate: "", start: "09:00", end: "13:00", reason: "" });
            }, "Solicitud registrada.")}
          >
            {busy ? "Enviando…" : "Enviar solicitud"}
          </Button>
        </section>
      )}

      {loading ? (
        <div className="stack skeleton-list" aria-busy="true" aria-label="Cargando ausencias">{[1, 2, 3].map((item) => <div className="skeleton" key={item} />)}</div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Sin solicitudes de ausencia"
          detail="Todavía no hay solicitudes para los filtros seleccionados."
          action={canRequest ? <Button onClick={() => setCreating(true)}>Solicitar ausencia</Button> : undefined}
        />
      ) : (
        <div className="agenda-groups">
          {grouped.map(([localDate, group]) => (
            <section className="agenda-group" key={localDate} aria-label={`Ausencias del ${localDate}`}>
              <h2>{localDate}</h2>
              <ul className="agenda-list">
                {group.map((item) => (
                  <li key={item.id}>
                    <button className="agenda-item" onClick={() => void open(item.id)} aria-label={`Abrir ausencia de ${item.staffMemberName ?? "profesional"} del ${item.localDate}`}>
                      <span className="agenda-time">{minuteToClock(item.startMinute)}–{minuteToClock(item.endMinute)}</span>
                      <span className="agenda-main">
                        <strong>{item.staffMemberName ?? "Profesional"}</strong>
                        <span className="muted">{item.reason ?? "Sin motivo"}</span>
                      </span>
                      <StatusPill tone={statusTone(item.status)}>{statusLabel(item.status)}</StatusPill>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {detailLoading && <div className="skeleton" aria-busy="true" />}

      {detail && (
        <section className="agenda-detail" aria-label="Detalle de la ausencia">
          <header className="agenda-detail-head">
            <div>
              <span className="eyebrow">Ausencia</span>
              <h2>{detail.absence.staffMemberName ?? "Profesional"}</h2>
              <p className="muted">{detail.absence.localDate} · {minuteToClock(detail.absence.startMinute)}–{minuteToClock(detail.absence.endMinute)}</p>
            </div>
            <div className="inline">
              <StatusPill tone={statusTone(detail.absence.status)}>{statusLabel(detail.absence.status)}</StatusPill>
              <Button className="ghost" onClick={() => { setDetail(null); setConflicts([]); }} aria-label="Cerrar detalle">Cerrar</Button>
            </div>
          </header>

          {detail.absence.reason && <p className="muted">Motivo: {detail.absence.reason}</p>}
          {detail.absence.rejectReason && <p className="muted">Motivo del rechazo: {detail.absence.rejectReason}</p>}

          <div className="agenda-detail-grid">
            <div>
              <h3>Turnos y cursos afectados</h3>
              {conflicts.length === 0 ? (
                <p className="muted">No hay ocupaciones confirmadas en este intervalo.</p>
              ) : (
                <ul className="agenda-services">
                  {conflicts.map((conflict) => (
                    <li key={conflict.allocationId}>
                      <span>{conflict.courseId ? `Curso · ${conflict.courseTitle}` : `${conflict.customerName ?? "Cliente"} · ${conflict.serviceNames.join(" · ") || "Sin servicios"}`}</span>
                      <span className="muted">{timeOf(conflict.startsAt ?? conflict.visibleStartAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {blocking.length > 0 && (
                <div className="notice error" role="alert">
                  Hay {blocking.length} ocupación(es) en el intervalo. Revisá los turnos en Agenda y las sesiones en Cursos. Después volvé a sincronizar.
                </div>
              )}
            </div>
            <div>
              <h3>Historial</h3>
              <ul className="agenda-history">
                {detail.events.map((event) => (
                  <li key={event.sequence}>
                    <span className="agenda-event-type">{event.eventType}</span>
                    <span className="muted">{timeOf(event.occurredAt)} · rev {event.beforeRevision ?? "—"}→{event.afterRevision ?? "—"}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="agenda-actions">
            {canApprove && detail.absence.status === "PENDING" && (
              <Button disabled={busy} onClick={() => run(async () => {
                await approveAbsence(detail.absence.id, detail.absence.revision);
              }, "Ausencia aprobada.")}>
                {busy ? "Aprobando…" : "Aprobar"}
              </Button>
            )}
            {canReject && (detail.absence.status === "PENDING" || detail.absence.status === "APPROVED") && (
              <>
                <label className="agenda-reason">Motivo del rechazo
                  <input value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} placeholder="Obligatorio" />
                </label>
                <Button className="danger" disabled={busy || rejectReason.trim().length < 3} onClick={() => run(async () => {
                  await rejectAbsence(detail.absence.id, detail.absence.revision, rejectReason.trim());
                  setRejectReason("");
                }, "Ausencia rechazada.")}>
                  Rechazar
                </Button>
              </>
            )}
            {canWithdraw && (detail.absence.status === "PENDING" || detail.absence.status === "APPROVED") && (
              <Button className="ghost" disabled={busy} onClick={() => run(async () => {
                await withdrawAbsence(detail.absence.id, detail.absence.revision);
              }, "Solicitud retirada.")}>
                Retirar
              </Button>
            )}
            {canApply && detail.absence.status === "APPROVED" && (
              <>
                <Button className="ghost" disabled={busy} onClick={() => run(async () => {
                  await syncAbsenceConflicts(detail.absence.id);
                }, "Conflictos sincronizados.")}>
                  Sincronizar conflictos
                </Button>
                <Button disabled={busy} onClick={() => run(async () => {
                  await applyAbsence(detail.absence.id, detail.absence.revision);
                }, "Ausencia aplicada.")}>
                  {busy ? "Aplicando…" : "Aplicar ausencia"}
                </Button>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** Contexto de permisos del actor (misma fuente que usa la Agenda). */
async function getContext() {
  return api<{ role: string; staffMemberId: string; capabilities: string[] }>("/v1/iam/context");
}
