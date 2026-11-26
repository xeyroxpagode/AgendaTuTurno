import { Suspense } from "react";
import { ReportingWorkspace } from "@/features/reporting/ReportingWorkspace";

/** R4 · Entrada del OWNER. El gate de rol se aplica además en el servidor API. */
export default function Page() {
  return (
    <Suspense fallback={<div className="content" role="status" aria-live="polite">Cargando resumen…</div>}>
      <ReportingWorkspace />
    </Suspense>
  );
}
