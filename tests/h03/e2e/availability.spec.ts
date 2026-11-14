import { expect, test } from "@playwright/test";
import postgres from "postgres";

const businessId="10000000-0000-4000-8000-000000000001";
const serviceId="b0000000-0000-4000-8000-000000000001";
let db:ReturnType<typeof postgres>;
let queryDate="";

test.setTimeout(90_000);

test.beforeAll(async()=>{
  db=postgres(process.env.DATABASE_URL??"postgresql://postgres:postgres@127.0.0.1:55322/postgres",{prepare:false});
  const owner=(await db`select ua.id from iam.user_accounts ua join iam.persons p on p.id=ua.person_id where ua.verified_email='owner@youngkingz.local'`)[0]!;
  const config=(await db`insert into business.business_hours_configs(business_id) values (${businessId}) on conflict(business_id) do update set business_id=excluded.business_id returning id`)[0]!;
  await db`delete from business.business_hours_intervals where business_id=${businessId}`;
  for(let weekday=1;weekday<=7;weekday++)await db`insert into business.business_hours_intervals(business_id,config_id,weekday,start_minute,end_minute) values (${businessId},${config.id},${weekday},600,1200)`;
  const state=(await db`select revision from business.booking_policy_states where business_id=${businessId}`)[0];
  if(!state){
    const version=(await db`insert into business.booking_policy_versions(business_id,version_number,public_booking_enabled,horizon_calendar_dates,min_lead_minutes,start_step_minutes,cancel_cutoff_minutes,reschedule_cutoff_minutes,created_by) values (${businessId},1,true,30,0,30,120,120,${owner.id}) returning id`)[0]!;
    await db`insert into business.booking_policy_states(business_id,current_version_id) values (${businessId},${version.id})`;
  }
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Argentina/Buenos_Aires",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(Date.now()+86_400_000));
  const get=(type:string)=>parts.find(part=>part.type===type)!.value;
  queryDate=`${get("year")}-${get("month")}-${get("day")}`;
});

test.afterAll(async()=>{await db.end();});

async function login(page:import("@playwright/test").Page){
  await page.goto("/login");
  await page.getByLabel("Correo").fill("owner@youngkingz.local");
  await page.getByLabel("Contraseña").fill("YoungKingZ-Owner-2026!");
  await page.getByRole("button",{name:"Ingresar"}).click();
  await expect(page).toHaveURL(/\/team/);
}

test("H03.U03 Owner manages policy and queries real availability",async({page})=>{
  await page.goto("/availability");
  await expect(page).toHaveURL(/\/login\?reason=expired/);
  await login(page);
  await page.getByRole("link",{name:"Disponibilidad"}).click();
  await expect(page.getByRole("heading",{name:"Motor de disponibilidad"})).toBeVisible();

  await page.getByRole("tab",{name:"Política"}).click();
  const cutoff=page.getByLabel("Límite de cancelación");
  const changedCutoff=String(Number(await cutoff.inputValue())+1);
  await cutoff.press("ArrowUp");
  await cutoff.blur();
  await expect(cutoff).toHaveValue(changedCutoff);
  await page.getByRole("button",{name:"Guardar nueva versión"}).click();
  await expect(page.getByRole("status")).toContainText("Nueva versión publicada");
  await expect(page.getByText(/Versión 2|Versión 3|Versión 4/).first()).toBeVisible();

  await page.getByRole("tab",{name:"Consulta"}).click();
  await page.getByLabel("Fecha").fill(queryDate);
  await page.getByLabel("Corte clásico").check();
  await page.getByRole("button",{name:"Consultar disponibilidad"}).click();
  await expect(page.locator(".availability-slot").first()).toBeVisible();
  expect(await db`select count(*)::int count from availability.resource_allocations where business_id=${businessId}`).toEqual([{count:0}]);
  expect((await db`select id from catalog.services where id=${serviceId}`).length).toBe(1);
});

test("H03.U03 workspace remains usable at mobile width",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await login(page);
  await page.goto("/availability");
  await expect(page.getByRole("heading",{name:"Motor de disponibilidad"})).toBeVisible();
  await expect(page.getByRole("tablist",{name:"Secciones de disponibilidad"})).toBeVisible();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
