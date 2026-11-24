"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, EmptyState, StatusPill } from "@youngkingz/ui";
import { ApiError } from "@/lib/api/client";
import {
  confirmNoShow, createAgendaReservation, getAgendaContext, getAgendaReservation,
  listAgenda, listAgendaProfessionals, listAgendaServices, overrideCancelReservation,
  overrideRescheduleReservation, reassignReservation, registerArrival,
  type AgendaCourse, type AgendaDetail, type AgendaItem, type ProfessionalOption, type ServiceOption,
} from "./api";

type DateRange = { from: string; to: string };

const DAY_MS = 86_400_000;

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const instant = new Date(Date.UTC(year!, month! - 1, day! + days));
  return `${instant.getUTCFullYear()}-${String(instant.getUTCMonth() + 1).padStart(2, "0")}-${String(instant.getUTCDate()).padStart(2, "0")}`;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
}

const statusTone = (status: string): "neutral" | "positive" | "warning" | "danger" => {
  if (status === "CONFIRMED") return "positive";
  if (status === "NO_SHOW") return "warning";
  if (status === "CANCELLED") return "danger";
  return "neutral";
};

const statusLabel = (status: string): string => {
  if (status === "CONFIRMED") return "Confirmada";
  if (status === "NO_SHOW") return "No se presentó";
  if (status === "CANCELLED") return "Cancelada";
  return status;
};

/**
 * H03.U05 · Agenda de reservas para Staff.
 *
 * UNA sola superficie de agenda para Dueño, Recepción y Barbero. La
 * diferencia entre roles NO es una vista distinta: es el ALCANCE que el
 * servidor autoriza (agenda compartida vs agenda propia) y qué acciones
 * contextuales se ofrecen. El frontend sólo refleja capacidades; la
 * autoridad vive en el backend.
 */
export function AgendaWorkspace() {
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [range, setRange] = useState<DateRange>({ from: todayLocal(), to: todayLocal() });
  const [courseOccupancy, setCourseOccupancy] = useState<AgendaCourse[]>([]);
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [professionals, setProfessionals] = useState<ProfessionalOption[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [staffFilter, setStaffFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "CONFIRMED" | "CANCELLED" | "NO_SHOW">("ALL");
  const [selected, setSelected] = useState<AgendaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ serviceId: "", staffMemberId: "", visibleStart: "13:30", name: "", phone: "" });
  const [reason, setReason] = useState("");

  const can = useCallback((capability: string) => capabilities.includes(capability), [capabilities]);
  const sharedScope = can("bookings.read");
  const canCreate = can("bookings.create");
  const canReschedule = can("bookings.override.reschedule");
  const canCancel = can("bookings.override.cancel");
  const canArrival = can("bookings.arrival") || can("bookings.self.arrival");
  const canNoShow = can("bookings.no_show") || can("bookings.self.no_show");
  const arrivalScoped = can("bookings.self.arrival") && !can("bookings.arrival");
  const noShowScoped = can("bookings.self.no_show") && !can("bookings.no_show");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [context, agenda] = await Promise.all([
        getAgendaContext(),
        listAgenda({ fromDate: range.from, toDate: range.to, status: statusFilter, staffMemberId: staffFilter || undefined, limit: 100 }),
      ]);
      setCapabilities(context.capabilities);
      setItems(agenda.items);
      setCourseOccupancy(agenda.courseOccupancy ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cargar la agenda.");
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, statusFilter, staffFilter]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!sharedScope) return;
    listAgendaProfessionals().then(setProfessionals).catch(() => undefined);
  }, [sharedScope]);

  useEffect(() => {
    if (!canCreate) return;
    listAgendaServices().then(setServices).catch(() => undefined);
  }, [canCreate]);

  const openReservation = useCallback(async (id: string) => {
    setDetailLoading(true);
    setError("");
    try {
      setSelected(await getAgendaReservation(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo abrir la reserva.");
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
      if (selected) await openReservation(selected.reservation.id);
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : "";
      if (code === "SLOT_CONFLICT") setError("El horario ya está ocupado: elegí otro profesional u otra hora.");
      else if (code === "STALE_REVISION") setError("La reserva cambió en otra sesión. Recargá el detalle antes de operar.");
      else if (code === "BOOKING_ALREADY_CANCELLED") setError("La reserva ya no está activa.");
      else if (code === "BOOKING_NO_SHOW_WINDOW_NOT_OPEN") setError("Todavía no transcurrió la hora del turno.");
      else if (code === "PROFESSIONAL_NOT_ELIGIBLE") setError("Ese profesional no puede atender todos los servicios de la reserva.");
      else if (code === "FORBIDDEN") setError("No tenés autoridad sobre esta reserva.");
      else setError(cause instanceof Error ? cause.message : "No se pudo completar la operación.");
    } finally {
      setBusy(false);
    }
  }

  const today = todayLocal();
  const dayCount = Math.max(1, Math.round((new Date(range.to).getTime() - new Date(range.from).getTime()) / DAY_MS) + 1);
  const grouped = useMemo(() => {
    const byStaff = new Map<string, AgendaItem[]>();
    for (const item of items) {
      const list = byStaff.get(item.staffMemberId) ?? [];
      list.push(item);
      byStaff.set(item.staffMemberId, list);
    }
    return [...byStaff.entries()];
  }, [items]);

  const nameOf = useCallback((staffMemberId: string) => {
    const found = professionals.find((professional) => professional.staffMemberId === staffMemberId);
    return found?.displayName ?? (staffMemberId === selected?.reservation.staffMemberId ? "Tú" : "Profesional");
  }, [professionals, selected]);

  return (
    <div className="content agenda-content">
      <header className="page-header">
        <div>
          <span className="eyebrow">Operación diaria</span>
          <h1 className="page-title">Agenda</h1>
          <p>{sharedScope ? "Turnos del negocio por profesional." : "Tus turnos del día."}</p>
        </div>
        {canCreate && (
          <Button onClick={() => { setCreating((value) => !value); setMessage(""); setError(""); }} disabled={busy}>
            {creating ? "Cerrar" : "Crear turno"}
          </Button>
        )}
      </header>

      {error && <div className="notice error" role="alert">{error} <Button className="ghost" onClick={() => void load()}>Reintentar</Button></div>}
      {message && <div className="notice success" role="status">{message}</div>}

      <div className="agenda-toolbar" role="group" aria-label="Filtros de la agenda">
        <div className="inline">
          <Button className="ghost" onClick={() => setRange({ from: shiftDate(range.from, -1), to: shiftDate(range.to, -1) })} aria-label="Día anterior">←</Button>
          <Button className="ghost" onClick={() => setRange({ from: today, to: today })}>Hoy</Button>
          <Button className="ghost" onClick={() => setRange({ from: shiftDate(range.from, 1), to: shiftDate(range.to, 1) })} aria-label="Día siguiente">→</Button>
        </div>
        <label className="agenda-date">Desde<input type="date" value={range.from} max={range.to} onChange={(event) => setRange((value) => ({ ...value, from: event.target.value }))} /></label>
        <label className="agenda-date">Hasta<input type="date" value={range.to} min={range.from} onChange={(event) => setRange((value) => ({ ...value, to: event.target.value }))} /></label>
        <label className="agenda-date">Estado
          <select aria-label="Filtro de estado" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="ALL">Todos</option>
            <option value="CONFIRMED">Confirmadas</option>
            <option value="NO_SHOW">No se presentaron</option>
            <option value="CANCELLED">Canceladas</option>
          </select>
        </label>
        {sharedScope && (
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

      {creating && canCreate && (
        <section className="agenda-create" aria-label="Crear turno">
          <h2>Nuevo turno</h2>
          <div className="agenda-form">
            <label>Servicio
              <select value={createForm.serviceId} onChange={(event) => setCreateForm((value) => ({ ...value, serviceId: event.target.value }))}>
                <option value="">Elegí un servicio</option>
                {services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
              </select>
            </label>
            <label>Profesional
              <select value={createForm.staffMemberId} onChange={(event) => setCreateForm((value) => ({ ...value, staffMemberId: event.target.value }))}>
                <option value="">Cualquiera disponible</option>
                {professionals.map((professional) => (
                  <option key={professional.staffMemberId} value={professional.staffMemberId}>{professional.displayName}</option>
                ))}
              </select>
            </label>
            <label>Hora<input type="time" value={createForm.visibleStart} onChange={(event) => setCreateForm((value) => ({ ...value, visibleStart: event.target.value }))} /></label>
            <label>Cliente<input value={createForm.name} onChange={(event) => setCreateForm((value) => ({ ...value, name: event.target.value }))} /></label>
            <label>Teléfono<input value={createForm.phone} onChange={(event) => setCreateForm((value) => ({ ...value, phone: event.target.value }))} /></label>
          </div>
          <Button
            disabled={busy || !createForm.serviceId || !createForm.name.trim() || !createForm.phone.trim()}
            onClick={() => run(async () => {
              await createAgendaReservation({
                serviceIds: [createForm.serviceId],
                localDate: range.from,
                visibleStart: createForm.visibleStart,
                professionalPreference: createForm.staffMemberId ? { type: "SPECIFIC", staffMemberId: createForm.staffMemberId } : { type: "ANY" },
                contact: { name: createForm.name.trim(), phone: createForm.phone.trim() },
              });
              setCreating(false);
              setCreateForm({ serviceId: "", staffMemberId: "", visibleStart: "13:30", name: "", phone: "" });
            }, "Turno creado.")}
          >
            {busy ? "Creando…" : "Crear turno"}
          </Button>
        </section>
      )}

      {loading ? (
        <div className="stack skeleton-list" aria-busy="true" aria-label="Cargando agenda">{[1, 2, 3, 4].map((item) => <div className="skeleton" key={item} />)}</div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Sin turnos en el período"
          detail={dayCount === 1 ? "No hay reservas para la fecha seleccionada." : "No hay reservas en el rango de fechas elegido."}
          action={canCreate ? <Button onClick={() => setCreating(true)}>Crear turno</Button> : undefined}
        />
      ) : (
        <div className="agenda-groups">
          {grouped.map(([staffMemberId, group]) => (
            <section className="agenda-group" key={staffMemberId} aria-label={`Turnos de ${nameOf(staffMemberId)}`}>
              <h2>{nameOf(staffMemberId)}</h2>
              <ul className="agenda-list">
                {group.map((item) => (
                  <li key={item.id}>
                    <button className="agenda-item" onClick={() => void openReservation(item.id)} aria-label={`Abrir reserva de ${item.customerName ?? "cliente"} a las ${timeOf(item.startsAt)}`}>
                      <span className="agenda-time">{timeOf(item.startsAt)}</span>
                      <span className="agenda-main">
                        <strong>{item.customerName ?? "Cliente"}</strong>
                        <span className="muted">{item.serviceNames.join(" · ") || "Sin servicios"}</span>
                      </span>
                      <StatusPill tone={statusTone(item.status)}>{statusLabel(item.status)}</StatusPill>
                      {item.arrivedAt && <StatusPill tone="positive">Presente</StatusPill>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {!loading && courseOccupancy.length > 0 && (
        <section className="agenda-group" aria-label="Ocupación por cursos">
          <h2>Ocupación por cursos</h2>
          <ul className="agenda-list">{courseOccupancy.map((course) => (
            <li className="agenda-item" key={course.id}>
              <span className="agenda-time">{timeOf(course.startsAt)} – {timeOf(course.endsAt)}</span>
              <span className="agenda-main"><strong>{course.title}</strong><span className="muted">{nameOf(course.staffMemberId)} · {course.localDate}</span></span>
            </li>
          ))}</ul>
        </section>
      )}

      {detailLoading && <div className="skeleton" aria-busy="true" />}

      {selected && (
        <section className="agenda-detail" aria-label="Detalle de la reserva">
          <header className="agenda-detail-head">
            <div>
              <span className="eyebrow">Reserva</span>
              <h2>{selected.reservation.customerName ?? "Cliente"}</h2>
              <p className="muted">
                {timeOf(selected.reservation.startsAt)} – {timeOf(selected.reservation.endsAt)} · {selected.reservation.localDate}
              </p>
            </div>
            <div className="inline">
              <StatusPill tone={statusTone(selected.reservation.status)}>{statusLabel(selected.reservation.status)}</StatusPill>
              {selected.reservation.arrivedAt && <StatusPill tone="positive">Llegó {timeOf(selected.reservation.arrivedAt)}</StatusPill>}
              <Button className="ghost" onClick={() => setSelected(null)} aria-label="Cerrar detalle">Cerrar</Button>
            </div>
          </header>

          <div className="agenda-detail-grid">
            <div>
              <h3>Servicios</h3>
              <ul className="agenda-services">
                {selected.items.map((item) => (
                  <li key={item.position}><span>{item.serviceName}</span><span className="muted">{item.durationMinutes} min</span></li>
                ))}
              </ul>
              <h3>Contacto</h3>
              <p className="muted">{selected.reservation.contact.name ?? "Cliente"} · {selected.reservation.contact.phone ?? "—"}</p>
              <p className="muted">Profesional: {nameOf(selected.reservation.staffMemberId)}</p>
            </div>
            <div>
              <h3>Historial</h3>
              <ul className="agenda-history">
                {selected.events.map((event) => (
                  <li key={event.sequence}>
                    <span className="agenda-event-type">{event.eventType}</span>
                    <span className="muted">{timeOf(event.occurredAt)} · {event.principalType}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {canArrival && selected.reservation.status === "CONFIRMED" && !selected.reservation.arrivedAt && (
            <div className="agenda-actions">
              <Button disabled={busy} onClick={() => run(async () => {
                await registerArrival(selected.reservation.id, selected.reservation.revision);
              }, "Llegada registrada.")}>
                {busy ? "Registrando…" : "Registrar llegada"}
              </Button>
            </div>
          )}

          {can("attendance.register") && selected.reservation.status === "CONFIRMED" && selected.reservation.arrivedAt && (
            <Link className="button secondary" href={`/attendance?reservation=${selected.reservation.id}`}>Registrar atención de este turno</Link>
          )}

          {canNoShow && selected.reservation.status === "CONFIRMED" && (
            <div className="agenda-actions">
              <label className="agenda-reason">Motivo
                <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Opcional" />
              </label>
              <Button className="danger" disabled={busy} onClick={() => run(async () => {
                await confirmNoShow(selected.reservation.id, selected.reservation.revision, reason.trim() || undefined);
                setReason("");
              }, "No-show confirmado.")}>
                {busy ? "Confirmando…" : "Confirmar no-show"}
              </Button>
              {noShowScoped && <span className="muted">Sólo sobre tus propias reservas.</span>}
            </div>
          )}

          {canCancel && selected.reservation.status === "CONFIRMED" && (
            <div className="agenda-actions">
              <Button className="danger" disabled={busy} onClick={() => run(async () => {
                await overrideCancelReservation(selected.reservation.id, selected.reservation.revision, reason.trim() || "Cancelado por el equipo");
                setReason("");
              }, "Reserva cancelada.")}>
                Cancelar reserva
              </Button>
            </div>
          )}

          {canReschedule && selected.reservation.status === "CONFIRMED" && (
            <div className="agenda-actions">
              <label className="agenda-reason">Motivo
                <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Obligatorio para reprogramar" />
              </label>
              <Button disabled={busy || reason.trim().length < 3} onClick={() => run(async () => {
                const startsAt = new Date(selected.reservation.startsAt);
                const tz = selected.reservation.businessTimezone || "America/Argentina/Buenos_Aires";
                const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(startsAt);
                const hh = parts.find((part) => part.type === "hour")?.value ?? "00";
                const mm = parts.find((part) => part.type === "minute")?.value ?? "00";
                await overrideRescheduleReservation(selected.reservation.id, {
                  expectedRevision: selected.reservation.revision,
                  localDate: selected.reservation.localDate,
                  visibleStart: `${hh}:${mm}`,
                  reason: reason.trim(),
                });
                setReason("");
              }, "Reserva reprogramada.")}>
                Reprogramar
              </Button>
              {sharedScope && professionals.length > 0 && (
                <>
                  <label className="agenda-reason">Reasignar a
                    <select value="" onChange={(event) => {
                      const target = event.target.value;
                      if (!target) return;
                      void run(async () => {
                        await reassignReservation(selected.reservation.id, selected.reservation.revision, target, reason.trim() || "Reasignación de profesional");
                        setReason("");
                      }, "Reserva reasignada.");
                    }}>
                      <option value="">Elegí profesional</option>
                      {professionals.filter((professional) => professional.staffMemberId !== selected.reservation.staffMemberId).map((professional) => (
                        <option key={professional.staffMemberId} value={professional.staffMemberId}>{professional.displayName}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
          )}

          {arrivalScoped && selected.reservation.staffMemberId !== "" && (
            <p className="muted">Tu alcance cubre sólo las reservas asignadas a vos.</p>
          )}
        </section>
      )}
    </div>
  );
}
