"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Field, StatusPill } from "@youngkingz/ui";
import { ApiError } from "@/lib/api/client";
import { coursesApi, type Course } from "./api";
import "./courses.css";

const statusTone = (status: string): "neutral" | "positive" | "warning" | "danger" =>
  status === "PUBLISHED" ? "positive" : status === "DRAFT" ? "warning" : status === "CANCELLED" ? "danger" : "neutral";

const statusLabel: Record<string, string> = {
  DRAFT: "Borrador", PUBLISHED: "Publicado", UNPUBLISHED: "Sin publicar", CANCELLED: "Cancelado"
};

export function CoursesWorkspace() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [contactChannel, setContactChannel] = useState("NONE");
  const [contactValue, setContactValue] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { setCourses(await coursesApi.list()); setError(null); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : "No se pudieron cargar los cursos"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key); setError(null); setNotice(null);
    try { await action(); setNotice(message); await load(); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : "La operación no pudo completarse"); }
    finally { setBusy(null); }
  }

  return (
    <section className="content">
      <header className="page-header"><div><h1 className="page-title">Cursos</h1><p>Creá ofertas, programá sesiones y publicá el catálogo para tus clientes.</p></div></header>

      <div className="panel-section">
        <h2>Nueva oferta</h2>
        <form onSubmit={(event) => { event.preventDefault(); void run("create", async () => {
          await coursesApi.create({ title, summary: summary || undefined, contactChannel, contactValue: contactValue || undefined });
          setTitle(""); setSummary(""); setContactValue("");
        }, "Borrador creado"); }} className="form-grid">
          <Field label="Título del curso" error={!title.trim() ? "Ingresá un título" : undefined}>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} required />
          </Field>
          <Field label="Resumen público">
            <textarea value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={500} rows={2} />
          </Field>
          <Field label="Medio de contacto">
            <select value={contactChannel} onChange={(event) => setContactChannel(event.target.value)}>
              <option value="NONE">Sin contacto público</option>
              <option value="PHONE">Teléfono</option>
              <option value="EMAIL">Correo electrónico</option>
              <option value="WHATSAPP">WhatsApp</option>
            </select>
          </Field>
          {contactChannel !== "NONE" && <Field label="Dato de contacto público">
            <input value={contactValue} onChange={(event) => setContactValue(event.target.value)} maxLength={200} required />
          </Field>}
          <Button type="submit" disabled={busy === "create" || !title.trim()}>{busy === "create" ? "Guardando…" : "Guardar borrador"}</Button>
        </form>
      </div>

      {error && <p role="alert" className="status-pill danger">{error}</p>}
      {notice && <p role="status" className="status-pill positive">{notice}</p>}

      <div className="panel-section">
        <h2>Ofertas</h2>
        {loading ? <p>Cargando…</p> : courses.length === 0 ? <EmptyState title="Todavía no hay cursos" detail="Creá una oferta para comenzar." /> : (
          <ul className="record-list">
            {courses.map((course) => (
              <li key={course.id} className="record-row">
                <div><strong>{course.title}</strong><StatusPill tone={statusTone(course.status)}>{statusLabel[course.status] ?? course.status}</StatusPill></div>
                {course.summary && <p>{course.summary}</p>}
                <div className="row-actions">
                  <Link className="button secondary" href={`/cursos/${course.id}/sesiones`}>Sesiones</Link>
                  <Button disabled={busy !== null} onClick={() => void run(`publish:${course.id}`, () => coursesApi.publish(course.id), "Curso publicado")}>Publicar</Button>
                  <Button className="secondary" disabled={busy !== null} onClick={() => void run(`unpublish:${course.id}`, () => coursesApi.unpublish(course.id), "Curso despublicado")}>Despublicar</Button>
                  <Button className="danger" disabled={busy !== null} onClick={() => void run(`cancel:${course.id}`, () => coursesApi.cancel(course.id), "Curso cancelado")}>Cancelar</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
