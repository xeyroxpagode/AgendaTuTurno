"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Calendar, LogOut, Smartphone, Store, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { ApiError } from "@/lib/api/client";
import { clientApi } from "./api";
import { ClientFrame, Field, Message } from "./ClientFrame";
import { ClientReservations } from "./ClientReservations";

const supabase = createClient();
const enrollmentKey = "ykz-client-enrollment";
const recoveryKey = "ykz-client-recovery";
const e164 = /^\+[1-9]\d{7,14}$/;

function errorMessage(error: unknown): string {
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

async function goByStatus(router: ReturnType<typeof useRouter>) {
  const status = await clientApi.status();
  const destination = status.status === "ACTIVE" ? "/cliente/mis-cosas" :
    status.status === "MFA_SETUP_REQUIRED" ? "/cliente/seguridad/autenticador" :
    status.status === "RECOVERY_CODES_REQUIRED" ? "/cliente/seguridad/codigos" :
    status.status === "RECOVERY_REQUIRED" ? "/cliente/seguridad/autenticador" :
    status.status === "BOOTSTRAP_REQUIRED" ? "/cliente/verificar" : "/cliente/ingresar";
  router.replace(destination);
}

export function Registration() {
  const router = useRouter();
  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "+54", password: "", confirmation: "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!form.firstName.trim()) return setError("Ingresá tu nombre.");
    if (!e164.test(form.phone)) return setError("Usá formato internacional, por ejemplo +54911…");
    if (form.password.length < 10) return setError("La contraseña debe tener al menos 10 caracteres.");
    if (form.password !== form.confirmation) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    const { error: providerError } = await supabase.auth.signUp({ phone: form.phone, password: form.password, options: { channel: "sms" } });
    setBusy(false);
    if (providerError) return setError(providerError.message);
    sessionStorage.setItem(enrollmentKey, JSON.stringify({ firstName: form.firstName.trim(), lastName: form.lastName.trim(), phone: form.phone }));
    router.push("/cliente/verificar");
  }
  return <ClientFrame eyebrow="Cuenta global" title="Creá tu cuenta" description="Tu identidad pertenece a YoungKingZ y funciona con todas las barberías que acredites.">
    <form className="stack" onSubmit={submit} noValidate>
      {error && <Message>{error}</Message>}
      <div className="form-grid"><Field label="Nombre" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} autoComplete="given-name" required /><Field label="Apellido (opcional)" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} autoComplete="family-name" /></div>
      <Field label="Teléfono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\s/g, "") })} inputMode="tel" autoComplete="tel" required />
      <Field label="Contraseña" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" required />
      <Field label="Confirmar contraseña" type="password" value={form.confirmation} onChange={(e) => setForm({ ...form, confirmation: e.target.value })} autoComplete="new-password" required />
      <button className="button" disabled={busy}>{busy ? "Solicitando código…" : "Continuar"}</button>
      <p className="form-foot">¿Ya tenés cuenta? <Link href="/cliente/ingresar">Ingresá</Link></p>
    </form>
  </ClientFrame>;
}

export function PhoneVerification() {
  const router = useRouter(); const [phone, setPhone] = useState(""); const [name, setName] = useState({ firstName: "", lastName: "" });
  const [token, setToken] = useState(""); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [sent, setSent] = useState(false);
  useEffect(() => { const raw = sessionStorage.getItem(enrollmentKey); if (raw) { const value = JSON.parse(raw); setPhone(value.phone); setName(value); } }, []);
  async function verify(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const confirmed = await supabase.auth.verifyOtp({ phone, token, type: "sms" });
    if (confirmed.error) { setBusy(false); return setError("El código no es válido o venció."); }
    const signed = await supabase.auth.signInWithPassword({ phone, password });
    if (signed.error) { setBusy(false); return setError("La contraseña no coincide con la registrada."); }
    try { await clientApi.bootstrap({ firstName: name.firstName, ...(name.lastName ? { lastName: name.lastName } : {}) }); sessionStorage.removeItem(enrollmentKey); router.push("/cliente/seguridad/autenticador"); }
    catch (error) { setError(errorMessage(error)); setBusy(false); }
  }
  async function resend() { setError(""); const result = await supabase.auth.resend({ phone, type: "sms" }); setSent(!result.error); if (result.error) setError("Esperá unos segundos antes de reenviar."); }
  if (!phone) return <ClientFrame eyebrow="Verificación" title="Volvé al registro" description="No encontramos un registro activo en esta pestaña."><Link className="button" href="/cliente/registro">Empezar registro</Link></ClientFrame>;
  return <ClientFrame eyebrow="Verificación telefónica" title="Confirmá que sos vos" description={`Enviamos un SMS a ${phone.slice(0, 4)}••••${phone.slice(-3)}. El código vence según la política del proveedor.`}>
    <form className="stack" onSubmit={verify}>{error && <Message>{error}</Message>}{sent && <Message kind="success">Enviamos un código nuevo.</Message>}<Field label="Código SMS" value={token} onChange={(e) => setToken(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="one-time-code" required /><Field label="Contraseña registrada" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /><button className="button" disabled={busy}>{busy ? "Verificando…" : "Verificar y continuar"}</button><div className="inline client-links"><button type="button" className="link-button" onClick={resend}>Reenviar</button><Link href="/cliente/registro">Cambiar número</Link></div></form>
  </ClientFrame>;
}

export function AuthenticatorSetup() {
  const router = useRouter(); const started = useRef(false); const [factor, setFactor] = useState<{ id: string; qr: string; secret: string } | null>(null); const [code, setCode] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (started.current) return; started.current = true; void (async () => {
    const listed = await supabase.auth.mfa.listFactors();
    for (const item of listed.data?.all?.filter((entry) => entry.status === "unverified") ?? []) await supabase.auth.mfa.unenroll({ factorId: item.id });
    const enrolled = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "YoungKingZ Cliente" });
    if (enrolled.error) return setError(enrolled.error.message);
    setFactor({ id: enrolled.data.id, qr: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret });
  })(); }, []);
  async function confirm(event: React.FormEvent) { event.preventDefault(); if (!factor) return; setBusy(true); setError(""); const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id }); if (challenge.error) { setBusy(false); return setError(challenge.error.message); } const verified = await supabase.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.data.id, code }); setBusy(false); if (verified.error) return setError("El código no coincide. Esperá el siguiente e intentá otra vez."); router.push("/cliente/seguridad/codigos"); }
  return <ClientFrame eyebrow="Paso de seguridad" title="Protegé tu historial" description="Escaneá el QR con una aplicación autenticadora. No volveremos a pedir SMS en cada ingreso."><form className="stack" onSubmit={confirm}>{error && <Message>{error}</Message>}{factor ? <><div className="totp-setup"><img src={factor.qr} alt="Código QR para configurar el autenticador" /><div><span>Clave manual</span><code>{factor.secret}</code></div></div><Field label="Código de 6 dígitos" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="one-time-code" required /><button className="button" disabled={busy}>{busy ? "Comprobando…" : "Confirmar autenticador"}</button></> : !error && <div className="skeleton" aria-label="Preparando autenticador" />}</form></ClientFrame>;
}

export function RecoveryCodes() {
  const router = useRouter(); const loaded = useRef(false); const [batch, setBatch] = useState<{ batchVersion: number; revision: number; codes: string[] } | null>(null); const [ack, setAck] = useState(false); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [copied, setCopied] = useState(false);
  useEffect(() => { if (loaded.current) return; loaded.current = true; void (async () => { try { const status = await clientApi.status(); if (!status.revision) throw new Error("No encontramos el estado de seguridad."); setBatch(await clientApi.issueCodes(status.revision)); } catch (error) { setError(errorMessage(error)); } })(); }, []);
  async function finish() { if (!batch || !ack) return; setBusy(true); try { await clientApi.acknowledgeCodes(batch.batchVersion, batch.revision); router.replace("/cliente/mis-cosas"); } catch (error) { setError(errorMessage(error)); setBusy(false); } }
  async function copy() { if (batch) { await navigator.clipboard.writeText(batch.codes.join("\n")); setCopied(true); setTimeout(() => setCopied(false), 2000); } }
  return <ClientFrame eyebrow="Último paso" title="Guardá tus códigos" description="Cada código sirve una sola vez para recuperar esta misma cuenta si perdés el autenticador."><div className="stack">{error && <Message>{error}</Message>}{batch ? <><div className="recovery-grid" aria-label="Códigos de recuperación">{batch.codes.map((code) => <code key={code}>{code}</code>)}</div><button className="button secondary" onClick={copy}><Copy size={16} /> {copied ? "Copiado!" : "Copiar los ocho"}</button><label className="check-row"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Los guardé en un lugar seguro</label><button className="button" disabled={!ack || busy} onClick={finish}>{busy ? "Activando…" : "Activar mi cuenta"}</button></> : !error && <div className="skeleton" />}</div></ClientFrame>;
}

export function ClientLogin() {
  const router = useRouter(); const [phone, setPhone] = useState("+54"); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(""); const result = await supabase.auth.signInWithPassword({ phone, password }); if (result.error) { setBusy(false); return setError("Teléfono o contraseña incorrectos."); } const assurance = await supabase.auth.mfa.getAuthenticatorAssuranceLevel(); if (assurance.data?.nextLevel === "aal2" && assurance.data.currentLevel !== "aal2") return router.push("/cliente/seguridad/verificar"); try { await goByStatus(router); } catch (error) { setError(errorMessage(error)); setBusy(false); } }
  return <ClientFrame eyebrow="Acceso Cliente" title="Volvé a tus cosas" description="Ingresá con teléfono y contraseña. Tu autenticador protege la información privada."><form className="stack" onSubmit={submit}>{error && <Message>{error}</Message>}<Field label="Teléfono" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\s/g, ""))} autoComplete="tel" /><Field label="Contraseña" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /><button className="button" disabled={busy}>{busy ? "Ingresando…" : "Ingresar"}</button><div className="form-foot"><Link href="/cliente/recuperar">Recuperar acceso</Link><span>·</span><Link href="/cliente/registro">Crear cuenta</Link></div></form></ClientFrame>;
}

export function MfaChallenge() {
  const router = useRouter(); const [code, setCode] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function verify(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(""); const factors = await supabase.auth.mfa.listFactors(); const factor = factors.data?.totp.find((item) => item.status === "verified"); if (!factor) { setBusy(false); return router.replace("/cliente/seguridad/autenticador"); } const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id }); if (challenge.error) { setBusy(false); return setError(challenge.error.message); } const result = await supabase.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.data.id, code }); if (result.error) { setBusy(false); return setError("Código incorrecto. Revisá la hora del dispositivo e intentá otra vez."); } try { await goByStatus(router); } catch (error) { setError(errorMessage(error)); setBusy(false); } }
  return <ClientFrame eyebrow="Segundo factor" title="Abrí tu autenticador" description="Ingresá el código temporal. Nunca te pediremos que compartas la clave del autenticador."><form className="stack" onSubmit={verify}>{error && <Message>{error}</Message>}<Field label="Código de 6 dígitos" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="one-time-code" /><button className="button" disabled={busy}>{busy ? "Verificando…" : "Verificar"}</button><Link className="form-foot" href="/cliente/recuperar">Perdí acceso al autenticador</Link></form></ClientFrame>;
}

export function RecoveryStart() {
  const router = useRouter(); const [phone, setPhone] = useState("+54"); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); await supabase.auth.signInWithOtp({ phone, options: { shouldCreateUser: false } }); sessionStorage.setItem(recoveryKey, phone); setMessage("Si la cuenta existe, enviamos un código."); setBusy(false); setTimeout(() => router.push("/cliente/recuperar/codigo"), 600); }
  return <ClientFrame eyebrow="Recuperación segura" title="Recuperá la cuenta original" description="El SMS por sí solo no abre tu historial. También necesitás uno de tus códigos guardados."><form className="stack" onSubmit={submit}>{message && <Message kind="success">{message}</Message>}<Field label="Teléfono" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\s/g, ""))} /><button className="button" disabled={busy}>{busy ? "Solicitando…" : "Enviar código"}</button><p className="muted">Si perdiste teléfono, autenticador y códigos, solicitá recuperación asistida. Tus datos permanecerán preservados.</p></form></ClientFrame>;
}

export function RecoveryComplete() {
  const router = useRouter(); const [phone, setPhone] = useState(""); const [form, setForm] = useState({ otp: "", recoveryCode: "", password: "", confirmation: "" }); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => setPhone(sessionStorage.getItem(recoveryKey) ?? ""), []);
  async function submit(event: React.FormEvent) { event.preventDefault(); setError(""); if (form.password !== form.confirmation) return setError("Las contraseñas no coinciden."); setBusy(true); const verified = await supabase.auth.verifyOtp({ phone, token: form.otp, type: "sms" }); if (verified.error) { setBusy(false); return setError("El código SMS no es válido o venció."); } try { await clientApi.recover(form.recoveryCode, form.password); sessionStorage.removeItem(recoveryKey); await supabase.auth.signOut(); router.replace("/cliente/ingresar?recovered=1"); } catch (error) { setError(errorMessage(error)); setBusy(false); } }
  if (!phone) return <ClientFrame eyebrow="Recuperación" title="Iniciá de nuevo" description="No encontramos una solicitud activa."><Link className="button" href="/cliente/recuperar">Solicitar código</Link></ClientFrame>;
  return <ClientFrame eyebrow="Doble prueba" title="Confirmá tu recuperación" description="Combinamos el SMS actual con un código entregado al crear la cuenta."><form className="stack" onSubmit={submit}>{error && <Message>{error}</Message>}<Field label="Código SMS" value={form.otp} onChange={(e) => setForm({ ...form, otp: e.target.value.replace(/\D/g, "") })} inputMode="numeric" /><Field label="Código de recuperación" value={form.recoveryCode} onChange={(e) => setForm({ ...form, recoveryCode: e.target.value })} /><Field label="Nueva contraseña" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /><Field label="Confirmar contraseña" type="password" value={form.confirmation} onChange={(e) => setForm({ ...form, confirmation: e.target.value })} /><button className="button" disabled={busy}>{busy ? "Protegiendo cuenta…" : "Recuperar mi cuenta"}</button></form></ClientFrame>;
}

export function ClientPrivateNav({ current }: { current: "things" | "account" | "reservations" }) { return <nav className="client-private-nav" aria-label="Cuenta Cliente"><Link className={current === "things" ? "active" : ""} href="/cliente/mis-cosas"><Store size={18} /> Mis cosas</Link><Link className={current === "reservations" ? "active" : ""} href="/cliente/mis-reservas"><Calendar size={18} /> Mis reservas</Link><Link className={current === "account" ? "active" : ""} href="/cliente/cuenta"><UserRound size={18} /> Mi cuenta</Link></nav>; }

export function ClientThings() {
  const router = useRouter(); const [me, setMe] = useState<Awaited<ReturnType<typeof clientApi.me>> | null>(null); const [links, setLinks] = useState<Awaited<ReturnType<typeof clientApi.links>>>([]); const [error, setError] = useState("");
  useEffect(() => { void Promise.all([clientApi.me(), clientApi.links()]).then(([identity, relationships]) => { setMe(identity); setLinks(relationships); }).catch((error) => { setError(errorMessage(error)); if (error instanceof ApiError && [401, 403].includes(error.status)) router.replace(error.code === "MFA_REQUIRED" ? "/cliente/seguridad/verificar" : "/cliente/ingresar"); }); }, [router]);
  return <main className="client-private"><ClientPrivateNav current="things" /><section className="client-private-content"><p className="eyebrow">Identidad global</p><h1>Mis cosas</h1>{error && <Message>{error}</Message>}{me ? <div className="identity-banner"><div><span>Cuenta YoungKingZ</span><strong>{me.person.firstName} {me.person.lastName}</strong><small>ID {me.accountId}</small></div><span className="yk-pill yk-pill-positive">ACTIVA</span></div> : <div className="skeleton" />}<section className="client-section"><div className="section-head"><div><h2>Barberías acreditadas</h2><p className="muted">Sólo relaciones verificadas; cada negocio conserva sus propios datos.</p></div></div>{links.length ? <div className="relationship-grid">{links.map((link) => <article key={link.id}><Store size={20} /><div><strong>{link.businessName}</strong><span>Vínculo acreditado</span></div></article>)}</div> : <div className="empty-client"><Store size={28} /><h3>Todavía no hay vínculos</h3><p>Cuando una barbería acredite tu relación, aparecerá acá.</p></div>}</section><ClientReservations /></section></main>;
}

export function ClientAccount() {
  const router = useRouter(); const [me, setMe] = useState<Awaited<ReturnType<typeof clientApi.me>> | null>(null); const [security, setSecurity] = useState<Awaited<ReturnType<typeof clientApi.security>> | null>(null); const [sessions, setSessions] = useState<Awaited<ReturnType<typeof clientApi.sessions>>["items"]>([]); const [error, setError] = useState("");
  const [phone, setPhone] = useState(""); const [sms, setSms] = useState(""); const [totp, setTotp] = useState(""); const [phoneStep, setPhoneStep] = useState<"idle" | "verify">("idle");
  const [passwords, setPasswords] = useState({ current: "", next: "", confirmation: "" });
  async function load() { try { const [identity, secure, active] = await Promise.all([clientApi.me(), clientApi.security(), clientApi.sessions()]); setMe(identity); setSecurity(secure); setSessions(active.items); } catch (error) { setError(errorMessage(error)); } }
  useEffect(() => { void load(); }, []);
  async function beginPhone() { if (!security) return; setError(""); try { await clientApi.startPhoneChange(phone, security.revision); const result = await supabase.auth.updateUser({ phone }); if (result.error) throw result.error; setPhoneStep("verify"); } catch (error) { setError(errorMessage(error)); } }
  async function finishPhone() { if (!security) return; setError(""); try { const verified = await supabase.auth.verifyOtp({ phone, token: sms, type: "phone_change" }); if (verified.error) throw verified.error; const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel(); if (aal.data?.currentLevel !== "aal2") { const factors = await supabase.auth.mfa.listFactors(); const factor = factors.data?.totp.find((item) => item.status === "verified"); if (!factor) throw new Error("No encontramos el autenticador."); const challenge = await supabase.auth.mfa.challenge({ factorId: factor.id }); const result = await supabase.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.data!.id, code: totp }); if (result.error) throw result.error; } await clientApi.confirmPhoneChange(security.revision); setPhoneStep("idle"); setPhone(""); setSms(""); setTotp(""); await load(); } catch (error) { setError(errorMessage(error)); } }
  async function revoke(scope: "OTHERS" | "ALL") { try { await clientApi.revokeSessions(scope); if (scope === "ALL") { await supabase.auth.signOut(); router.replace("/cliente/ingresar"); } else await load(); } catch (error) { setError(errorMessage(error)); } }
  async function changePassword(event: React.FormEvent) { event.preventDefault(); setError(""); if (!security) return; if (passwords.next !== passwords.confirmation) return setError("Las contraseñas nuevas no coinciden."); try { await clientApi.changePassword(passwords.current, passwords.next, security.revision); await supabase.auth.signOut(); router.replace("/cliente/ingresar?passwordChanged=1"); } catch (error) { setError(errorMessage(error)); } }
  return <main className="client-private"><ClientPrivateNav current="account" /><section className="client-private-content"><p className="eyebrow">Seguridad y perfil</p><h1>Mi cuenta</h1>{error && <Message>{error}</Message>}{me && <section className="client-section"><div className="account-title"><UserRound /><div><strong>{me.person.firstName} {me.person.lastName}</strong><span>{me.verifiedPhone}</span></div></div></section>}<section className="client-section"><h2>Cambiar teléfono</h2>{phoneStep === "idle" ? <div className="inline-sensitive"><Field label="Nuevo teléfono E.164" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\s/g, ""))} placeholder="+54911…" /><button className="button secondary" onClick={beginPhone} disabled={!e164.test(phone)}><Smartphone size={16} /> Verificar nuevo número</button></div> : <div className="stack compact-form"><Message kind="success">El número anterior sigue vigente hasta confirmar este cambio.</Message><Field label="Código SMS del nuevo número" value={sms} onChange={(e) => setSms(e.target.value.replace(/\D/g, ""))} /><Field label="Código del autenticador" value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} /><button className="button" onClick={finishPhone}>Confirmar cambio</button></div>}</section><section className="client-section"><h2>Cambiar contraseña</h2><form className="stack compact-form" onSubmit={changePassword}><Field label="Contraseña actual" type="password" value={passwords.current} onChange={(e) => setPasswords({ ...passwords, current: e.target.value })} autoComplete="current-password" required /><Field label="Nueva contraseña" type="password" value={passwords.next} onChange={(e) => setPasswords({ ...passwords, next: e.target.value })} autoComplete="new-password" required /><Field label="Confirmar nueva contraseña" type="password" value={passwords.confirmation} onChange={(e) => setPasswords({ ...passwords, confirmation: e.target.value })} autoComplete="new-password" required /><button className="button secondary">Cambiar y cerrar sesiones</button></form></section><section className="client-section"><h2>Sesiones</h2><div className="session-list">{sessions.map((session) => <div className={`session-row ${session.current ? "current" : ""}`} key={session.id}><div><strong>{session.current ? "Este dispositivo" : "Sesión activa"}</strong><p>Última actividad: {new Date(session.lastSeenAt).toLocaleString("es-AR")}</p></div><span className="yk-pill">{session.current ? "ACTUAL" : "ACTIVA"}</span></div>)}</div><div className="session-actions"><button className="button ghost" onClick={() => revoke("OTHERS")}>Cerrar otras sesiones</button><button className="button danger" onClick={() => revoke("ALL")}><LogOut size={16} /> Cerrar todas</button></div></section></section></main>;
}
