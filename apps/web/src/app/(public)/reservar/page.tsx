"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ApiError } from "@/lib/api/client";
import { clientApi } from "@/features/client-auth/api";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4100";

type PublicService = {
  id: string;
  name: string;
  priceMinor: number;
  durationMinutes: number;
  conditions: string | null;
};
type PublicProfessional = { id: string; name: string };
type Slot = { start: string; end: string; occupiedMinutes: number; visibleMinutes: number };

function localClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export default function PublicBookingPage() {
  const [businessId, setBusinessId] = useState("");
  const [businesses, setBusinesses] = useState<Array<{ id: string; name: string }>>([]);
  const [directoryError, setDirectoryError] = useState(false);
  const [directoryReady, setDirectoryReady] = useState(false);
  const [identity, setIdentity] = useState<"guest" | "client" | "client-mfa" | "restricted">("guest");
  const [services, setServices] = useState<PublicService[]>([]);
  const [professionals, setProfessionals] = useState<PublicProfessional[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [professional, setProfessional] = useState<"ANY" | string>("ANY");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [businessTimezone, setBusinessTimezone] = useState<string>("UTC");
  const [contact, setContact] = useState({ name: "", phone: "", email: "" });
  const [quote, setQuote] = useState<{ token: string; total: number; currency: string; conditions?: string | null } | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "confirming" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [reservationId, setReservationId] = useState<string | null>(null);
  const [guestToken, setGuestToken] = useState<string | null>(null);
const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("businessId");
    if (id) {
      setBusinessId(id);
      return;
    }
    fetch(`${API}/v1/public/booking-businesses`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Directory unavailable");
        const directory = await response.json() as { businesses: Array<{ id: string; name: string }> };
        setBusinesses(directory.businesses);
      })
      .catch(() => setDirectoryError(true))
      .finally(() => setDirectoryReady(true));
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getSession();
        if (!data.session) { setIdentity("guest"); return; }
        const status = await clientApi.status();
        if (status.status === "ACTIVE") setIdentity(status.aal === "aal2" ? "client" : "client-mfa");
        else if (status.status === "RESTRICTED") setIdentity("restricted");
        else setIdentity("guest");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) setIdentity("guest");
        else setIdentity("guest");
      }
    })();
  }, []);

  // Catálogo público por nombre (no se requieren UUIDs de servicio).
  useEffect(() => {
    if (!businessId) return;
    fetch(`${API}/v1/public/businesses/${businessId}/catalog/services`, { headers: { accept: "application/json" } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Catálogo no disponible (${r.status})`);
        return r.json() as { services?: PublicService[] };
      })
      .then((d) => setServices(d.services ?? []))
      .catch(() => setServices([]));
  }, [businessId]);

  // Profesionales del negocio (para elegir uno concreto o ANY).
  useEffect(() => {
    if (!businessId) return;
    fetch(`${API}/v1/public/businesses/${businessId}/catalog/professionals`, { headers: { accept: "application/json" } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Profesionales no disponibles (${r.status})`);
        return r.json() as { professionals?: PublicProfessional[] };
      })
      .then((d) => setProfessionals(d.professionals ?? []))
      .catch(() => setProfessionals([]));
  }, [businessId]);

  const toggleService = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setSlot(null); setQuote(null);
  };

  const loadSlots = async () => {
    if (!businessId || selected.length === 0 || !date) {
      setSlots([]);
      return;
    }
    setMessage("");
    setSlots([]);
    setStatus("loading");
    try {
      const res = await fetch(`${API}/v1/public/businesses/${businessId}/availability/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceIds: selected,
          fromDate: date,
          throughDate: date,
          professionalPreference: professional === "ANY" ? { type: "ANY" } : { type: "SPECIFIC", staffMemberId: professional },
        }),
      });
      const body = await res.json();
      const asError = body as { error?: { message: string } };
      if (!res.ok || asError.error) throw new Error(asError.error?.message ?? "Sin disponibilidad");
      const asBiz = body as { business?: { timezone?: string } };
      if (asBiz.business?.timezone) setBusinessTimezone(asBiz.business.timezone);
      const asDays = body as { days?: { date: string; slots: Slot[] }[] };
      setSlots(asDays.days?.[0]?.slots ?? []);
    } catch (error: any) {
      setMessage(error.message ?? "No se pudieron cargar los horarios");
      setSlots([]);
    }
    setStatus("idle");
  };

  useEffect(() => { loadSlots(); }, [businessId, JSON.stringify(selected), professional, date]);

  // Escape: limpiar selección de slot y cotización
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setSlot(null); setQuote(null); setMessage(""); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const requestQuote = async () => {
    if (!slot) return;
    const chosen = selected.map((id) => services.find((s) => s.id === id)!);
    setStatus("loading");
    try {
      const res = await fetch(`${API}/v1/public/businesses/${businessId}/booking-quotes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceIds: selected,
          professionalPreference: professional === "ANY" ? { type: "ANY" } : { type: "SPECIFIC", staffMemberId: professional },
          localDate: date,
          visibleStart: localClock(slot.start, businessTimezone),
        }),
      });
      const data = await res.json() as { quote?: string; summary?: { commercialTotalMinor: number; currency: string }; error?: { message: string } };
      if (!res.ok || !data.quote) { setMessage(data.error?.message ?? "No se pudo cotizar"); setStatus("error"); return; }
      const conditions = chosen.length ? chosen[0]!.conditions : null;
      setQuote({ token: data.quote, total: data.summary?.commercialTotalMinor ?? 0, currency: data.summary?.currency ?? "ARS", conditions });
      setMessage("");
      setStatus("idle");
    } catch (error: any) {
      setMessage(error.message ?? "No se pudo cotizar");
      setStatus("error");
    }
  };

  const confirm = async () => {
    if (!quote) return;
    setStatus("confirming");
    if (identity === "client") {
      try {
        const result = await clientApi.confirmReservation(quote.token);
        setReservationId(result.reservationId);
        setStatus("success");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "No se pudo confirmar");
        setStatus("error");
      }
      return;
    }
    if (identity === "client-mfa") {
      setMessage("Verificá tu identidad con tu aplicación autenticadora antes de reservar.");
      setStatus("error");
      return;
    }
    if (identity === "restricted") {
      setMessage("Esta cuenta está restringida. Contactá al soporte para continuar.");
      setStatus("error");
      return;
    }
    const intent = (window as unknown as { __intent?: { intentId: string; proof: string } }).__intent ?? {
      intentId: crypto.randomUUID(),
      proof: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    };
    (window as unknown as { __intent?: { intentId: string; proof: string } }).__intent = intent;
    const opId = crypto.randomUUID();
    const res = await fetch(`${API}/v1/public/businesses/${businessId}/reservations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operation-id": opId },
      body: JSON.stringify({ quote: quote.token, intentId: intent.intentId, intentProof: intent.proof, contact: { ...contact, email: contact.email.trim() || undefined }, acceptTerms: true }),
    });
    const data = await res.json() as { reservationId?: string; status?: string; error?: { message: string } };
    if (!res.ok || !data.reservationId) { setMessage(data.error?.message ?? "No se pudo confirmar"); setStatus("error"); return; }
    setReservationId(data.reservationId);
    const rec = await fetch(`${API}/v1/public/businesses/${businessId}/booking-operations/${opId}`, { headers: { "x-intent-proof": intent.proof } });
    const recData = await rec.json() as { guestToken?: string };
    if (recData.guestToken) setGuestToken(recData.guestToken);
    setStatus("success");
  };

  const copyToken = async () => {
    if (!guestToken) return;
    try {
      await navigator.clipboard.writeText(guestToken);
      setMessage("Token copiado al portapapeles");
      setTimeout(() => setMessage(""), 2000);
    } catch {
      setMessage("No se pudo copiar el token");
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const totalPrice = quote ? quote.total : selected.reduce((sum, id) => sum + services.find((s) => s.id === id)!.priceMinor, 0);

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1>Reservar turno</h1>
      {businessId && <Link href={`/cursos/publicos?businessId=${encodeURIComponent(businessId)}`}>Ver cursos de la barbería</Link>}
      {!businessId && directoryReady && (
        directoryError ? <p role="alert">No se pudieron cargar las barberías.</p>
          : businesses.length === 0 ? <p>No hay barberías con reservas abiertas.</p>
          : <label>Barbería <select value="" onChange={(event) => setBusinessId(event.target.value)}>
            <option value="">Seleccioná una barbería</option>
            {businesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}
          </select></label>
      )}

      <section style={{ marginTop: 16 }}>
        <h2>1. Servicios publicados</h2>
        {services.length === 0 && (
          <p style={{ color: "#666" }}>{businessId ? "No hay servicios publicados." : "Elegí una barbería para consultar sus servicios."}</p>
        )}
        {services.map((s) => (
          <label key={s.id} style={{ display: "block", marginBottom: 6 }}>
            <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggleService(s.id)} />
            {s.name} — {s.priceMinor / 100} {quote ? quote.currency : "ARS"} · {s.durationMinutes} min
            {s.conditions && <span style={{ fontSize: 12, color: "#666", marginLeft: 8 }}>{s.conditions}</span>}
          </label>
        ))}
        {selected.length > 0 && <p style={{ fontWeight: 600, marginTop: 6 }}>Subtotal estimado: {totalPrice / 100} {quote?.currency ?? "ARS"}</p>}
      </section>

      <section style={{ marginTop: 16 }}>
        <h2>2. Profesional</h2>
        <select value={professional} onChange={(e) => { setProfessional(e.target.value as "ANY" | string); setSlot(null); setQuote(null); }} style={{ width: "100%", marginBottom: 8 }}>
          <option value="ANY">Cualquier barbero</option>
          {professionals.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {professionals.length === 0 && <p style={{ color: "#666", fontSize: 13 }}>No hay profesionales publicados para este negocio.</p>}
      </section>

      <section style={{ marginTop: 16 }}>
        <h2>3. Fecha y horario</h2>
        <input type="date" value={date} min={today} onChange={(e) => { setDate(e.target.value); setSlot(null); setQuote(null); }} style={{ width: "100%", marginBottom: 8 }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {slots.map((s, i) => (
            <button key={i} className="slot-button" onClick={() => { setSlot(s); setQuote(null); }} style={{ background: slot === s ? "#111" : "#eee", color: slot === s ? "#fff" : "#111" }} aria-label={`Horario ${localClock(s.start, businessTimezone)} del ${date}`}>
              {localClock(s.start, businessTimezone)}
            </button>
          ))}
        </div>
        {slots.length === 0 && date && selected.length > 0 && <p style={{ color: "#666" }}>Sin horarios disponibles.</p>}
      </section>

      <section style={{ marginTop: 16 }}>
        <h2>{identity === "client" ? "4. Confirmación" : "4. Datos y confirmación"}</h2>
        {identity === "client" && <p style={{ color: "#0a0", fontSize: 13, marginBottom: 8 }}>Confirmás con los datos verificados de tu cuenta YoungKingz (nombre y teléfono). No necesitamos tu contacto.</p>}
        {identity === "client-mfa" && <p style={{ color: "#d9a755", fontSize: 13, marginBottom: 8 }}>Tu cuenta necesita verificación con el autenticador antes de reservar: <a href="/cliente/seguridad/verificar">verificar ahora</a>.</p>}
        {identity === "restricted" && <p style={{ color: "#e66767", fontSize: 13, marginBottom: 8 }}>Esta cuenta está restringida. Contactá al soporte para continuar.</p>}
        {identity === "guest" && (
          <>
            <input placeholder="Nombre" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} style={{ width: "100%", marginBottom: 8 }} />
            <input placeholder="Teléfono" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} style={{ width: "100%", marginBottom: 8 }} />
            <input placeholder="Email (opcional)" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} style={{ width: "100%", marginBottom: 8 }} />
          </>
        )}
        {!quote && slot && <button onClick={requestQuote} style={{ width: "100%" }}>Cotizar turno</button>}
        {quote && (
          <>
            <p style={{ color: "#0a0", marginBottom: 8 }}>Cotización lista — {quote.total / 100} {quote.currency}. Revisá y confirmá.</p>
            {quote.conditions && <p style={{ fontSize: 13, color: "#444", marginBottom: 8 }}>{quote.conditions}</p>}
            <p style={{ fontSize: 11, color: "#666", marginBottom: 8 }}>Vigente por 5 minutos.</p>
            <button onClick={confirm} disabled={status === "confirming"} style={{ width: "100%" }}>{status === "confirming" ? "Confirmando…" : "Confirmar reserva"}</button>
          </>
        )}
      </section>

      {message && <p style={{ color: "crimson", marginTop: 12 }}>{message}</p>}
      {status === "success" && reservationId && (
        <section style={{ marginTop: 16, padding: 12, background: "#f0fff0", borderRadius: 8 }}>
          <h3>Reserva confirmada</h3>
          <p>ID: {reservationId}</p>
          {identity === "client" ? (
            <p style={{ marginTop: 8, fontSize: 13 }}>Tu reserva quedó vinculada a tu cuenta. La encontrás en <a href="/cliente/mis-cosas">Mis cosas</a>.</p>
          ) : (
            <>
              {guestToken && (
                <>
                  <p style={{ fontSize: 12, marginBottom: 4 }}>
                    <strong>Token privado (no lo compartas):</strong>
                  </p>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                    <span
                      style={{
                        fontSize: 11,
                        wordBreak: "break-all",
                        flex: 1,
                        background: showToken ? "#eee" : "#333",
                        color: showToken ? "#111" : "#eee",
                        padding: "4px 6px",
                        borderRadius: 4,
                        overflow: "hidden",
                      }}
                    >
                      {showToken ? guestToken : "•".repeat(Math.min(guestToken.length, 24))}
                    </span>
                    <button
                      onClick={() => setShowToken((s) => !s)}
                      style={{ padding: "4px 8px", fontSize: 11, border: "1px solid #ccc", borderRadius: 4, cursor: "pointer" }}
                    >
                      {showToken ? "Ocultar" : "Mostrar"}
                    </button>
                    <button onClick={copyToken} style={{ padding: "4px 8px", fontSize: 11, border: "1px solid #ccc", borderRadius: 4, cursor: "pointer", background: "#f0f0f0" }}>
                      Copiar
                    </button>
                  </div>
                  <p style={{ fontSize: 11, color: "#d9a755", marginTop: 2 }}>
                    ⚠️ Quien tenga este token puede acceder a tu reserva. No lo compartas.
                  </p>
                </>
              )}
              <p style={{ marginTop: 8, fontSize: 13 }}>Usá el token para consultar, cancelar o reprogramar en <a href="/mis-reservas">Mis reservas</a>.</p>
            </>
          )}
        </section>
      )}
    </main>
  );
}
