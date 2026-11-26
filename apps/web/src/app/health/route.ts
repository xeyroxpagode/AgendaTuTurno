import { NextResponse } from "next/server";

/** Cloud health check: no depende de Supabase ni de la API. */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { status: "ok", service: "youngkingz-web", time: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
}
