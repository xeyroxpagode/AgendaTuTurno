import type { Completeness, Interval, ReadState } from "./api";

/**
 * H09 · Presentación sin aritmética de negocio.
 *
 * `minor` son unidades monetarias menores (bigint como string). Sólo se
 * convierte la representación para mostrar; NUNCA se suman importes ni se
 * derivan estados en el cliente. `null` se muestra como «Desconocido».
 */
export function formatMinor(minor: string | null, currency: string | null): string {
  if (minor === null) return "Desconocido";
  const raw = minor.trim();
  if (!/^-?\d+$/.test(raw)) return "Desconocido";
  const negative = raw.startsWith("-");
  const digits = raw.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  const major = (digits.length > 2 ? digits.slice(0, -2) : "0").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cents = digits.slice(-2).padStart(2, "0");
  const amount = `${negative ? "-" : ""}${major},${cents}`;
  return currency ? `${amount} ${currency}` : `${amount} (moneda desconocida)`;
}

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "Desconocido" : value.toLocaleString("es-AR");
}

/** Formatea el ISO devuelto por el servidor en la zona del negocio. */
export function formatInstant(iso: string | null, timeZone?: string): string {
  if (!iso) return "Desconocido";
  try {
    return new Intl.DateTimeFormat("es-AR", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Fecha local del servidor: se muestra tal cual, sin reconstruirla en UTC. */
export function formatLocalDate(value: string | null): string {
  return value && value.trim() !== "" ? value : "Desconocido";
}

export function periodLabel(interval: Interval): string {
  return `Desde ${formatLocalDate(interval.from)} · Hasta (exclusivo) ${formatLocalDate(interval.to)} · Zona ${interval.timezone}`;
}

export function stateLabel(state: ReadState): string {
  const labels: Record<ReadState, string> = {
    LOADING: "Cargando",
    SUCCESS: "Correcto",
    ZERO: "Cero real",
    EMPTY: "Sin registros",
    NOT_APPLICABLE: "No aplicable",
    NOT_CONFIGURED: "Sin configurar",
    UNKNOWN: "Desconocido",
    ERROR_RECOVERABLE: "Error recuperable",
    DENIED: "Acceso denegado",
  };
  return labels[state];
}

export function stateTone(state: ReadState): "neutral" | "positive" | "warning" | "danger" {
  if (state === "SUCCESS" || state === "ZERO" || state === "EMPTY") return "positive";
  if (state === "ERROR_RECOVERABLE" || state === "DENIED") return "danger";
  if (state === "UNKNOWN" || state === "NOT_CONFIGURED" || state === "NOT_APPLICABLE") return "warning";
  return "neutral";
}

export function completenessLabel(value: Completeness | undefined): string {
  const labels: Record<Completeness, string> = {
    COMPLETE: "Completa",
    PARTIAL: "Parcial",
    INCOMPLETE: "Incompleta",
    UNKNOWN: "Desconocida",
    NOT_CONFIGURED: "Sin configurar",
  };
  return value ? labels[value] : "Desconocida";
}

export function severityLabel(value: string): string {
  if (value === "HIGH") return "Alta";
  if (value === "MEDIUM") return "Media";
  if (value === "LOW") return "Baja";
  return value || "Desconocida";
}

/**
 * Esquema único de ida/vuelta: `from&to&paymentMethod&status&view&cursor&returnTo`.
 * Los valores se toman de la URL actual; el destino decide qué uid adjunta.
 */
export function contextualHref(
  path: string,
  current: {
    from?: string | null;
    to?: string | null;
    paymentMethod?: string | null;
    status?: string | null;
    type?: string | null;
    view?: string | null;
    cursor?: string | null;
    returnTo?: string | null;
  },
  overrides: Record<string, string | null | undefined> = {},
): string {
  const params = new URLSearchParams();
  const values: Record<string, string | null | undefined> = {
    from: current.from,
    to: current.to,
    paymentMethod: current.paymentMethod,
    status: current.status,
    type: current.type,
    view: current.view,
    cursor: current.cursor,
    returnTo: current.returnTo,
    ...overrides,
  };
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value !== undefined && value !== null && value !== "") params.set(key, value);
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/** Sólo rutas internas: evita redirecciones a origen externo. */
export function safeReturnTo(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}
