import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../../apps/api/src/app";
import { seedStaffAgendaBusiness } from "./staff-agenda-fixtures";
import { database } from "../../../apps/api/src/lib/runtime";

const supabaseUrl=process.env.SUPABASE_URL??"http://127.0.0.1:55321";
const anonKey=process.env.SUPABASE_ANON_KEY??"";
let app:FastifyInstance;
let ownerToken="",receptionToken="",barberToken="";

async function signIn(email:string,password:string){
  const client=createClient(supabaseUrl,anonKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const result=await client.auth.signInWithPassword({email,password});
  if(result.error)throw result.error;
  return result.data.session!.access_token;
}

const request=(token:string,method:string,url:string,payload?:unknown)=>app.inject({method,url,headers:{authorization:`Bearer ${token}`,"x-operation-id":randomUUID(),...(payload===undefined?{}:{"content-type":"application/json"})},payload});

beforeAll(async()=>{
  if(!anonKey)throw new Error("SUPABASE_ANON_KEY is required");
  app=await buildApp();
  const fixture = await seedStaffAgendaBusiness("Disponibilidad API QA");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const createActor = async (accountId: string) => {
    const email = `availability-${accountId}@example.test`;
    const password = `Qa-${randomUUID()}!x`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    await database.client`update iam.user_accounts set auth_user_id=${data.user.id}, verified_email=${email} where id=${accountId}`;
    return signIn(email, password);
  };
  [ownerToken,receptionToken,barberToken]=await Promise.all([
    createActor(fixture.ownerAccount), createActor(fixture.receptionistAccount), createActor(fixture.barberAccount)
  ]);
});
afterAll(async()=>{await app.close();});

describe("H03.U03 API authorization",()=>{
  it("allows Owner and Receptionist reads but rejects Barber and Receptionist management",async()=>{
    expect((await request(ownerToken,"GET","/v1/businesses/current/hours")).statusCode).toBe(200);
    expect((await request(receptionToken,"GET","/v1/businesses/current/hours")).statusCode).toBe(200);
    expect((await request(barberToken,"GET","/v1/businesses/current/hours")).statusCode).toBe(403);
    const denied=await request(receptionToken,"PUT","/v1/businesses/current/hours",{expectedRevision:0,week:{MONDAY:[],TUESDAY:[],WEDNESDAY:[],THURSDAY:[],FRIDAY:[],SATURDAY:[],SUNDAY:[]}});
    expect(denied.statusCode).toBe(403);
  });

  it("allows Barber only through the self availability authority",async()=>{
    // Fecha dentro del horizonte: con policy vigente devuelve 200/409 y sin policy devuelve 409.
    // Usar una fecha fija en el pasado hacía el test dependiente de la fecha de ejecución.
    const future=new Date(Date.now()+3*86_400_000);
    const futureDate=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires",year:"numeric",month:"2-digit",day:"2-digit"}).format(future);
    const result=await request(barberToken,"POST","/v1/availability/me/search",{serviceIds:["b0000000-0000-4000-8000-000000000001"],fromDate:futureDate,throughDate:futureDate});
    expect([200,409]).toContain(result.statusCode);
    expect((await request(barberToken,"POST","/v1/availability/impacts/evaluate",{kind:"STAFF_SCHEDULE",removedServiceIds:[]})).statusCode).toBe(403);
  });

  it("fails a public tenant without Booking Policy closed and without leaking SQL",async()=>{
    const businessId=randomUUID();
    await database.client`insert into business.businesses(id,provisioning_key,display_name,timezone,status) values (${businessId},${`api-${businessId}`},'No policy','UTC','ACTIVE')`;
    const response=await app.inject({method:"POST",url:`/v1/public/businesses/${businessId}/availability/search`,headers:{"content-type":"application/json"},payload:{serviceIds:["b0000000-0000-4000-8000-000000000001"],fromDate:"2026-11-05",throughDate:"2026-11-05",professionalPreference:{type:"ANY"}}});
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({error:{code:"BOOKING_POLICY_MISSING"}});
    expect(response.body).not.toContain("postgres");
    await database.client`delete from business.businesses where id=${businessId}`;
  });
});
