"use client";

import { Button, EmptyState, StatusPill } from "@youngkingz/ui";
import type { Block, ReadState } from "./api";
import {
  completenessLabel, formatInstant, periodLabel, stateLabel, stateTone,
} from "./format";

/**
 * H09 · Único renderizador de `ReadState`. `StatusPill`/`EmptyState` son
 * presentacionales (`packages/ui`): el contenedor aporta `role` y `aria-live`.
 * Los errores y la negativa usan `role="alert"`. NINGÚN catch se convierte en
 * lista vacía; `LOADING` se establece explícitamente antes de cada lectura.
 */
export function BlockView<T>({
  title,
  block,
  businessTimezone,
  render,
  onRetry,
}: {
  title: string;
  block: Block<T> | undefined;
  businessTimezone?: string;
  render?: (data: T) => React.ReactNode;
  onRetry?: () => void;
}) {
  const state: ReadState = block?.state ?? "LOADING";
  const recoverable = Boolean(block?.error?.recoverable && onRetry);
  const isAlert =
    state === "ERROR_RECOVERABLE" || state === "DENIED" ||
    (state === "UNKNOWN" && Boolean(block?.error));

  return (
    <section
      className={`report-block report-block-${state.toLowerCase()}`}
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? "assertive" : "polite"}
      aria-busy={state === "LOADING"}
      aria-label={title}
      data-testid={`report-block-${title}`}
    >
      <header className="report-block-head">
        <h3>{title}</h3>
        <StatusPill tone={stateTone(state)}>{stateLabel(state)}</StatusPill>
      </header>
      <p className="report-meta">Completitud: {completenessLabel(block?.completeness)}</p>
      <p className="report-meta">Datos hasta (asOf): {formatInstant(block?.asOf ?? null, businessTimezone)}</p>
      {block?.interval && <p className="report-meta">{periodLabel(block.interval)}</p>}
      {businessTimezone && <p className="report-meta">Zona horaria del negocio: {businessTimezone}</p>}
      {block?.error && (
        <p className="report-error">[{block.error.code}] {block.error.message}</p>
      )}

      <div className="report-block-body">
        {state === "LOADING" && <p className="report-loading">Cargando datos reales…</p>}

        {state === "SUCCESS" && (
          block?.data !== null && block?.data !== undefined && render
            ? render(block.data)
            : <p className="report-unknown">Desconocido: el servidor no entregó datos para este bloque.</p>
        )}

        {state === "ZERO" && (
          block?.data !== null && block?.data !== undefined && render
            ? render(block.data)
            : <EmptyState title="Cero real" detail="La consulta es válida y no hay importes ni registros." />
        )}

        {state === "EMPTY" && (
          <EmptyState title="Sin registros" detail="La consulta terminó correctamente sin resultados." />
        )}

        {state === "NOT_APPLICABLE" && (
          <EmptyState title="No aplicable" detail="Este indicador no corresponde al contexto consultado." />
        )}

        {state === "NOT_CONFIGURED" && (
          <EmptyState title="Sin configurar" detail="La fuente canónica no está configurada; no es un cero." />
        )}

        {state === "UNKNOWN" && (
          <EmptyState
            title="Desconocido"
            detail="No es posible afirmar ausencia ni cero: la fuente no pudo resolverse."
          />
        )}

        {state === "ERROR_RECOVERABLE" && (
          <EmptyState
            title="Error recuperable"
            detail="La lectura falló. Los datos no se sustituyeron por valores vacíos."
            action={recoverable ? <Button type="button" onClick={onRetry}>Reintentar</Button> : undefined}
          />
        )}

        {state === "DENIED" && (
          <EmptyState
            title="Acceso denegado"
            detail="El servidor rechazó esta lectura para el rol o alcance actual."
          />
        )}
      </div>
    </section>
  );
}
