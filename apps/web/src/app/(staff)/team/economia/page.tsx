"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EmptyState } from "@youngkingz/ui";
import { api, ApiError } from "@/lib/api/client";
import "@/features/economy/economy.css";

export default function TeamEconomyPage() {
  const [staff, setStaff] = useState<Array<{ id: string; firstName: string; lastName: string | null; roles: string[] }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Array<{ id: string; firstName: string; lastName: string | null; roles: string[] }>>("/v1/staff?status=CURRENT")
      .then((items) => setStaff(items.filter((item) => item.roles.includes("BARBER"))))
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : "No se pudo cargar el personal"));
  }, []);

  return (
    <section className="content">
      <header className="page-header"><div>
        <Link href="/team" className="button ghost">← Volver a Equipo</Link>
        <h1 className="page-title">Economía del personal</h1>
        <p>Elegí un profesional para revisar su acuerdo, estimaciones y liquidaciones.</p>
      </div></header>
      {error && <p role="alert" className="status-pill danger">{error}</p>}
      {staff.length === 0 ? <EmptyState title="Sin profesionales" detail="Todavía no hay profesionales activos en el equipo." /> : (
        <ul className="record-list">{staff.map((member) => (
          <li key={member.id} className="record-row">
            <strong>{member.firstName}{member.lastName ? ` ${member.lastName}` : ""}</strong>
            <div className="row-actions"><Link className="button" href={`/team/${member.id}/economia`}>Ver economía</Link></div>
          </li>
        ))}</ul>
      )}
    </section>
  );
}
