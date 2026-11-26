import { Suspense } from "react";
import { HistoryWorkspace } from "@/features/reporting/HistoryWorkspace";

/** R4 · Historial operativo con cursor y retorno contextual. */
export default function Page() {
  return (
    <Suspense fallback={<div className="content" role="status" aria-live="polite">Cargando historial…</div>}>
      <HistoryWorkspace />
    </Suspense>
  );
}
