"use client";

import Link from "next/link";
import { StatusPill } from "@youngkingz/ui";
import type { Intervention } from "./api";
import { formatCount, formatInstant, severityLabel } from "./format";

/** Construye destinos con el esquema único `from&to&paymentMethod&status&view&cursor&returnTo`. */
export type LinkBuilder = (
  path: string,
  extra?: Record<string, string | null | undefined>,
) => string;

export function ReportTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: Array<Array<React.ReactNode>>;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="report-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="report-table">
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReportDetails({
  items,
}: {
  items: Array<{ label: string; value: React.ReactNode }>;
}) {
  return (
    <dl className="report-details">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function InterventionCards({
  items,
  link,
  businessTimezone,
}: {
  items: Intervention[];
  link: LinkBuilder;
  businessTimezone?: string;
}) {
  return (
    <ul className="report-causes">
      {items.map((item) => (
        <li key={item.id} className="report-cause">
          <div className="report-cause-head">
            <strong>{item.causeType}</strong>
            <StatusPill tone={item.severity === "HIGH" ? "danger" : item.severity === "MEDIUM" ? "warning" : "neutral"}>
              Severidad {severityLabel(item.severity)}
            </StatusPill>
          </div>
          <p>{item.detail ?? "Sin detalle informado por el servidor."}</p>
          <ReportDetails items={[
            { label: "Tipo", value: item.type },
            { label: "Dominio", value: item.domain },
            { label: "Objeto", value: item.objectId },
            { label: "Detectado", value: formatInstant(item.detectedAt, businessTimezone) },
          ]} />
          <div className="report-cause-actions">
            {item.destination
              ? <Link className="button secondary" href={link(item.destination)}>Abrir origen</Link>
              : <span className="muted">Sin enlace: se requiere {item.capabilityRequired ?? "otra capability"}.</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CountText({ value }: { value: number | null | undefined }) {
  return <>{formatCount(value)}</>;
}
