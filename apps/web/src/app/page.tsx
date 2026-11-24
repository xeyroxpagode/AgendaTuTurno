import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarClock, CalendarRange, Scissors, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

const apiUrl=process.env.NEXT_PUBLIC_API_URL??"http://127.0.0.1:4100";
async function check(path:string,token:string){try{return await fetch(`${apiUrl}${path}`,{headers:{authorization:`Bearer ${token}`},cache:"no-store"});}catch{return null;}}

/**
 * H03.U02 + U04 · Entrada multirole.
 * La landing es única: ofrece contexto Cliente, contexto Staff y la reserva
 * pública U04 sin duplicar navegación ni eliminar la reserva sin cuenta.
 */
export default async function Home(){
  const supabase=await createClient();
  const {data:{user}}=await supabase.auth.getUser();
  if(!user)return <main className="context-entry"><div><p className="eyebrow">YOUNGKINGZ</p><h1>Elegí cómo querés entrar</h1><p>La cuenta es una sola; los contextos y permisos permanecen separados.</p><div className="context-entry-grid"><Link href="/cliente/ingresar"><UserRound/><strong>Soy Cliente</strong><span>Mi identidad, seguridad y barberías acreditadas</span></Link><Link href="/login"><Scissors/><strong>Soy Staff</strong><span>Gestión del negocio y responsabilidades asignadas</span></Link><Link href="/reservar"><CalendarClock/><strong>Reservar un turno</strong><span>Reserva pública sin cuenta; gestionás el acceso con tu token</span></Link><Link href="/cursos/publicos"><CalendarRange/><strong>Ver cursos</strong><span>Ofertas y contacto de la barbería</span></Link></div></div></main>;
  const {data:{session}}=await supabase.auth.getSession();
  if(!session)redirect("/cliente/ingresar");
  const [clientResponse,staffResponse]=await Promise.all([check("/v1/client-auth/status",session.access_token),check("/v1/iam/me",session.access_token)]);
  const clientStatus=clientResponse?.ok?await clientResponse.json() as {status:string}:null;
  const isClient=clientStatus?.status==="ACTIVE";
  const isStaff=staffResponse?.ok===true;
  if(isClient&&!isStaff)redirect("/cliente/mis-cosas");
  if(isStaff&&!isClient)redirect("/team");
  if(!isClient&&!isStaff){
    if(clientStatus?.status==="MFA_SETUP_REQUIRED"||clientStatus?.status==="RECOVERY_REQUIRED")redirect("/cliente/seguridad/autenticador");
    if(clientStatus?.status==="RECOVERY_CODES_REQUIRED")redirect("/cliente/seguridad/codigos");
    redirect("/cliente/ingresar");
  }
  return <main className="context-entry"><div><p className="eyebrow">Identidad multirol</p><h1>¿Qué contexto querés usar?</h1><p>Elegir uno no transfiere permisos al otro.</p><div className="context-entry-grid"><Link href="/cliente/mis-cosas"><UserRound/><strong>Contexto Cliente</strong><span>Recursos personales, reservas y vínculos acreditados</span></Link><Link href="/team"><Scissors/><strong>Contexto Staff</strong><span>Acceso del Business y rol activo</span></Link><Link href="/reservar"><CalendarClock/><strong>Reservar un turno</strong><span>Reserva pública en el negocio que elijas</span></Link></div></div></main>;
}
