"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Field, StatusPill } from "@youngkingz/ui";
import { ApiError } from "@/lib/api/client";
import { coursesApi, type CourseEvent, type CourseSession } from "./api";
import "./courses.css";

const statusLabel: Record<string, string> = {
  SCHEDULED: "Programada", CONFIRMED: "Confirmada", RESCHEDULED: "Reprogramada", CANCELLED: "Cancelada", COMPLETED: "Realizada"
};
const sessionTone = (status: string): "neutral" | "positive" | "warning" | "danger" =>
  status === "CONFIRMED" || status === "COMPLETED" ? "positive" : status === "CANCELLED" ? "danger" : status === "RESCHEDULED" ? "warning" : "neutral";

function minuteToClock(minute: number | null) {
  const value = minute ?? 0;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function CourseSessionsWorkspace({ courseId }: { courseId: string }) {
  const [sessions, setSessions] = useState<CourseSession[]>([]);
  const [instructors, setInstructors] = useState<Array<{ staffMemberId: string; effectiveDisplayName: string }>>([]);
  const [history, setHistory] = useState<CourseEvent[]>([]);
  const [instructorsLoaded, setInstructorsLoaded] = useState(false);
  const [instructor, setInstructor] = useState("");
  const [localDate, setLocalDate] = useState("");
  const [localStart, setLocalStart] = useState("09:00");
  const [duration, setDuration] = useState(60);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newDate, setNewDate] = useState("");
  const [newStart, setNewStart] = useState("09:00");

  const load = useCallback(async () => {
    const [items, professionals, events] = await Promise.all([
      coursesApi.sessions(courseId), coursesApi.instructors(), coursesApi.history({ courseId })
    ]);
    setSessions(items); setInstructors(professionals); setHistory(events); setInstructorsLoaded(true);
    setInstructor((current) => professionals.some((item) => item.staffMemberId === current) ? current : professionals[0]?.staffMemberId ?? "");
    setError(null);
  }, [courseId]);

  useEffect(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : "No se pudieron cargar las sesiones")); }, [load]);

  async function run(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); setNotice(message); await load(); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : "No se pudo completar la operación"); }
    finally { setBusy(null); }
  }

  return (
    <section className="content">
      <header className="page-header"><div>
        <Link href="/cursos" className="button ghost">← Volver a Cursos</Link>
        <h1 className="page-title">Sesiones del curso</h1>
        <p>Programá sesiones con un instructor real. Una sesión confirmada ocupa la Agenda del profesional.</p>
      </div></header>

      <div className="panel-section">
        <h2>Nueva sesión</h2>
        <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void run("schedule", async () => {
          await coursesApi.schedule(courseId, { instructorStaffMemberId: instructor, localDate, localStart, durationMinutes: Number(duration) });
          setLocalDate("");
        }, "Sesión programada"); }}>
          <Field label="Instructor" error={instructorsLoaded && instructors.length === 0 ? "No hay instructores elegibles" : undefined}>
            <select value={instructor} onChange={(event) => setInstructor(event.target.value)} required disabled={instructors.length === 0}>
              {instructors.map((item) => <option key={item.staffMemberId} value={item.staffMemberId}>{item.effectiveDisplayName}</option>)}
            </select>
          </Field>
          <Field label="Fecha local"><input type="date" value={localDate} onChange={(event) => setLocalDate(event.target.value)} required /></Field>
          <Field label="Hora local"><input type="time" value={localStart} onChange={(event) => setLocalStart(event.target.value)} required /></Field>
          <Field label="Duración (minutos)"><input type="number" min={15} max={480} step={15} value={duration} onChange={(event) => setDuration(Number(event.target.value))} required /></Field>
          <Button type="submit" disabled={busy !== null || !instructor || !localDate || instructors.length === 0}>Programar sesión</Button>
        </form>
      </div>

      {error && <p role="alert" className="status-pill danger">{error}</p>}
      {notice && <p role="status" className="status-pill positive">{notice}</p>}

      <div className="panel-section">
        <h2>Sesiones</h2>
        {sessions.length === 0 ? <EmptyState title="Sin sesiones" detail="Programá la primera sesión para este curso." /> : (
          <ul className="record-list">
            {sessions.map((session) => (
              <li key={session.id} className="record-row">
                <div><strong>{session.localDate} · {minuteToClock(session.localStartMinute)}</strong><StatusPill tone={sessionTone(session.status)}>{statusLabel[session.status] ?? session.status}</StatusPill></div>
                <p>{Number(session.durationMinutes)} minutos · zona {session.timezone}</p>
                <div className="row-actions">
                  {session.status === "SCHEDULED" && <>
                    <Button disabled={busy !== null} onClick={() => void run(`confirm:${session.id}`, () => coursesApi.confirm(session.id), "Sesión confirmada")}>Confirmar</Button>
                    <Button className="danger" disabled={busy !== null} onClick={() => void run(`cancel:${session.id}`, () => coursesApi.cancelSession(session.id), "Sesión cancelada")}>Cancelar</Button>
                  </>}
                  {(session.status === "CONFIRMED" || session.status === "RESCHEDULED") && <>
                    <Button className="secondary" disabled={busy !== null} onClick={() => { setEditing(session.id); setNewDate(session.localDate); setNewStart(minuteToClock(session.localStartMinute)); }}>Reprogramar</Button>
                    <Button className="danger" disabled={busy !== null} onClick={() => void run(`cancel:${session.id}`, () => coursesApi.cancelSession(session.id), "Sesión cancelada")}>Cancelar</Button>
                    {new Date(session.occupiedEndAt).getTime() <= Date.now() &&
                      <Button className="secondary" disabled={busy !== null} onClick={() => void run(`complete:${session.id}`, () => coursesApi.complete(session.id), "Sesión registrada como realizada")}>Registrar realización</Button>}
                  </>}
                </div>
                {editing === session.id && <div className="form-grid">
                  <Field label="Nueva fecha local"><input type="date" value={newDate} onChange={(event) => setNewDate(event.target.value)} /></Field>
                  <Field label="Nueva hora local"><input type="time" value={newStart} onChange={(event) => setNewStart(event.target.value)} /></Field>
                  <Button disabled={busy !== null || !newDate} onClick={() => void run(`reschedule:${session.id}`, async () => {
                    await coursesApi.reschedule(session.id, { localDate: newDate, localStart: newStart, durationMinutes: Number(session.durationMinutes), revision: session.revision });
                    setEditing(null);
                  }, "Sesión reprogramada")}>Guardar nueva fecha</Button>
                  <Button className="ghost" onClick={() => setEditing(null)}>Cancelar</Button>
                </div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel-section">
        <h2>Historial</h2>
        {history.length === 0 ? <p>Hoy todavía no hay cambios registrados.</p> : (
          <ul className="audit-list">{history.map((event) => (
            <li key={event.id} className="audit-item">{event.eventType} · {new Date(event.createdAt).toLocaleString("es-AR")}{event.sessionId ? ` · sesión ${event.sessionId.slice(0, 8)}` : ""}</li>
          ))}</ul>
        )}
      </div>
    </section>
  );
}
