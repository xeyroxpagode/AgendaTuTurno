import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { acknowledgeRecoveryCodesSchema, changeClientPasswordSchema, clientBootstrapSchema, completeClientRecoverySchema, confirmPhoneChangeSchema, issueRecoveryCodesSchema, revokeClientSessionsSchema } from "@youngkingz/contracts";
import { resolveProviderIdentity } from "./provider.js";
import { acknowledgeRecoveryCodes, bootstrapClient, changeClientPassword, clientLinks, clientMe, clientSecurity, clientStatus, completeRecovery, confirmPhoneChange, issueRecoveryCodes, listClientSessions, operationIdFromHeader, resolveClientPrincipal, revokeClientSessions, startPhoneChange } from "./service.js";

const startPhoneChangeSchema = z.object({ newPhone: z.string().regex(/^\+[1-9]\d{7,14}$/), expectedRevision: z.number().int().positive() }).strict();

export async function registerClientAuthRoutes(app: FastifyInstance): Promise<void> {
  const provider = (request: FastifyRequest) => resolveProviderIdentity(request);

  app.post("/v1/client-auth/bootstrap", async (request) => bootstrapClient(await provider(request), clientBootstrapSchema.parse(request.body)));
  app.get("/v1/client-auth/status", async (request) => clientStatus(await provider(request)));
  app.post("/v1/client-auth/recovery-codes/issue", async (request) => {
    const input = issueRecoveryCodesSchema.parse(request.body);
    return issueRecoveryCodes(await provider(request), input.expectedRevision);
  });
  app.post("/v1/client-auth/recovery-codes/ack", async (request) => {
    const input = acknowledgeRecoveryCodesSchema.parse(request.body);
    return acknowledgeRecoveryCodes(await provider(request), input.batchVersion, input.expectedRevision);
  });
  app.post("/v1/client-auth/recovery/complete", async (request) => completeRecovery(await provider(request), completeClientRecoverySchema.parse(request.body), operationIdFromHeader(request.headers["x-operation-id"])));

  app.post("/v1/client-auth/phone-change/start", async (request) => {
    const identity = await provider(request); const principal = await resolveClientPrincipal(identity); const input = startPhoneChangeSchema.parse(request.body);
    return startPhoneChange(identity, principal, input.newPhone, input.expectedRevision);
  });
  app.post("/v1/client-auth/phone-change/confirm", async (request) => {
    const identity = await provider(request); const principal = await resolveClientPrincipal(identity, true); const input = confirmPhoneChangeSchema.parse(request.body);
    return confirmPhoneChange(identity, principal, input.expectedRevision);
  });
  app.post("/v1/client-auth/password-change", async (request) => {
    const identity = await provider(request); const principal = await resolveClientPrincipal(identity);
    return changeClientPassword(identity, principal, changeClientPasswordSchema.parse(request.body));
  });

  app.get("/v1/client/me", async (request) => { const identity = await provider(request); return clientMe(await resolveClientPrincipal(identity)); });
  app.get("/v1/client/me/security", async (request) => { const identity = await provider(request); return clientSecurity(await resolveClientPrincipal(identity)); });
  app.get("/v1/client/me/sessions", async (request) => { const identity = await provider(request); return listClientSessions(await resolveClientPrincipal(identity)); });
  app.post("/v1/client/me/sessions/revoke", async (request) => { const identity = await provider(request); return revokeClientSessions(identity, await resolveClientPrincipal(identity), revokeClientSessionsSchema.parse(request.body)); });
  app.get("/v1/client/me/links", async (request) => { const identity = await provider(request); return clientLinks(await resolveClientPrincipal(identity)); });
}
