import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * H03.U02 + U03/U04 · Proxy de rutas.
 *
 * STAFF protegido: /team, /account, /context, /availability → /login.
 * CLIENT privado: /cliente/mis-cosas, /cliente/cuenta, /cliente/mis-reservas → /cliente/ingresar.
 * CLIENT público: /cliente/registro, /cliente/ingresar, /cliente/verificar,
 *                 /cliente/recuperar, /cliente/recuperar/codigo.
 *
 * El proxy no reemplaza la autorización real del backend: sólo evita renderizar
 * superficies privadas sin sesión y distingue el destino del redirect según rol.
 */

/** Rutas CLIENT que exigen sesión y destino de redirect propio. */
const CLIENT_PRIVATE_PREFIXES = ["/cliente/mis-cosas", "/cliente/cuenta", "/cliente/mis-reservas"];
/** Rutas CLIENT públicas por contrato: nunca deben redirigirse. */
const CLIENT_PUBLIC_PREFIXES = [
  "/cliente/registro",
  "/cliente/ingresar",
  "/cliente/verificar",
  "/cliente/recuperar",
  "/cliente/recuperar/codigo",
];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:55321",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "local-anon-key-required",
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(values) {
          values.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  const { data: { user } } = await supabase.auth.getUser();
  const pathname = request.nextUrl.pathname;

  // Las superficies públicas CLIENT nunca se protegen, aunque caigan bajo /cliente/*.
  const isClientPublic = CLIENT_PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  const isClientPrivate = !isClientPublic && CLIENT_PRIVATE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  // H07: /cursos es Staff; /cursos/publicos es Discovery público y NO se protege.
  const isCourseStaff = pathname.startsWith("/cursos") && !pathname.startsWith("/cursos/publicos");
  const isStaffProtected =
    isCourseStaff ||
    pathname.startsWith("/team") ||
    pathname.startsWith("/account") ||
    pathname.startsWith("/context") ||
    pathname.startsWith("/agenda") ||
    pathname.startsWith("/availability") ||
    // H03.U06 · Ausencias y atención real: superficies privadas de Staff.
    pathname.startsWith("/absences") ||
    pathname.startsWith("/attendance");

  if (!user && (isStaffProtected || isClientPrivate)) {
    const url = request.nextUrl.clone();
    url.pathname = isClientPrivate ? "/cliente/ingresar" : "/login";
    url.searchParams.set("reason", "expired");
    return NextResponse.redirect(url);
  }
  return response;
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
