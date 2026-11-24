"use client";

import Link from "next/link";
import { Banknote, BriefcaseBusiness, CalendarClock, CalendarRange, CalendarX2, CircleHelp, ClipboardCheck, LogOut, MoreHorizontal, Package, ReceiptText, RotateCcw, ShieldCheck, UserRound, Users, Wallet } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

type Context={role:string;capabilities:string[]};
type ContextItem={roleAssignmentId:string;role:string};
const roleName=(role?:string)=>role==="OWNER"?"Dueño":role==="RECEPTIONIST"?"Recepción":role==="BARBER"?"Barbero":"Verificando acceso";

export function AppShell({children}:{children:React.ReactNode}){
  const [context,setContext]=useState<Context|null>(null);
  const [contextCount,setContextCount]=useState(0);
  const [moreOpen,setMoreOpen]=useState(false);
  const router=useRouter();
  const pathname=usePathname();
  const canSeeTeam=context?.capabilities.some(capability=>capability==="iam.staff.list"||capability==="professionals.read"||capability==="schedules.read")??false;
  const canSeeCatalog=context?.capabilities.includes("catalog.read")??false;
  const canSeeCourses=context?.capabilities.includes("courses.read")??false;
  const canSeeOwnEconomy=context?.capabilities.includes("economy.self.read")??false;
  const canSeeEconomy=context?.capabilities.includes("economy.settlement.read")??false;
  const canSeeClients=context?.capabilities.includes("clients.read")??false;
  const canSeeAvailability=context?.capabilities.includes("availability.read")??false;
  const canSeeAgenda=(context?.capabilities.includes("bookings.read")||context?.capabilities.includes("bookings.self.read"))??false;
  // H03.U06 · Ausencias y atención real: los enlaces aparecen según la
  // capability real del actor (el alcance por profesional lo decide el servidor).
  const canSeeAbsences=(context?.capabilities.includes("absence.read"))??false;
  const isInventory=pathname.startsWith("/inventario")||pathname.startsWith("/insumos");
  const canSeeInventory=context?.capabilities.includes("inventory.read")??false;
  const inventoryHref=context?.role==="BARBER"?"/insumos":"/inventario";
  const canSeeAttendance=(context?.capabilities.includes("attendance.read"))??false;
  // H05 · accesos financieros según capability efectiva. Un BARBER no ve
  // ninguna superficie financiera; Receptionist ve caja, ventas y cobro.
  const canSeeCash=(context?.capabilities.includes("cash.open")||context?.capabilities.includes("cash.close"))??false;
  const canSeeSales=(context?.capabilities.includes("sales.create"))??false;
  const canSeeCheckout=(context?.capabilities.includes("checkout.create"))??false;
  const canSeeObligations=(context?.capabilities.includes("obligations.manage"))??false;
  const canSeeCorrections=(context?.capabilities.includes("corrections.create")||context?.capabilities.includes("money.refund"))??false;

  useEffect(()=>{
    Promise.all([api<Context>("/v1/iam/context"),api<ContextItem[]>("/v1/iam/contexts")]).then(([active,items])=>{
      setContext(active);setContextCount(items.length);
      if(pathname.startsWith("/team")&&!active.capabilities.some(capability=>capability==="iam.staff.list"||capability==="professionals.read"||capability==="schedules.read"))router.replace("/account");
      if(pathname.startsWith("/services")&&!active.capabilities.includes("catalog.read"))router.replace("/account");
      if(pathname.startsWith("/availability")&&!active.capabilities.includes("availability.read"))router.replace("/account");
      if(pathname.startsWith("/absences")&&!active.capabilities.includes("absence.read"))router.replace("/account");
      if(pathname.startsWith("/attendance")&&!active.capabilities.includes("attendance.read"))router.replace("/account");
      if(pathname.startsWith("/context")&&items.length<=1)router.replace("/account");
       if(pathname.startsWith("/cursos")&&!pathname.startsWith("/cursos/publicos")&&!active.capabilities.includes("courses.read"))router.replace("/account");
       if(pathname.startsWith("/account/economia")&&!active.capabilities.includes("economy.self.read"))router.replace("/account");
    }).catch(()=>setContext(null));
  },[pathname,router]);

  useEffect(()=>{const refresh=(event:StorageEvent)=>{if(event.key==="yk-context-revision")router.refresh();};window.addEventListener("storage",refresh);return()=>window.removeEventListener("storage",refresh);},[router]);
  async function logout(){await createClient().auth.signOut({scope:"local"});router.replace("/login");router.refresh();}
  const navClass=(path:string)=>pathname.startsWith(path)?"active":"";

  return <div className={`app-shell ${isInventory?"inventory-shell":""}`}><aside className="sidebar"><Link href={canSeeTeam?"/team":canSeeCatalog?"/services":canSeeClients?"/clients":"/account"} className="brand-mark">Young<span>Kingz</span></Link><nav className="nav" aria-label="Navegación principal">{canSeeTeam&&<Link href="/team" className={navClass("/team")} aria-current={pathname.startsWith("/team")?"page":undefined} aria-label="Equipo"><Users size={18}/><span>Equipo</span></Link>}{canSeeEconomy&&<Link href="/team/economia" className={navClass("/team/economia")} aria-current={pathname.startsWith("/team/economia")?"page":undefined} aria-label="Economía del personal"><Wallet size={18}/><span>Economía</span></Link>}<Link href="/account" className={navClass("/account")} aria-current={pathname.startsWith("/account")?"page":undefined} aria-label="Mi cuenta"><UserRound size={18}/><span>Mi cuenta</span></Link>{canSeeOwnEconomy&&<Link href="/account/economia" className={navClass("/account/economia")} aria-current={pathname.startsWith("/account/economia")?"page":undefined} aria-label="Mi economía"><Wallet size={18}/><span>Mi economía</span></Link>}{contextCount>1&&<Link href="/context" className={navClass("/context")} aria-current={pathname.startsWith("/context")?"page":undefined} aria-label="Cambiar función"><ShieldCheck size={18}/><span>Cambiar función</span></Link>}{canSeeCatalog&&<><span className="nav-section" aria-hidden="true">Más</span><Link href="/services" className={navClass("/services")} aria-current={pathname.startsWith("/services")?"page":undefined} aria-label="Servicios"><BriefcaseBusiness size={18}/><span>Servicios</span></Link>{canSeeCourses&&<Link href="/cursos" className={navClass("/cursos")} aria-current={pathname.startsWith("/cursos")?"page":undefined} aria-label="Cursos"><CalendarRange size={18}/><span>Cursos</span></Link>}</>}{canSeeAgenda&&<Link href="/agenda" className={navClass("/agenda")} aria-current={pathname.startsWith("/agenda")?"page":undefined} aria-label="Agenda"><CalendarRange size={18}/><span>Agenda</span></Link>}{canSeeAvailability&&<Link href="/availability" className={navClass("/availability")} aria-current={pathname.startsWith("/availability")?"page":undefined} aria-label="Disponibilidad"><CalendarClock size={18}/><span>Disponibilidad</span></Link>}{canSeeClients&&<Link href="/clients" className={navClass("/clients")} aria-current={pathname.startsWith("/clients")?"page":undefined} aria-label="Clientes"><Users size={18}/><span>Clientes</span></Link>}{canSeeAbsences&&<Link href="/absences" className={navClass("/absences")} aria-current={pathname.startsWith("/absences")?"page":undefined} aria-label="Ausencias"><CalendarX2 size={18}/><span>Ausencias</span></Link>}{canSeeAttendance&&<Link href="/attendance" className={navClass("/attendance")} aria-current={pathname.startsWith("/attendance")?"page":undefined} aria-label="Atención real"><ClipboardCheck size={18}/><span>Atención</span></Link>}{canSeeInventory&&<Link href={inventoryHref} className={isInventory?"active":""} aria-current={isInventory?"page":undefined} aria-label={context?.role==="BARBER"?"Insumos":"Inventario"}><Package size={18}/><span>{context?.role==="BARBER"?"Insumos":"Inventario"}</span></Link>}{(canSeeCash||canSeeSales||canSeeCheckout||canSeeObligations||canSeeCorrections)&&<span className="nav-section" aria-hidden="true">Finanzas</span>}{canSeeCash&&<Link href="/caja" className={navClass("/caja")} aria-current={pathname.startsWith("/caja")?"page":undefined} aria-label="Caja"><Wallet size={18}/><span>Caja</span></Link>}{canSeeSales&&<Link href="/ventas" className={navClass("/ventas")} aria-current={pathname.startsWith("/ventas")?"page":undefined} aria-label="Ventas"><ReceiptText size={18}/><span>Ventas</span></Link>}{canSeeCheckout&&<Link href="/cobro" className={navClass("/cobro")} aria-current={pathname.startsWith("/cobro")?"page":undefined} aria-label="Cobro"><Banknote size={18}/><span>Cobro</span></Link>}{canSeeObligations&&<Link href="/finanzas" className={navClass("/finanzas")} aria-current={pathname.startsWith("/finanzas")?"page":undefined} aria-label="Obligaciones"><CircleHelp size={18}/><span>Obligaciones</span></Link>}{canSeeCorrections&&<Link href="/correcciones" className={navClass("/correcciones")} aria-current={pathname.startsWith("/correcciones")?"page":undefined} aria-label="Correcciones"><RotateCcw size={18}/><span>Correcciones</span></Link>}{(canSeeCash||canSeeSales||canSeeCheckout)&&<Link href="/cobro-incierto" className={navClass("/cobro-incierto")} aria-current={pathname.startsWith("/cobro-incierto")?"page":undefined} aria-label="Cobro incierto"><CircleHelp size={18}/><span>Cobro incierto</span></Link>}</nav><div className="sidebar-foot"><button className="button ghost" onClick={logout} aria-label="Cerrar sesión"><LogOut size={16}/><span>Cerrar sesión</span></button></div></aside><main className="shell-main"><header className="topbar"><span className="topbar-label">Young Kingz</span>{contextCount>1?<Link href="/context" className="context-chip"><span className="context-dot"/>{roleName(context?.role)}<span className="context-change">Cambiar</span></Link>:<span className="context-chip"><span className="context-dot"/>{roleName(context?.role)}</span>}</header>{children}</main>{isInventory&&<nav className="inv-bottom-nav" aria-label="Navegación móvil">{canSeeAgenda&&<Link href="/agenda"><CalendarRange size={20}/><span>Agenda</span></Link>}{canSeeInventory&&context?.role==="BARBER"&&<Link href="/insumos" aria-current="page"><Package size={20}/><span>Insumos</span></Link>}<button className={context?.role==="BARBER"?"":"active"} aria-current={context?.role!=="BARBER"?"page":undefined} aria-expanded={moreOpen} onClick={()=>setMoreOpen(!moreOpen)}><MoreHorizontal size={20}/><span>Más</span></button></nav>}{isInventory&&moreOpen&&<div className="inv-more-sheet"><button className="button" onClick={()=>setMoreOpen(false)}>Cerrar menú</button>{canSeeInventory&&<Link href={inventoryHref} onClick={()=>setMoreOpen(false)}>{context?.role==="BARBER"?"Insumos":"Inventario"}</Link>}{canSeeTeam&&<Link href="/team">Equipo</Link>}{canSeeClients&&<Link href="/clients">Clientes</Link>}{canSeeAttendance&&<Link href="/attendance">Atención</Link>}<Link href="/account">Mi cuenta</Link></div>}</div>;
}
