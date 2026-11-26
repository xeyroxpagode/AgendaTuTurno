import { ApiError } from "@/lib/api/client";

/** Estados de falla de lectura del cliente, sin convertirlos nunca en cero. */
export type Failure = {
  state: "DENIED" | "ERROR_RECOVERABLE" | "UNKNOWN";
  code: string;
  message: string;
  recoverable: boolean;
};

/**
 * 401/403 → DENIED. 400/5xx → ERROR_RECOVERABLE. Timeout/transporte →
 * UNKNOWN o ERROR_RECOVERABLE. Jamás ZERO ni lista vacía.
 */
export function classifyFailure(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return { state: "DENIED", code: error.code, message: error.message, recoverable: false };
    }
    if (error.status === 400 || error.status >= 500) {
      return { state: "ERROR_RECOVERABLE", code: error.code, message: error.message, recoverable: true };
    }
    return { state: "UNKNOWN", code: error.code, message: error.message, recoverable: true };
  }
  return {
    state: "UNKNOWN",
    code: "TRANSPORT",
    message: error instanceof Error ? error.message : "No se pudo completar la lectura",
    recoverable: true,
  };
}
