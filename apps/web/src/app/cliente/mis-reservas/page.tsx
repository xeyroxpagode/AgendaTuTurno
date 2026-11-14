import { ClientPrivateNav } from "@/features/client-auth/flows";
import { ClientReservations } from "@/features/client-auth/ClientReservations";

export default function Page() {
  return (
    <main className="client-private">
      <ClientPrivateNav current="reservations" />
      <section className="client-private-content">
        <p className="eyebrow">Agenda personal</p>
        <h1>Mis reservas</h1>
        <p className="muted">Tus reservas vinculadas a tu cuenta YoungKingz. Cada una conserva su propio negocio y su zona horaria congelada.</p>
        <ClientReservations />
      </section>
    </main>
  );
}