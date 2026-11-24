"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState, StatusPill } from "@youngkingz/ui";
import { coursesApi } from "@/features/courses/api";
import "@/features/courses/courses.css";

type PublicCourse = { id: string; title: string; summary: string | null; description: string | null; contactChannel: string | null; contactValue: string | null };
type PublicSession = { id: string; courseId: string; localDate: string; start: string; end: string; timezone: string };

const contactLabel: Record<string, string> = { PHONE: "Teléfono", EMAIL: "Correo", WHATSAPP: "WhatsApp", NONE: "" };

export default function PublicCoursesPage() {
  const [businessId, setBusinessId] = useState("");
  const [courses, setCourses] = useState<PublicCourse[]>([]);
  const [sessions, setSessions] = useState<PublicSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("businessId");
    if (id) setBusinessId(id);
  }, []);

  useEffect(() => {
    if (!businessId) return;
    setLoading(true);
    coursesApi.publicList(businessId)
      .then((data) => { setCourses(data.courses as PublicCourse[]); setSessions(data.sessions as PublicSession[]); setError(null); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "No se pudieron cargar los cursos"))
      .finally(() => setLoading(false));
  }, [businessId]);

  return (
    <main className="content">
      <header className="page-header"><div>
        <Link href="/reservar" className="button ghost">← Volver a reservas</Link>
        <h1 className="page-title">Cursos</h1>
        <p>Descubrí los cursos publicados y consultá sus sesiones. Para inscribirte, contactá al negocio.</p>
      </div></header>

      {!businessId && <div className="panel-section">
        <label className="yk-field">Negocio
          <input value={businessId} onChange={(event) => setBusinessId(event.target.value)} placeholder="Identificador del negocio" />
        </label>
        <p className="muted">También podés abrir esta página con el enlace <code>?businessId=…</code> que te envió la barbería.</p>
      </div>}

      {error && <p role="alert" className="status-pill danger">{error}</p>}
      {loading && <p>Cargando cursos…</p>}

      {businessId && !loading && courses.length === 0 && <EmptyState title="No hay cursos publicados" detail="Cuando la barbería publique un curso, vas a poder verlo acá." />}

      <div className="record-list">
        {courses.map((course) => (
          <article key={course.id} className="record-row">
            <div><strong>{course.title}</strong><StatusPill tone="positive">Disponible</StatusPill></div>
            {course.summary && <p>{course.summary}</p>}
            {course.description && <p>{course.description}</p>}
            <ul>{sessions.filter((session) => session.courseId === course.id).map((session) => (
              <li key={session.id}>{new Date(session.start).toLocaleString("es-AR", { timeZone: session.timezone, dateStyle: "long", timeStyle: "short" })}</li>
            ))}</ul>
            {course.contactChannel && course.contactChannel !== "NONE" && course.contactValue && (
              <p><strong>{contactLabel[course.contactChannel]}:</strong> {course.contactValue}</p>
            )}
          </article>
        ))}
      </div>
    </main>
  );
}
