"use client";

import { useCallback, useEffect, useState } from "react";
import { Calendar } from "lucide-react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api/client";
import { clientApi, type ClientAvailabilitySearch, type ClientReservation, type ClientReservationDetail } from "./api";
import { Message } from "./ClientFrame";

function bookingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "MFA_REQUIRED": return "Completá la verificación con tu aplicación autenticadora.";
      case "ACCOUNT_RESTRICTED": return "Esta cuenta está restringida. Contactá al soporte para continuar.";
      case "SESSION_REVOKED": return "Esta sesión fue cerrada. Volvé a ingresar.";
      case "STALE_REVISION": return "La reserva cambió en otro dispositivo. Actualizamos la lista: revisá e intentá de nuevo.";
      case "SLOT_CONFLICT": return "Ese horario ya no está disponible. Elegí otro.";
      case "BOOKING_CUTOFF_EXPIRED": return "Ya pasó el plazo límite para modificar esta reserva.";
      case "BOOKING_ALREADY_CANCELLED": return "Esta reserva ya estaba cancelada.";
      case "BOOKING_NOT_OWNED": return "Esta reserva no pertenece a tu cuenta.";
      case "OUTSIDE_BOOKING_HORIZON": return "Esa fecha está fuera del período de reservas.";
      case "PROFESSIONAL_NOT_ELIGIBLE": return "El profesional de esta reserva ya no puede tomar estos servicios.";
      case "BOOKING_QUOTE_EXPIRED": return "La cotización venció. Volvé a cotizar.";
      case "RATE_LIMITED": return "Demasiadas solicitudes. Esperá unos segundos.";
    }
  }
  if (error instanceof TypeError) return "No pudimos conectar con el servidor. Revisá tu conexión e intentá de nuevo.";
  return error instanceof Error ? error.message : "No pudimos completar la operación.";
}

function classify(error: unknown): "not-auth" | "mfa" | "restricted" | "stale" | "slot-conflict" | "network" | "unknown" {
  if (error instanceof ApiError) {
    if (error.status === 401) return "not-auth";
    if (error.code === "MFA_REQUIRED") return "mfa";
    if (error.code === "ACCOUNT_RESTRICTED") return "restricted";
    if (error.code === "STALE_REVISION") return "stale";
    if (error.code === "SLOT_CONFLICT") return "slot-conflict";
  }
  if (error instanceof TypeError) return "network";
  return "unknown";
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
}

function localClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

function todayInZone(timeZone: string): string {
  const fields = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => fields.find((field) => field.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

type EditorState = {
  id: string;
  businessId: string;
  staffMemberId: string;
  serviceIds: string[];
  timezone: string;
  date: string;
  minDate: string;
  maxDate: string;
  slots: Array<{ start: string; end: string; time: string }>;
  selected: string | null;
  loading: boolean;
  error: string | null;
};

export function ClientReservations() {
  const router = useRouter();
  const [items, setItems] = useState<ClientReservation[] | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await clientApi.reservations();
      setItems(rows); setFatal(null);
    } catch (error) {
      const k = classify(error);
      if (k === "not-auth") { router.replace("/cliente/ingresar"); return; }
      if (k === "mfa") { router.replace("/cliente/seguridad/verificar"); return; }
      setFatal(bookingErrorMessage(error));
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  async function cancel(r: ClientReservation) {
    setBusyId(r.id); setNotice(null);
    try {
      await clientApi.cancelReservation(r.id, Number(r.revision));
      setNotice({ kind: "success", text: "Reserva cancelada." });
      await load();
    } catch (error) {
      const k = classify(error);
      setNotice({ kind: "error", text: bookingErrorMessage(error) });
      if (k === "stale" || k === "slot-conflict") await load();
    } finally { setBusyId(null); }
  }

  async function loadSlotsFor(businessId: string, serviceIds: string[], staffMemberId: string, date: string, tz: string) {
    setEditor((prev) => (prev ? { ...prev, loading: true, error: null, slots: [] } : prev));
    try {
      const res: ClientAvailabilitySearch = await clientApi.availabilitySearch(businessId, {
        serviceIds, fromDate: date, throughDate: date,
        professionalPreference: { type: "SPECIFIC", staffMemberId },
      });
      const day = res.days.find((d) => d.date === date) ?? res.days[0];
      const slots = (day?.slots ?? []).map((s) => ({ start: s.start, end: s.end, time: localClock(s.start, res.business.timezone || tz) }));
      setEditor((prev) => (prev ? { ...prev, slots, loading: false } : prev));
    } catch (error) {
      const k = classify(error);
      setEditor((prev) => (prev ? { ...prev, loading: false, error: bookingErrorMessage(error) } : prev));
      if (k === "not-auth") router.replace("/cliente/ingresar");
      if (k === "mfa") router.replace("/cliente/seguridad/verificar");
    }
  }

  async function openEditor(r: ClientReservation) {
    setBusyId(r.id); setNotice(null);
    try {
      const detail: ClientReservationDetail = await clientApi.reservation(r.id);
      const serviceIds = detail.items.map((i) => i.serviceId);
      const tz = r.businessTimezone;
      const today = todayInZone(tz);
      const defaultDate = r.localDate >= today && r.localDate <= addDays(today, 29) ? r.localDate : today;
      setEditor({
        id: r.id, businessId: r.businessId, staffMemberId: r.staffMemberId,
        serviceIds, timezone: tz, date: defaultDate,
        minDate: today, maxDate: addDays(today, 29),
        slots: [], selected: null, loading: false, error: null,
      });
      await loadSlotsFor(r.businessId, serviceIds, r.staffMemberId, defaultDate, tz);
    } catch (error) {
      setNotice({ kind: "error", text: bookingErrorMessage(error) });
    } finally { setBusyId(null); }
  }

  async function reschedule() {
    if (!editor || !editor.selected || !items) return;
    const r = items.find((x) => x.id === editor.id);
    if (!r) return;
    setBusyId(r.id); setNotice(null);
    try {
      await clientApi.rescheduleReservation(r.id, Number(r.revision), editor.date, editor.selected);
      setNotice({ kind: "success", text: "Reserva reprogramada." });
      setEditor(null);
      await load();
    } catch (error) {
      const k = classify(error);
      setNotice({ kind: "error", text: bookingErrorMessage(error) });
      if (k === "slot-conflict") {
        await loadSlotsFor(editor.businessId, editor.serviceIds, editor.staffMemberId, editor.date, editor.timezone);
      }
      if (k === "stale") await load();
    } finally { setBusyId(null); }
  }

  if (fatal) return <Message kind="error">{fatal}</Message>;
  if (items === null) return <div className="client-reservations"><div className="skeleton" aria-label="Cargando reservas" /></div>;

  return (
    <section className="client-section">
      <div className="section-head">
        <div><h2>Reservas</h2><p className="muted">Sólo tus reservas, confirmadas o canceladas.</p></div>
        <a className="button secondary" href="/reservar">Reservar un turno</a>
      </div>
      <div role="status" aria-live="polite" className="sr-only">{notice?.text ?? ""}</div>
      {notice && <Message kind={notice.kind}>{notice.text}</Message>}
      {items.length === 0 ? (
        <div className="empty-client">
          <Calendar size={28} />
          <h3>Todavía no tenés reservas</h3>
          <p>Reservá un turno y aparecerá acá. No creamos datos de ejemplo.</p>
        </div>
      ) : (
        <ul className="reservation-list">
          {items.map((r) => (
            <li key={r.id} className="reservation-card">
              <div className="reservation-head">
                <div>
                  <strong>{r.businessName ?? r.businessId}</strong>
                  <span className="muted">{r.localDate} · {localClock(r.startsAt, r.businessTimezone)}–{localClock(r.endsAt, r.businessTimezone)}</span>
                </div>
                <span className={`status-pill status-${r.status.toLowerCase()}`}>{r.status}</span>
              </div>
              <div className="reservation-meta">
                <span>{r.total / 100} {r.currency}</span>
                <span className="muted">Rev. {r.revision}</span>
              </div>
              {r.status === "CONFIRMED" && (
                <div className="reservation-actions">
                  <button type="button" className="button secondary" onClick={() => openEditor(r)} disabled={busyId === r.id}>
                    {busyId === r.id ? "Cargando…" : "Reprogramar"}
                  </button>
                  <button type="button" className="button danger" onClick={() => cancel(r)} disabled={busyId === r.id}>
                    {busyId === r.id ? "Procesando…" : "Cancelar"}
                  </button>
                </div>
              )}
              {editor && editor.id === r.id && (
                <div className="slot-picker">
                  <div className="inline">
                    <label className="muted" style={{ display: "grid", gap: 4 }}>
                      <span>Fecha</span>
                      <input type="date" value={editor.date} min={editor.minDate} max={editor.maxDate}
                        onChange={(e) => { const d = e.target.value; setEditor((p) => (p ? { ...p, date: d } : p)); void loadSlotsFor(editor.businessId, editor.serviceIds, editor.staffMemberId, d, editor.timezone); }} />
                    </label>
                  </div>
                  {editor.loading && <div className="skeleton" aria-label="Cargando horarios" />}
                  {editor.error && <Message kind="error">{editor.error}</Message>}
                  {!editor.loading && editor.slots.length > 0 && (
                    <div className="slot-grid" role="group" aria-label="Horarios disponibles">
                      {editor.slots.map((s) => (
                        <button type="button" key={s.time} className={editor.selected === s.time ? "slot-button is-selected" : "slot-button"}
                          aria-pressed={editor.selected === s.time}
                          onClick={() => setEditor((p) => (p ? { ...p, selected: s.time } : p))}>
                          {s.time}
                        </button>
                      ))}
                    </div>
                  )}
                  {!editor.loading && !editor.error && editor.slots.length === 0 && (
                    <p className="muted">Sin horarios disponibles para esa fecha.</p>
                  )}
                  <div className="inline">
                    <button type="button" className="button" onClick={() => void reschedule()} disabled={!editor.selected || busyId === r.id}>
                      {busyId === r.id ? "Reprogramando…" : "Confirmar reprogramación"}
                    </button>
                    <button type="button" className="button ghost" onClick={() => setEditor(null)} disabled={busyId === r.id}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
