"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button, Field } from "@youngkingz/ui";
import {
  reportingApi, validatePeriod,
  type Block, type HistoryResponse, type ReportingQuery,
} from "./api";
import { classifyFailure, type Failure } from "./failure";
import { contextualHref, formatInstant, safeReturnTo } from "./format";
import { HistoryTable } from "./HistoryTable";
import type { LinkBuilder } from "./shared";
import "./reporting.css";

const HISTORY_TYPES = [
  "SALE_CONFIRMED", "MONEY_CONFIRMED", "CASH_MOVEMENT", "OBLIGATION_CHANGE",
  "ATTENDANCE", "RESERVATION_CHANGE", "ORDER_TRANSITION", "STOCK_MOVEMENT",
  "COURSE_SESSION_EVENT", "ECONOMY_EVENT", "OTHER",
];
const HISTORY_STATES = ["CONFIRMED", "UNCERTAIN", "FAILED", "UNKNOWN", "OPEN", "PARTIAL"];

/** J5 · Historial con filtros en la URL y cursor estable. */
export function HistoryWorkspace() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const type = searchParams.get("type") ?? "";
  const state = searchParams.get("status") ?? "";
  const cursor = searchParams.get("cursor") ?? "";
  const returnTo = searchParams.get("returnTo") ?? "";

  const [response, setResponse] = useState<HistoryResponse | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const periodError = validatePeriod(from, to);
  const query: ReportingQuery = useMemo(() => ({
    from: from || undefined,
    to: to || undefined,
    type: type || undefined,
    state: state || undefined,
    cursor: cursor || undefined,
  }), [from, to, type, state, cursor]);

  const setQuery = useCallback((changes: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value); else params.delete(key);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const selfUrl = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("returnTo");
    const suffix = params.toString();
    return `${pathname}${suffix ? `?${suffix}` : ""}`;
  }, [pathname, searchParams]);

  const link: LinkBuilder = useCallback((path, extra) => {
    const [base, incoming = ""] = path.split("?");
    const fromPath = Object.fromEntries(new URLSearchParams(incoming).entries());
    return contextualHref(base, {
      from, to, type, status: state, cursor, view: "HISTORIAL", returnTo: selfUrl,
    }, { ...fromPath, ...extra });
  }, [from, to, type, state, cursor, selfUrl]);

  useEffect(() => {
    if (periodError) {
      setResponse(null);
      setFailure({ state: "ERROR_RECOVERABLE", code: "VALIDATION_ERROR", message: periodError, recoverable: true });
      return;
    }
    let alive = true;
    setResponse(null);   // LOADING explícito
    setFailure(null);
    const load = async () => {
      try {
        const value = await reportingApi.history(query);
        if (alive) setResponse(value);
      } catch (error) {
        if (alive) {
          setResponse(null);
          setFailure(classifyFailure(error));
        }
      }
    };
    void load();
    return () => { alive = false; };
  }, [query, periodError, reloadToken]);

  const failureBlock = useCallback(<T,>(): Block<T> | undefined => {
    if (!failure) return undefined;
    return {
      state: failure.state, data: null, completeness: "UNKNOWN", asOf: null,
      error: { code: failure.code, message: failure.message, recoverable: failure.recoverable },
    };
  }, [failure]);

  return (
    <div className="content report-content" data-testid="history-workspace">
      <header className="page-header">
        <div>
          <p className="eyebrow">Reporting · H09</p>
          <h1 className="page-title">Historial operativo</h1>
          <p>Hechos autorizados de dominios propios, con orden estable y retorno contextual.</p>
        </div>
        <span className="muted">Generado: {formatInstant(response?.generatedAt ?? null)}</span>
      </header>

      <form className="report-filters" aria-label="Filtros del historial" onSubmit={(event) => event.preventDefault()}>
        <Field label="Desde" type="date" value={from} onChange={(event) => setQuery({ from: event.target.value, cursor: "" })} />
        <Field label="Hasta (exclusivo)" type="date" value={to} onChange={(event) => setQuery({ to: event.target.value, cursor: "" })} />
        <Field label="Tipo de hecho">
          <select value={type} onChange={(event) => setQuery({ type: event.target.value, cursor: "" })}>
            <option value="">Todos</option>
            {HISTORY_TYPES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </Field>
        <Field label="Estado">
          <select value={state} onChange={(event) => setQuery({ status: event.target.value, cursor: "" })}>
            <option value="">Todos</option>
            {HISTORY_STATES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </Field>
        <Button type="button" onClick={() => setQuery({ from: null, to: null, type: null, status: null, cursor: null })}>
          Limpiar filtros
        </Button>
      </form>

      {periodError && <p className="report-validation" role="alert">{periodError}</p>}
      {failure?.state === "DENIED" && (
        <p className="report-validation" role="alert">[{failure.code}] {failure.message}</p>
      )}

      <HistoryTable response={response} link={link} failureBlock={failureBlock}
        onCursor={(next) => setQuery({ cursor: next })}
        onRetry={() => setReloadToken((token) => token + 1)} />

      <footer className="report-foot">
        <Link className="button ghost" href={safeReturnTo(returnTo, "/resumen")}>Volver al origen</Link>
        <Link className="button ghost" href={link("/resumen", { view: "RESUMEN" })}>Ir al resumen</Link>
      </footer>
    </div>
  );
}
