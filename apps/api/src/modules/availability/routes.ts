import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError, availabilitySearchSchema, localDateSchema } from "@youngkingz/contracts";
import { authorizationService, type Actor } from "../iam/authorization.js";
import { operationId } from "../system/operations.js";
import {
  getBookingPolicy, getBookingPolicyHistory, getBusinessHours, listBusinessDateExceptions,
  listStaffDateExceptions, replaceBookingPolicy, replaceBusinessDateException,
  replaceBusinessHours, replaceStaffDateException, removeBusinessDateException, removeStaffDateException
} from "./configuration.js";
import { getOwnAvailability, searchAvailability } from "./queries.js";
import { evaluateImpact, listCommitmentConflicts } from "./impact.js";

const businessParam=z.object({businessId:z.string().uuid()});
const staffParam=z.object({staffId:z.string().uuid()});
const staffDateParam=z.object({staffId:z.string().uuid(),date:localDateSchema});
const businessDateParam=z.object({date:localDateSchema});

export async function registerAvailabilityRoutes(app:FastifyInstance){
  async function authenticate(request:FastifyRequest){request.actor=await authorizationService.authenticate(request);}
  function actor(request:FastifyRequest):Actor{if(!request.actor)throw new DomainError("UNAUTHENTICATED","Authentication required",401);return request.actor;}
  function requireCapability(request:FastifyRequest,capability:Parameters<typeof authorizationService.require>[1]){const value=actor(request);authorizationService.require(value,capability);return value;}

  app.get("/v1/businesses/current/hours",{preHandler:authenticate,schema:{tags:["availability"],summary:"Get Business Hours"}},async request=>getBusinessHours(requireCapability(request,"availability.read")));
  app.put("/v1/businesses/current/hours",{preHandler:authenticate,schema:{tags:["availability"],summary:"Replace Business Hours"}},async request=>replaceBusinessHours(requireCapability(request,"availability.manage"),request.body,operationId(request.headers)));

  app.get("/v1/businesses/current/booking-policy",{preHandler:authenticate,schema:{tags:["availability"],summary:"Get current Booking Policy"}},async request=>getBookingPolicy(requireCapability(request,"availability.read")));
  app.put("/v1/businesses/current/booking-policy",{preHandler:authenticate,schema:{tags:["availability"],summary:"Publish a Booking Policy version"}},async request=>replaceBookingPolicy(requireCapability(request,"availability.manage"),request.body,operationId(request.headers)));
  app.get("/v1/businesses/current/booking-policy/history",{preHandler:authenticate,schema:{tags:["availability"],summary:"Get Booking Policy history"}},async request=>getBookingPolicyHistory(requireCapability(request,"availability.read")));

  app.get("/v1/businesses/current/date-exceptions",{preHandler:authenticate,schema:{tags:["availability"],summary:"List Business date exceptions"}},async request=>listBusinessDateExceptions(requireCapability(request,"availability.read")));
  app.put("/v1/businesses/current/date-exceptions/:date",{preHandler:authenticate,schema:{tags:["availability"],summary:"Replace a Business date exception"}},async request=>replaceBusinessDateException(requireCapability(request,"availability.manage"),businessDateParam.parse(request.params).date,request.body,operationId(request.headers)));
  app.delete("/v1/businesses/current/date-exceptions/:date",{preHandler:authenticate,schema:{tags:["availability"],summary:"Remove a Business date exception"}},async request=>removeBusinessDateException(requireCapability(request,"availability.manage"),businessDateParam.parse(request.params).date,request.body,operationId(request.headers)));

  app.get("/v1/staff/:staffId/date-exceptions",{preHandler:authenticate,schema:{tags:["availability"],summary:"List Staff date exceptions"}},async request=>listStaffDateExceptions(requireCapability(request,"availability.read"),staffParam.parse(request.params).staffId));
  app.put("/v1/staff/:staffId/date-exceptions/:date",{preHandler:authenticate,schema:{tags:["availability"],summary:"Replace a Staff date exception"}},async request=>{const params=staffDateParam.parse(request.params);return replaceStaffDateException(requireCapability(request,"availability.manage"),params.staffId,params.date,request.body,operationId(request.headers));});
  app.delete("/v1/staff/:staffId/date-exceptions/:date",{preHandler:authenticate,schema:{tags:["availability"],summary:"Remove a Staff date exception"}},async request=>{const params=staffDateParam.parse(request.params);return removeStaffDateException(requireCapability(request,"availability.manage"),params.staffId,params.date,request.body,operationId(request.headers));});

  app.post("/v1/public/businesses/:businessId/availability/search",{schema:{tags:["availability"],summary:"Search public availability"}},async request=>searchAvailability(businessParam.parse(request.params).businessId,request.body));
  app.post("/v1/availability/me/search",{preHandler:authenticate,schema:{tags:["availability"],summary:"Search my operational availability"}},async request=>{const a=requireCapability(request,"availability.self.read");const body=availabilitySearchSchema.omit({professionalPreference:true}).parse(request.body);return getOwnAvailability(a.businessId,a.staffMemberId,body);});
  app.post("/v1/availability/impacts/evaluate",{preHandler:authenticate,schema:{tags:["availability"],summary:"Evaluate availability impact without writing"}},async request=>evaluateImpact(requireCapability(request,"availability.impacts.read"),request.body));
  app.get("/v1/availability/conflicts",{preHandler:authenticate,schema:{tags:["availability"],summary:"List operational commitment conflicts"}},async request=>listCommitmentConflicts(requireCapability(request,"availability.impacts.read")));
}
