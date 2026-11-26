"use client";

import { ReportDetails } from "./shared";
import type { IndicatorDefinition } from "./api";

/** CAP-09-06 · Definición reproducible, sin datos de negocio. */
export function IndicatorDetail({ definition }: { definition: IndicatorDefinition }) {
  return (
    <div className="report-stack">
      <h3>{definition.id} · {definition.name}</h3>
      <ReportDetails items={[
        { label: "Dominio", value: definition.domain },
        { label: "Fuente física", value: definition.source },
        { label: "Grano del hecho", value: definition.grain },
        { label: "Fórmula", value: definition.formula },
        { label: "Timestamp semántico", value: definition.timestampSemantic },
        { label: "Intervalo", value: definition.interval },
        { label: "Alcances", value: definition.scopes },
        { label: "Estados de calidad", value: definition.qualityStates },
      ]} />
    </div>
  );
}
