"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button, Field, StatusPill } from "@youngkingz/ui";
import {
  reportingApi, validatePeriod,
  type Block, type CommercialResponse, type IndicatorDefinition, type IndicatorId,
  type InterventionsResponse, type OperationalResponse, type OwnerSummaryResponse, type ReportingQuery,
} from "./api";
import { classifyFailure, type Failure } from "./failure";
import { contextualHref, formatInstant } from "./format";
import { BlockView } from "./BlockView";
import { SummaryBlocks } from "./SummaryBlocks";
import { CommercialBlocks } from "./CommercialBlocks";
import { OperationalBlocks } from "./OperationalBlocks";
import { InterventionsPanel } from "./InterventionsPanel";
import { IndicatorDetail } from "./IndicatorDetail";
import type { LinkBuilder } from "./shared";
import "./reporting.css";

type View = "RESUMEN" | "COMERCIAL" | "OPERATIVO" | "INTERVENCIONES" | "INDICADORES";

const VIEWS: View[] = ["RESUMEN", "COMERCIAL", "OPERATIVO", "INTERVENCIONES", "INDICADORES"];
const VIEW_LABEL: Record<View, string> = {
  RESUMEN: "Resumen", COMERCIAL: "Comercial", OPERATIVO: "Operativo",
  INTERVENCIONES: "Intervenciones", INDICADORES: "Indicadores",
};
const INDICATORS: IndicatorId[] = [
  "M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09",
  "M10", "M11", "M12", "M13", "M14", "M15", "M16", "M17",
];
const PAYMENT_METHODS = ["ALL", "CASH", "TRANSFER", "CARD"];
/** Valores aceptados por `reportingCommercialQuerySchema.status`. */
const STATUSES = ["ALL", "CONFIRMED", "OPEN"];

export function ReportingWorkspace() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const paymentMethod = searchParams.get("paymentMethod") ?? "";
  const status = searchParams.get("status") ?? "";
  const cursor = searchParams.get("cursor") ?? "";
  const viewParam = searchParams.get("view") ?? "RESUMEN";
  const view: View = VIEWS.includes(viewParam as View) ? viewParam as View : "RESUMEN";
  const indicatorParam = searchParams.get("indicator") ?? "M01";
  const indicatorId: IndicatorId = INDICATORS.includes(indicatorParam as IndicatorId)
    ? indicatorParam as IndicatorId : "M01";

  const [data, setData] = useState<{ kind: View; value: unknown } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const periodError = validatePeriod(from, to);

  const query: ReportingQuery = useMemo(() => ({
    from: from || undefined,
    to: to || undefined,
    paymentMethod: paymentMethod && paymentMethod !== "ALL" ? paymentMethod : undefined,
    status: status && status !== "ALL" ? status : undefined,
    cursor: cursor || undefined,
  }), [from, to, paymentMethod, status, cursor]);

  const setQuery = useCallback((changes: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value); else params.delete(key);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  /** URL inmediata anterior, sin encadenar `returnTo`. */
  const selfUrl = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("returnTo");
    const suffix = params.toString();
    return `${pathname}${suffix ? `?${suffix}` : ""}`;
  }, [pathname, searchParams]);

  const link: LinkBuilder = useCallback((path, extra) => {
    const [base, incomingQuery = ""] = path.split("?");
    const fromPath = Object.fromEntries(new URLSearchParams(incomingQuery).entries());
    return contextualHref(base, {
      from, to, paymentMethod, status, view, cursor, returnTo: selfUrl,
    }, { ...fromPath, ...extra });
  }, [from, to, paymentMethod, status, view, cursor, selfUrl]);

  useEffect(() => {
    if (periodError) {
      setData(null);
      setFailure({ state: "ERROR_RECOVERABLE", code: "VALIDATION_ERROR", message: periodError, recoverable: true });
      return;
    }
    let alive = true;
    setData(null);   // LOADING explícito en cada bloque
    setFailure(null);
    const load = async () => {
      try {
        let value: unknown;
        if (view === "RESUMEN") value = await reportingApi.ownerSummary({ date: from || undefined });
        else if (view === "COMERCIAL") value = await reportingApi.commercial(query);
        else if (view === "OPERATIVO") value = await reportingApi.operational(query);
        else if (view === "INTERVENCIONES") value = await reportingApi.interventions(query);
        else value = await reportingApi.indicator(indicatorId);
        if (alive) setData({ kind: view, value });
      } catch (error) {
        if (alive) {
          setData(null);
          setFailure(classifyFailure(error));
        }
      }
    };
    void load();
    return () => { alive = false; };
  }, [view, query, from, indicatorId, periodError, reloadToken]);

  const failureBlock = useCallback(<T,>(): Block<T> | undefined => {
    if (!failure) return undefined;
    return {
      state: failure.state, data: null, completeness: "UNKNOWN", asOf: null,
      error: { code: failure.code, message: failure.message, recoverable: failure.recoverable },
    };
  }, [failure]);

  const retry = useCallback(() => setReloadToken((token) => token + 1), []);

  const summary = data?.kind === "RESUMEN" ? data.value as OwnerSummaryResponse : null;
  const commercial = data?.kind === "COMERCIAL" ? data.value as CommercialResponse : null;
  const operational = data?.kind === "OPERATIVO" ? data.value as OperationalResponse : null;
  const interventions = data?.kind === "INTERVENCIONES" ? data.value as InterventionsResponse : null;
  const definition = data?.kind === "INDICADORES" ? data.value as IndicatorDefinition : null;
  const generatedAt = summary?.generatedAt ?? commercial?.generatedAt
    ?? operational?.generatedAt ?? interventions?.generatedAt ?? null;

  const definitionBlock: Block<IndicatorDefinition> | undefined = definition
    ? { state: "SUCCESS", data: definition, completeness: "COMPLETE", asOf: null }
    : failureBlock<IndicatorDefinition>();

  return (
    <div className="content report-content" data-testid="reporting-workspace">
      <header className="page-header">
        <div>
          <p className="eyebrow">Reporting · H09</p>
          <h1 className="page-title">Resumen del Dueño</h1>
          <p>Lecturas reales del Business, sin importes ni estados calculados en el navegador.</p>
        </div>
        <div className="report-header-meta">
          <StatusPill tone={failure?.state === "DENIED" ? "danger" : "neutral"}>
            {failure?.state === "DENIED" ? "Acceso denegado por el servidor" : "Datos del servidor"}
          </StatusPill>
          <span className="muted">Generado: {formatInstant(generatedAt, summary?.businessTimezone)}</span>
        </div>
      </header>

      <form className="report-filters" aria-label="Filtros de reporting" onSubmit={(event) => event.preventDefault()}>
        <Field label={view === "RESUMEN" ? "Jornada (fecha local)" : "Desde"} type="date" value={from}
          onChange={(event) => setQuery({ from: event.target.value, cursor: "" })} />
        {view !== "RESUMEN" && (
          <Field label="Hasta (exclusivo)" type="date" value={to}
            onChange={(event) => setQuery({ to: event.target.value, cursor: "" })} />
        )}
        <Field label="Medio de pago">
          <select value={paymentMethod || "ALL"} onChange={(event) => setQuery({ paymentMethod: event.target.value, cursor: "" })}>
            {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method === "ALL" ? "Todos" : method}</option>)}
          </select>
        </Field>
        <Field label="Estado">
          <select value={status || "ALL"} onChange={(event) => setQuery({ status: event.target.value, cursor: "" })}>
            {STATUSES.map((option) => <option key={option} value={option}>{option === "ALL" ? "Todos" : option}</option>)}
          </select>
        </Field>
        <Button type="button" onClick={() => setQuery({ from: null, to: null, paymentMethod: null, status: null, cursor: null })}>
          Limpiar filtros
        </Button>
      </form>

      {periodError && <p className="report-validation" role="alert">{periodError}</p>}
      {failure?.state === "DENIED" && (
        <p className="report-validation" role="alert">
          [{failure.code}] {failure.message}. La negativa se resolvió en el servidor, no ocultando controles.
        </p>
      )}

      <nav className="subnav" aria-label="Vistas de reporting">
        {VIEWS.map((item) => (
          <button key={item} type="button" className={view === item ? "active" : ""}
            aria-current={view === item ? "page" : undefined}
            onClick={() => setQuery({ view: item, cursor: "" })}>
            {VIEW_LABEL[item]}
          </button>
        ))}
      </nav>

      {view === "RESUMEN" && (
        <SummaryBlocks summary={summary} link={link} failureBlock={failureBlock} />
      )}
      {view === "COMERCIAL" && (
        <CommercialBlocks response={commercial} link={link} failureBlock={failureBlock} />
      )}
      {view === "OPERATIVO" && (
        <OperationalBlocks response={operational} link={link} failureBlock={failureBlock} />
      )}
      {view === "INTERVENCIONES" && (
        <InterventionsPanel response={interventions} link={link} failureBlock={failureBlock} onRetry={retry} />
      )}
      {view === "INDICADORES" && (
        <div className="report-stack">
          <Field label="Indicador">
            <select value={indicatorId} onChange={(event) => setQuery({ indicator: event.target.value })}>
              {INDICATORS.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </Field>
          <BlockView title="Definición reproducible" block={definitionBlock} render={(value) => <IndicatorDetail definition={value} />} />
        </div>
      )}

      <footer className="report-foot">
        <Link className="button ghost" href={link("/historial", { view: "HISTORIAL" })}>Historial operativo</Link>
        <Link className="button ghost" href={link("/resumen", { view: "RESUMEN", cursor: null })}>Volver al resumen</Link>
      </footer>
    </div>
  );
}
