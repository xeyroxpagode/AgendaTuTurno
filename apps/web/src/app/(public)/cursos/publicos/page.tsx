import Link from "next/link";
import { EmptyState, StatusPill } from "@youngkingz/ui";
import { coursesApi, type PublicCourseBusiness, type PublicCourses } from "@/features/courses/api";
import "@/features/courses/courses.css";

const contactLabel: Record<string, string> = { PHONE: "Teléfono", EMAIL: "Correo", WHATSAPP: "WhatsApp" };

function contactHref(channel: string, value: string) {
  if (channel === "EMAIL" && /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(value)) return `mailto:${value}`;
  const phone = value.replace(/[\s().-]/g, "");
  if (!/^\+?[0-9]{6,15}$/.test(phone)) return undefined;
  if (channel === "PHONE") return `tel:${phone}`;
  if (channel === "WHATSAPP" && phone.startsWith("+")) return `https://wa.me/${phone.slice(1)}`;
}

export default async function PublicCoursesPage({ searchParams }: { searchParams: Promise<{ businessId?: string }> }) {
  const { businessId } = await searchParams;
  let catalog: PublicCourses | null = null;
  let businesses: PublicCourseBusiness[] = [];
  let error: string | null = null;

  try {
    if (businessId) catalog = await coursesApi.publicList(businessId);
    else businesses = await coursesApi.publicBusinesses();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "No se pudieron cargar los cursos.";
  }

  return (
    <main className="content">
      <header className="page-header"><div>
        <h1 className="page-title">{catalog ? `Cursos · ${catalog.business.name}` : "Cursos"}</h1>
        <p>Consultá las sesiones publicadas y contactá a la barbería para más información.</p>
        {catalog?.business.bookingEnabled && <Link href={`/reservar?businessId=${catalog.business.id}`} className="button secondary">Reservar un turno en esta barbería</Link>}
        <Link href={businessId ? "/cursos/publicos" : "/"} className="button ghost">{businessId ? "Ver otras barberías" : "Volver al inicio"}</Link>
      </div></header>

      {error && <p role="alert" className="status-pill danger">{error}</p>}
      {!error && (catalog ? catalog.courses.length === 0 : businesses.length === 0) &&
        <EmptyState title="No hay cursos publicados" detail="Las ofertas publicadas se mostrarán acá." />}

      <div className="record-list">
        {businesses.map((business) => (
          <Link key={business.id} className="record-row" href={`/cursos/publicos?businessId=${business.id}`}>{business.name}</Link>
        ))}
        {catalog?.courses.map((course) => {
          const sessions = catalog.sessions.filter((session) => session.courseId === course.id);
          const contact = course.contactChannel && course.contactValue && contactHref(course.contactChannel, course.contactValue);
          return (
            <article key={course.id} className="record-row">
              <div><strong>{course.title}</strong><StatusPill tone="positive">Publicado</StatusPill></div>
              {course.summary && <p>{course.summary}</p>}
              {course.description && <p>{course.description}</p>}
              {sessions.length > 0 && <ul>{sessions.map((session) => (
                <li key={session.id}>{new Date(session.start).toLocaleString("es-AR", { timeZone: session.timezone, dateStyle: "long", timeStyle: "short" })}{session.instructorName && ` · ${session.instructorName}`}</li>
              ))}</ul>}
              {course.contactChannel && contactLabel[course.contactChannel] && course.contactValue &&
                <p><strong>{contactLabel[course.contactChannel]}:</strong> {contact ? <a href={contact}>{course.contactValue}</a> : course.contactValue}</p>}
            </article>
          );
        })}
      </div>
    </main>
  );
}
