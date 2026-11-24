"use client";
import { useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";

type Reservation = {
  id: string;
  status: string;
  revision: number;
  staffMemberId: string;
  startsAt: string;
  endsAt: string;
  total: number;
  currency: string;
  localDate: string;
};

export default function MisReservasPage() {
  const [reservationId, setReservationId] = useState("");
  const [guestToken, setGuestToken] = useState("");
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [newDate, setNewDate] = useState("");
  const [newTime, setNewTime] = useState("");

  const consult = async () => {
    if (!reservationId || !guestToken) { setMessage("Ingresá ID de reserva y token de invitado."); return; }
    setStatus("loading"); setMessage("");
    try {
      const res = await fetch(`${API}/v1/public/reservations/${reservationId}`, {
        headers: { "x-guest-token": guestToken, accept: "application/json" },
      });
      if (!res.ok) { setMessage(res.status === 403 ? "Token inválido o no autorizado." : "Reserva no encontrada."); setStatus("idle"); return; }
      const data = await res.json() as { reservation: Reservation };
      setReservation(data.reservation);
      setStatus("idle");
    } catch (error: any) {
      setMessage(error.message ?? "Error consultando la reserva");
      setStatus("idle");
    }
  };

  const cancel = async () => {
    if (!reservation) { setMessage("Consultá primero la reserva."); return; }
    setStatus("loading"); setMessage("");
    try {
      const res = await fetch(`${API}/v1/public/reservations/${reservation.id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-guest-token": guestToken, "x-operation-id": crypto.randomUUID() },
        body: JSON.stringify({ expectedRevision: Number(reservation.revision) }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setMessage((d as { error?: { message: string } }).error?.message ?? "No se pudo cancelar"); setStatus("idle"); return; }
      setStatus("success");
      setReservation({ ...reservation, status: "CANCELLED", revision: reservation.revision + 1 });
      setMessage("Reserva cancelada.");
    } catch (error: any) {
      setMessage(error.message ?? "Error cancelando");
      setStatus("idle");
    }
  };

  const reschedule = async () => {
    if (!reservation) { setMessage("Consultá primero la reserva."); return; }
    if (!newDate || !newTime) { setMessage("Ingresá nueva fecha y horario."); return; }
    setStatus("loading"); setMessage("");
    try {
      const res = await fetch(`${API}/v1/public/reservations/${reservation.id}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-guest-token": guestToken, "x-operation-id": crypto.randomUUID() },
        body: JSON.stringify({ expectedRevision: Number(reservation.revision), localDate: newDate, visibleStart: newTime }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setMessage((d as { error?: { message: string } }).error?.message ?? "No se pudo reprogramar"); setStatus("idle"); return; }
      const d = await res.json().catch(() => ({}));
      setStatus("success");
      setReservation((prev) => prev ? { ...prev, status: "CONFIRMED", startsAt: (d as { startsAt?: string }).startsAt ?? prev.startsAt, endsAt: (d as { endsAt?: string }).endsAt ?? prev.endsAt, revision: Number(prev.revision) + 1 } : prev);
      setMessage("Reserva reprogramada.");
    } catch (error: any) {
      setMessage(error.message ?? "Error reprogramando");
      setStatus("idle");
    }
  };

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1>Mis reservas</h1>
      <p style={{ color: "#666", fontSize: 13 }}>Acceso de invitado: consultá, cancelá o reprogramá una reserva con su ID y el token privado recibido al confirmar.</p>
<p style={{ color: "#666", fontSize: 13, marginTop: 4 }}>Si tenés una cuenta YoungKingz, tus reservas también aparecen en <a href="/cliente/mis-reservas">Mis reservas (cuenta)</a>.</p>

      <section style={{ marginTop: 16 }}>
        <label>ID de la reserva<br /><input value={reservationId} onChange={(e) => setReservationId(e.target.value)} style={{ width: "100%", marginBottom: 8 }} /></label>
        <label>Token de invitado<br /><input value={guestToken} onChange={(e) => setGuestToken(e.target.value)} style={{ width: "100%", marginBottom: 8 }} /></label>
        <button onClick={consult} style={{ width: "100%" }}>Consultar reserva</button>
      </section>

      {message && status !== "success" && <p role="alert" style={{ color: "crimson", marginTop: 12 }}>{message}</p>}

      {reservation && (
        <section style={{ marginTop: 16, padding: 12, background: "#f0f0f0", borderRadius: 8 }}>
          <h2>Reserva {reservation.id}</h2>
          <p><strong>Estado:</strong> {reservation.status} &nbsp;|&nbsp; <strong>Revisión:</strong> {reservation.revision}</p>
          <p><strong>Desde:</strong> {new Date(reservation.startsAt).toLocaleString()} &nbsp;|&nbsp; <strong>Hasta:</strong> {new Date(reservation.endsAt).toLocaleString()}</p>
          <p><strong>Total:</strong> {reservation.total / 100} {reservation.currency}</p>
          {reservation.status === "CONFIRMED" && (
            <>
              <button onClick={cancel} style={{ background: "#b00020", color: "#fff", marginRight: 8 }}>Cancelar reserva</button>
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #ccc" }}>
                <label style={{ display: "block", marginBottom: 4 }}>Reprogramar a</label>
                <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} style={{ marginRight: 8, width: "140px" }} />
                <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} style={{ width: "140px" }} />
                <button onClick={reschedule} style={{ marginLeft: 8 }}>Reprogramar</button>
              </div>
            </>
          )}
          {reservation.status === "CANCELLED" && <p style={{ color: "#b00020" }}>Esta reserva está cancelada.</p>}
        </section>
      )}

      {status === "success" && <p style={{ color: "#0a0", marginTop: 12 }}>{message}</p>}
    </main>
  );
}
