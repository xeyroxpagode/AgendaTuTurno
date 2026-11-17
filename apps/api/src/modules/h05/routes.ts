import type { FastifyRequest } from "fastify";
import { DomainError } from "@youngkingz/contracts";
import { authorizationService } from "../iam/authorization.js";

/**
 * H05 · utilidades de routing compartidas.
 *
 * Todos los endpoints H05 requieren el MISMO preHandler de autenticación que
 * el resto del monorepo: el Actor se construye en servidor a partir del
 * bearer token y de la sesión operativa, nunca a partir del cuerpo de la
 * petición. Deny-by-default: una capability ausente produce 403.
 */
export async function authenticateH05(request: FastifyRequest): Promise<void> {
  request.actor = await authorizationService.authenticate(request);
}

export function actorOf(request: FastifyRequest) {
  if (!request.actor) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
  return request.actor;
}

export const h05Route = { preHandler: authenticateH05 };
