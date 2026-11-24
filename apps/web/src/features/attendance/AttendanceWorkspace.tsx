"use client";
import Link from "next/link";

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, StatusPill } from "@youngkingz/ui";
import { ApiError, api } from "@/lib/api/client";
import { getAgendaReservation, type AgendaDetail } from "@/features/agenda/api";
import { financeApi, releaseOperationId, stableOperationId } from "@/features/finance/api";
import {
  correctAttendance, getAttendance, listAttendanceProfessionals, listAttendances,
  registerWalkIn, setAttendanceState,
  type AttendanceDetail, type AttendanceStatus, type StaffOption,
} from "./api";

/**
 * H03.U06 · CAP-03-08 · Prestación real (Attendance).
 *
 * Superficie única para Dueño, Recepción y Barbero. El alcance (propio vs.
 * Business) lo decide el servidor; aquí se refleja.
 *
 * Dos recorridos:
 *  · atención desde una reserva (introduciendo el `reservationId`);
 *  · walk-in: atención SIN reserva, con contacto mínimo y sin cuenta CLIENT.
 */

const statusTone = (status: AttendanceStatus): "neutral" | "positive" | "warning" | "danger" => {
  if (status === "COMPLETED") return "positive";
  if (status === "PARTIAL") return "warning";
  if (status === "INTERRUPTED") return "danger";
  return "neutral";
};

const statusLabel = (status: AttendanceStatus): string => ({
  IN_PROGRESS: "En curso",
  COMPLETED: "Completada",
  PARTIAL: "Parcial",
  INTERRUPTED: "Interrumpida"
}[status]);

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });

export function AttendanceWorkspace() {
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [role, setRole] = useState("");
  const [staffMemberId, setStaffMemberId] = useState("");
  const [items, setItems] = useState<Awaited<ReturnType<typeof listAttendances>>["items"]>([]);
  const [professionals, setProfessionals] = useState<StaffOption[]>([]);
  const [statusFilter, setStatusFilter] = useState<"ALL" | AttendanceStatus>("ALL");
  const [walkInFilter, setWalkInFilter] = useState<"ALL" | "ONLY" | "EXCLUDE">("ALL");
  const [detail, setDetail] = useState<AttendanceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [linkedReservation, setLinkedReservation] = useState<AgendaDetail | null>(null);
  const [performedPositions, setPerformedPositions] = useState<number[]>([]);
  type AttendanceTerminalStatus = "COMPLETED" | "PARTIAL" | "INTERRUPTED";
  const [form, setForm] = useState({ reservationId: "", staffMemberId: "", name: "", phone: "", service: "", minutes: "30", notes: "", status: "COMPLETED" as AttendanceTerminalStatus });
  const [correction, setCorrection] = useState({ reason: "", service: "", minutes: "", notes: "", status: "COMPLETED" as AttendanceTerminalStatus });

  const can = useCallback((capability: string) => capabilities.includes(capability), [capabilities]);
  const canRegister = can("attendance.register");
  const canCorrect = can("attendance.correct");
  const sharedScope = role !== "BARBER";

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [context, attendances] = await Promise.all([
        api<{ role: string; staffMemberId: string; capabilities: string[] }>("/v1/iam/context"),
        listAttendances({ status: statusFilter, walkIn: walkInFilter }),
      ]);
      setRole(context.role);
      setCapabilities(context.capabilities);
      setStaffMemberId(context.staffMemberId);
      setItems(attendances.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cargar el historial de atenciones.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, walkInFilter]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("reservation");
    if (!id) return;
    void getAgendaReservation(id).then((booking) => {
      setLinkedReservation(booking);
      setPerformedPositions(booking.items.map((item) => item.position));
      setForm((current) => ({ ...current, reservationId: id, staffMemberId: booking.reservation.staffMemberId }));
      setCreating(true);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "No se pudo abrir el turno"));
  }, []);

  useEffect(() => {
    listAttendanceProfessionals().then(setProfessionals).catch(() => undefined);
  }, []);

  const open = useCallback(async (id: string) => {
    setDetailLoading(true);
    setError("");
    try {
      setDetail(await getAttendance(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo abrir la atención.");
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
      if (detail) await open(detail.attendance.id);
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : "";
      if (code === "CONFLICT") setError("Esa atención ya tiene un estado terminal o la reserva ya fue atendida.");
      else if (code === "STALE_REVISION") setError("La atención cambió en otra sesión. Recargá el detalle.");
      else if (code === "VALIDATION_ERROR") setError(cause instanceof Error ? cause.message : "Revisá los datos del formulario.");
      else if (code === "FORBIDDEN") setError("No tenés autoridad sobre esta atención.");
      else if (code === "BOOKING_NOT_FOUND") setError("La reserva no existe en este negocio.");
      else setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="content attendance-content">
      <header className="page-header">
        <div>
          <span className="eyebrow">CAP-03-08</span>
          <h1 className="page-title">Atención real</h1>
          <p>{sharedScope ? "Lo que efectivamente se prestó en el negocio." : "Las atenciones que registraste."}</p>
        </div>
        {canRegister && (
          <Button onClick={() => { setCreating((value) => !value); setMessage(""); setError(""); }} disabled={busy}>
            {creating ? "Cerrar" : "Registrar atención"}
          </Button>
        )}
      </header>

      {error && <div className="notice error" role="alert">{error} <Button className="ghost" onClick={() => void load()}>Reintentar</Button></div>}
      {message && <div className="notice success" role="status">{message}</div>}

      <div className="agenda-toolbar" role="group" aria-label="Filtros de atenciones">
        <label className="agenda-date">Estado
          <select aria-label="Filtro de estado de atención" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="ALL">Todas</option>
            <option value="IN_PROGRESS">En curso</option>
            <option value="COMPLETED">Completadas</option>
            <option value="PARTIAL">Parciales</option>
            <option value="INTERRUPTED">Interrumpidas</option>
          </select>
        </label>
        <label className="agenda-date">Origen
          <select aria-label="Filtro de origen" value={walkInFilter} onChange={(event) => setWalkInFilter(event.target.value as typeof walkInFilter)}>
            <option value="ALL">Todas</option>
            <option value="ONLY">Sin turno (walk-in)</option>
            <option value="EXCLUDE">Con turno</option>
          </select>
        </label>
      </div>

      {creating && canRegister && (
        <section className="agenda-create" aria-label="Registrar atención">
          <h2>Nueva atención</h2>
          <div className="agenda-form">
            {linkedReservation ? <p>Turno de {linkedReservation.reservation.customerName} · {linkedReservation.reservation.localDate}</p> :
              <label>Reserva (opcional)
                <input value={form.reservationId} onChange={(event) => setForm((value) => ({ ...value, reservationId: event.target.value.trim() }))} placeholder="Sin reserva = walk-in" />
              </label>}
            <label>Profesional responsable
              {sharedScope ? (
                <select value={form.staffMemberId} onChange={(event) => setForm((value) => ({ ...value, staffMemberId: event.target.value }))}>
                  <option value="">Elegí un profesional</option>
                  {professionals.map((professional) => (
                    <option key={professional.staffMemberId} value={professional.staffMemberId}>{professional.displayName}</option>
                  ))}
                </select>
              ) : (
                <input value={staffMemberId} readOnly aria-label="Profesional responsable" />
              )}
            </label>
            {!linkedReservation && <>
            <label>Nombre del cliente<input value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} placeholder="Obligatorio en walk-in" /></label>
            <label>Teléfono<input value={form.phone} onChange={(event) => setForm((value) => ({ ...value, phone: event.target.value }))} placeholder="Obligatorio en walk-in" /></label>
            <label>Servicio realizado<input value={form.service} onChange={(event) => setForm((value) => ({ ...value, service: event.target.value }))} /></label>
            <label>Duración total (min)<input type="number" min="0" max="1440" value={form.minutes} onChange={(event) => setForm((value) => ({ ...value, minutes: event.target.value }))} /></label>
            </>}
            {linkedReservation && <fieldset>
              <legend>Servicios realizados</legend>
              {linkedReservation.items.map((item) => (
                <label className="check-row" key={item.position}>
                  <input type="checkbox" checked={performedPositions.includes(item.position)} onChange={(event) => {
                    const checked = event.target.checked;
                    setPerformedPositions((positions) => checked ? [...positions, item.position] : positions.filter((position) => position !== item.position));
                  }} /> {item.serviceName}
                </label>
              ))}
            </fieldset>}
            <label>Estado de la atención
              <select value={form.status} onChange={(event) => setForm((value) => ({ ...value, status: event.target.value as AttendanceTerminalStatus }))}>
                <option value="COMPLETED">Completada</option>
                <option value="PARTIAL">Parcial</option>
                <option value="INTERRUPTED">Interrumpida</option>
              </select>
            </label>
          </div>
          <Button
            disabled={busy || !(sharedScope ? form.staffMemberId : staffMemberId)
              || (linkedReservation ? performedPositions.length === 0 : !form.service.trim())
              || (!form.reservationId.trim() && (!form.name.trim() || !form.phone.trim()))}
            onClick={() => run(async () => {
              const services = linkedReservation ? linkedReservation.items.filter((item) => performedPositions.includes(item.position)).map((item) => ({
                serviceId: item.serviceId, name: item.serviceName, durationMinutes: item.durationMinutes,
                priceMinor: item.priceMinor, currency: "ARS" as const
              })) : [{ name: form.service.trim(), durationMinutes: Number(form.minutes) || 0 }];
              const responsible = sharedScope ? form.staffMemberId : staffMemberId;
              if (form.reservationId.trim()) {
                const { registerAttendanceFromReservation } = await import("./api");
                const registered = await registerAttendanceFromReservation({
                  reservationId: form.reservationId.trim(),
                  attendedByStaffMemberId: responsible,
                  servicesPerformedSnapshot: services,
                  status: form.status,
                  ...(form.notes.trim() ? { notes: form.notes.trim() } : {})
                });
                await open(registered.attendanceId);
              } else {
                await registerWalkIn({
                  attendedByStaffMemberId: responsible,
                  contactSnapshot: { name: form.name.trim(), phone: form.phone.trim() },
                  servicesPerformedSnapshot: services,
                  status: form.status,
                  ...(form.notes.trim() ? { notes: form.notes.trim() } : {})
                });
              }
              setCreating(false);
              setLinkedReservation(null);
              setForm({ reservationId: "", staffMemberId: "", name: "", phone: "", service: "", minutes: "30", notes: "", status: "COMPLETED" });
            }, "Atención registrada.")}
          >
            {busy ? "Registrando…" : "Guardar atención"}
          </Button>
          <p className="muted">Sin reserva se registra una atención sin turno: no se crea ninguna reserva ni cuenta de cliente.</p>
        </section>
      )}

      {loading ? (
        <div className="stack skeleton-list" aria-busy="true" aria-label="Cargando atenciones">{[1, 2, 3].map((item) => <div className="skeleton" key={item} />)}</div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Sin atenciones registradas"
          detail="Todavía no hay atenciones para los filtros seleccionados."
          action={canRegister ? <Button onClick={() => setCreating(true)}>Registrar atención</Button> : undefined}
        />
      ) : (
        <ul className="reservation-list">
          {items.map((item) => (
            <li key={item.id}>
              <button className="agenda-item" onClick={() => void open(item.id)} aria-label={`Abrir atención de ${item.contact.name ?? "cliente"} el ${dayOf(item.startedAt)}`}>
                <span className="agenda-time">{dayOf(item.startedAt)} {timeOf(item.startedAt)}</span>
                <span className="agenda-main">
                  <strong>{item.contact.name ?? "Cliente"}</strong>
                  <span className="muted">{item.servicesPerformed.map((service) => service.name).join(" · ") || "Sin servicios"}</span>
                </span>
                {item.walkIn && <StatusPill tone="warning">Sin turno</StatusPill>}
                <StatusPill tone={statusTone(item.status)}>{statusLabel(item.status)}</StatusPill>
              </button>
            </li>
          ))}
        </ul>
      )}

      {detailLoading && <div className="skeleton" aria-busy="true" />}

      {detail && (
        <section className="agenda-detail" aria-label="Detalle de la atención">
          <header className="agenda-detail-head">
            <div>
              <span className="eyebrow">Atención</span>
              <h2>{detail.attendance.contact.name ?? "Cliente"}</h2>
              <p className="muted">{dayOf(detail.attendance.startedAt)} · {timeOf(detail.attendance.startedAt)}</p>
            </div>
            <div className="inline">
              {detail.attendance.walkIn && <StatusPill tone="warning">Sin turno</StatusPill>}
              <StatusPill tone={statusTone(detail.attendance.status)}>{statusLabel(detail.attendance.status)}</StatusPill>
              {can("inventory.consume")&&detail.attendance.status!=="IN_PROGRESS"&&<Link className="button" href={`${role==='BARBER'?'/insumos':'/inventario'}?attendance=${detail.attendance.id}&professional=${detail.attendance.attendedByStaffMemberId}`}>Registrar consumo real</Link>}
              <Button className="ghost" onClick={() => setDetail(null)} aria-label="Cerrar detalle">Cerrar</Button>
            </div>
          </header>

          <div className="agenda-detail-grid">
            <div>
              <h3>Servicios realizados</h3>
              {detail.attendance.servicesPerformed.length === 0 ? (
                <p className="muted">Todavía no se registraron servicios.</p>
              ) : (
                <ul className="agenda-services">
                  {detail.attendance.servicesPerformed.map((service) => (
                    <li key={service.name}><span>{service.name}</span><span className="muted">{service.durationMinutes} min</span></li>
                  ))}
                </ul>
              )}
              {detail.reservedServices.length > 0 && (
                <>
                  <h3>Servicios reservados</h3>
                  <ul className="agenda-services">
                    {detail.reservedServices.map((service) => (
                      <li key={service.name}><span>{service.name}</span><span className="muted">{service.durationMinutes} min</span></li>
                    ))}
                  </ul>
                </>
              )}
              <h3>Profesional responsable</h3>
              <p className="muted">{detail.attendance.attendedByStaffMemberName ?? "Profesional"}</p>
              {detail.attendance.notes && <p className="muted">Notas: {detail.attendance.notes}</p>}
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
              {detail.corrections.length > 0 && (
                <>
                  <h3>Correcciones</h3>
                  <ul className="agenda-history">
                    {detail.corrections.map((item) => (
                      <li key={item.id}>
                        <span className="agenda-event-type">{item.reason}</span>
                        <span className="muted">{item.changedByName ?? "Staff"} · {dayOf(item.changedAt)} {timeOf(item.changedAt)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>

          {detail.attendance.status === "IN_PROGRESS" && canRegister && (
            <div className="agenda-actions">
              <label className="agenda-reason">Servicios realizados
                <input value={correction.service} onChange={(event) => setCorrection((value) => ({ ...value, service: event.target.value }))} placeholder="Ej: Corte, Barba" />
              </label>
              <label className="agenda-reason">Duración total (min)
                <input type="number" min="1" max="1440" value={correction.minutes} onChange={(event) => setCorrection((value) => ({ ...value, minutes: event.target.value }))} />
              </label>
              <Button disabled={busy || !correction.service.trim()} onClick={() => run(async () => {
                await setAttendanceState(detail.attendance.id, {
                  status: correction.status,
                  servicesPerformedSnapshot: [{ name: correction.service.trim(), durationMinutes: Number(correction.minutes) || 0 }],
                  expectedRevision: detail.attendance.revision
                });
                setCorrection((value) => ({ ...value, service: "", minutes: "" }));
              }, "Atención completada.")}>
                Marcar como completada
              </Button>
            </div>
          )}

          {can("sales.create") && detail.attendance.status !== "IN_PROGRESS" && detail.attendance.servicesPerformed.length > 0 && (
            <Button disabled={busy} onClick={() => run(async () => {
              const id = detail.attendance.id;
              const operation = stableOperationId(`attendance-sale-${id}`);
              const result = await financeApi.createSale({ attendanceId: id }, operation);
              releaseOperationId(operation);
              window.location.assign(`/ventas?sale=${result.data.id}`);
            }, "Venta creada.")}>Crear venta de la atención</Button>
          )}

          {canCorrect && detail.attendance.status !== "IN_PROGRESS" && (
            <div className="agenda-actions">
              <label className="agenda-reason">Motivo de la corrección
                <input value={correction.reason} onChange={(event) => setCorrection((value) => ({ ...value, reason: event.target.value }))} placeholder="Obligatorio" />
              </label>
              <label className="agenda-reason">Servicio corregido
                <input value={correction.service} onChange={(event) => setCorrection((value) => ({ ...value, service: event.target.value }))} placeholder="Ej: Corte 20 min" />
              </label>
              <label className="agenda-reason">Estado corregido
                <select value={correction.status} onChange={(event) => setCorrection((value) => ({ ...value, status: event.target.value as AttendanceTerminalStatus }))}>
                  <option value="COMPLETED">Completada</option>
                  <option value="PARTIAL">Parcial</option>
                  <option value="INTERRUPTED">Interrumpida</option>
                </select>
              </label>
              <Button disabled={busy || correction.reason.trim().length < 3} onClick={() => run(async () => {
                await correctAttendance(detail.attendance.id, {
                  reason: correction.reason.trim(),
                  ...(correction.service.trim() ? {
                    servicesPerformedSnapshot: [{ name: correction.service.trim(), durationMinutes: Number(correction.minutes) || 0 }]
                  } : {}),
                  ...(correction.notes.trim() ? { notes: correction.notes.trim() } : {}),
                  expectedRevision: detail.attendance.revision
                });
                setCorrection({ reason: "", service: "", minutes: "", notes: "", status: "COMPLETED" });
              }, "Atención corregida.")}>
                Corregir atención
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
