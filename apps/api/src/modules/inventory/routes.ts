import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError } from "@youngkingz/contracts";
import { authorizationService } from "../iam/authorization.js";
import { operationId } from "../system/operations.js";
import * as commands from "./commands.js";
import { inventoryOperationStatus, inventorySnapshot, listCommitments, listMovements, reconcileInventory } from "./queries.js";
const idSchema=z.object({id:z.string().uuid()});
const id=(r:FastifyRequest)=>idSchema.parse(r.params).id;
function actor(r:FastifyRequest){if(!r.actor)throw new DomainError('UNAUTHENTICATED','Authentication required',401);return r.actor;}
export async function registerInventoryRoutes(app:FastifyInstance){
  async function authenticate(r:FastifyRequest){r.actor=await authorizationService.authenticate(r);}
  const options={preHandler:authenticate};
  app.get('/v1/inventory',options,r=>inventorySnapshot(actor(r)));
  app.get('/v1/inventory/movements',options,r=>listMovements(actor(r),r.query));
  app.get('/v1/inventory/commitments',options,r=>listCommitments(actor(r)));
  app.get('/v1/inventory/reconciliation',options,r=>reconcileInventory(actor(r)));
  app.get('/v1/inventory/operations/:id',options,r=>inventoryOperationStatus(actor(r),id(r)));
  app.post('/v1/inventory/items',options,r=>commands.createItem(actor(r),r.body,operationId(r.headers)));
  app.patch('/v1/inventory/items/:id',options,r=>commands.updateItem(actor(r),id(r),r.body,operationId(r.headers)));
  app.post('/v1/inventory/items/:id/lifecycle',options,r=>commands.lifecycleItem(actor(r),id(r),r.body,operationId(r.headers)));
  app.post('/v1/inventory/items/:id/publish',options,r=>commands.publishItem(actor(r),id(r),r.body,operationId(r.headers)));
  app.post('/v1/inventory/locations',options,r=>commands.saveLocation(actor(r),null,r.body,operationId(r.headers)));
  app.patch('/v1/inventory/locations/:id',options,r=>commands.saveLocation(actor(r),id(r),r.body,operationId(r.headers)));
  app.post('/v1/inventory/locations/:id/access',options,r=>{
    const v=z.object({staffMemberId:z.string().uuid(),allowed:z.boolean()}).strict().parse(r.body);
    return commands.setLocationAccess(actor(r),id(r),v.staffMemberId,v.allowed,operationId(r.headers));
  });
  app.post('/v1/inventory/movements',options,r=>commands.createMovement(actor(r),r.body,operationId(r.headers)));
  app.post('/v1/inventory/movements/:id/correct',options,r=>commands.correctMovement(actor(r),id(r),r.body,operationId(r.headers)));
  app.post('/v1/inventory/consumptions',options,r=>commands.consume(actor(r),r.body,operationId(r.headers)));
  app.post('/v1/inventory/counts',options,r=>commands.createCount(actor(r),r.body,operationId(r.headers)));
  app.post('/v1/inventory/counts/:id/adjust',options,r=>commands.adjustCount(actor(r),id(r),r.body,operationId(r.headers)));
  app.post('/v1/inventory/minimums',options,r=>commands.setMinimum(actor(r),r.body,operationId(r.headers)));
}
