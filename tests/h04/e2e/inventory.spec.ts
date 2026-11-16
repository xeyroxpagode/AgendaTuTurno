import { test,expect,type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { createOwnerContext,signIn } from '../../h01/e2e/helpers';
let ctx:Awaited<ReturnType<typeof createOwnerContext>>;
let reception={email:'',staffId:'',accountId:'',authId:''},barber={email:'',staffId:'',accountId:'',authId:''};
let ownerToken='',receptionToken='',barberToken='',bar:string,deposit:string,kit:string;
const password='YoungKingz-E2E!26';
test.setTimeout(45000);
test.describe.configure({mode:'serial'});
async function staff(role:string,name:string){
  const email=`h04-${role.toLowerCase()}-${ctx.suffix}@example.com`;const r=await ctx.admin.auth.admin.createUser({email,password,email_confirm:true});if(r.error)throw r.error;
  const [p]=await ctx.db`insert into iam.persons(first_name) values(${name}) returning id`;
  const [s]=await ctx.db`insert into team.staff_members(business_id,person_id,employment_status,access_status) values(${ctx.businessId},${p!.id},'ACTIVE','ACTIVE') returning id`;
  const [a]=await ctx.db`insert into iam.user_accounts(person_id,auth_user_id,verified_email,status) values(${p!.id},${r.data.user.id},${email},'ACTIVE') returning id`;
  await ctx.db`insert into iam.account_security_states(account_id) values(${a!.id})`;
  await ctx.db`insert into iam.role_assignments(business_id,staff_member_id,role,effective_at,assigned_by_account_id) values(${ctx.businessId},${s!.id},${role},now(),${ctx.accountId})`;
  return {email,staffId:String(s!.id),accountId:String(a!.id),authId:r.data.user.id};
}
async function request(token:string,path:string,body?:unknown,method='POST',op=randomUUID()){
  const r=await fetch(`http://127.0.0.1:4100${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-operation-id':op},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};
}
async function login(page:Page,email:string){await page.goto('/login');await page.getByLabel('Correo').fill(email);await page.getByLabel('Contraseña').fill(password);await page.getByRole('button',{name:'Ingresar',exact:true}).click();await expect(page).not.toHaveURL(/\/login/);}
async function inventory(page:Page,path='/inventario'){await page.goto(path);await expect(page.getByRole('heading',{name:path==='/insumos'?'Insumos':'Inventario',exact:true})).toBeVisible();await expect(page.getByPlaceholder('Buscar producto o insumo…')).toBeVisible();}
async function confirm(page:Page){await page.getByRole('button',{name:'Revisar operación',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:/^(Confirmar operación|Crear artículo|Registrar stock inicial|Guardar observación)$/}).click();await expect(page.locator('.inv-flow')).toHaveCount(0);if(await page.locator('.inv-inspector').count())await close(page);}
async function close(page:Page){await page.getByRole('button',{name:'Cerrar',exact:true}).click();}
test.beforeAll(async()=>{
  ctx=await createOwnerContext();reception=await staff('RECEPTIONIST','Renata QA');barber=await staff('BARBER','Bruno QA');
  [ownerToken,receptionToken,barberToken]=await Promise.all([signIn(ctx.email,password),signIn(reception.email,password),signIn(barber.email,password)]);
  for(const name of ['Barra','Depósito']){const r=await request(ownerToken,'/v1/inventory/locations',{name});expect(r.status).toBe(200);if(name==='Barra')bar=r.body.data.id;else deposit=r.body.data.id;}
  const k=await request(ownerToken,'/v1/inventory/locations',{name:'Kit del Dueño',staffMemberId:ctx.staffId});kit=k.body.data.id;
  expect((await request(ownerToken,'/v1/inventory/items',{sku:'WAX-UI',name:'Cera de uso interno',use:'INTERNAL'})).status).toBe(200);
  await mkdir('artifacts/h04/screenshots',{recursive:true});
});
test.afterAll(async()=>{
  // Keep immutable domain evidence in the disposable QA DB, remove only test Auth identities.
  for(const id of [ctx?.authUserId,reception.authId,barber.authId])if(id)await ctx.admin.auth.admin.deleteUser(id);
  await ctx?.db.end();
});
test('Owner creates an article with no stock, opens audited stock and sets a minimum',async({page},info)=>{
  await login(page,ctx.email);await inventory(page);
  await page.getByRole('button',{name:'Más opciones de inventario'}).click();await page.getByRole('button',{name:'Gestionar artículos',exact:true}).click();await page.getByRole('button',{name:'Crear artículo',exact:true}).first().click();
  await page.getByLabel('Nombre',{exact:true}).fill('Navajas profesionales');await page.getByLabel('SKU',{exact:true}).fill('RAZOR-UI');await page.getByLabel('Costo de referencia').fill('250');await confirm(page);
  const r=await request(ownerToken,'/v1/inventory',undefined,'GET');expect(r.body.items.find((i:any)=>i.sku==='RAZOR-UI').physical).toBe(0);
  await page.getByRole('status').getByRole('button',{name:'Registrar stock inicial',exact:true}).click();await expect(page.getByRole('heading',{name:'Stock inicial',exact:true})).toBeVisible();await page.getByLabel('Ubicación',{exact:true}).selectOption(bar);await page.getByLabel('Cantidad contada').fill('8');await confirm(page);
  await page.getByRole('button',{name:/Navajas profesionales/}).click();await page.getByRole('button',{name:'Configurar mínimo',exact:true}).click();await page.getByLabel('Mínimo de unidades').fill('10');await confirm(page);
  await inventory(page);await expect(page.getByRole('heading',{name:/Necesitan atención/})).toBeVisible();await page.screenshot({path:`artifacts/h04/screenshots/${info.project.name}-owner-root.png`,fullPage:true,animations:'disabled',scale:'css'});
  const geometry={context:await page.locator('.inv-context').boundingBox(),canvas:await page.locator('.inv-canvas').boundingBox(),search:await page.locator('.inv-searchbar').boundingBox(),list:await page.locator('.inv-list').boundingBox(),attention:await page.locator('.inv-attention').boundingBox()};
  if(info.project.name==='desktop-1440'){expect(geometry.context).toMatchObject({x:240,y:0,width:1200,height:60});expect(geometry.search).toMatchObject({x:272,width:1136});expect(geometry.list).toMatchObject({x:272,width:792});expect(geometry.attention).toMatchObject({x:1088,width:320});}
  else expect(geometry.context?.height).toBe(56);
  await writeFile(`artifacts/h04/screenshots/${info.project.name}-geometry.json`,JSON.stringify(geometry,null,2));
  const result=await new AxeBuilder({page}).include('.inv-content').analyze();expect(result.violations).toEqual([]);
});
test('Reception receives multiple articles, transfers, counts and cannot administer without a grant',async({page})=>{
  await login(page,reception.email);await inventory(page);
  const denied=await request(receptionToken,'/v1/inventory/items',{sku:'FORGED',name:'No permitido',use:'INTERNAL'});expect(denied.status).toBe(403);
  await page.getByRole('button',{name:'Más opciones de inventario'}).click();await page.getByRole('button',{name:'Registrar mercadería',exact:true}).last().click();
  await page.getByLabel('Artículo',{exact:true}).selectOption('RAZOR-UI');await page.getByLabel('Cantidad (unidades completas)').fill('3');await page.getByLabel('Ubicación',{exact:true}).selectOption(bar);
  await page.getByRole('button',{name:'Agregar artículo',exact:true}).click();await page.getByLabel('Artículo',{exact:true}).nth(1).selectOption('WAX-UI');await page.getByLabel('Cantidad (unidades completas)').nth(1).fill('2');await page.getByLabel('Motivo',{exact:true}).fill('Recepción de mercadería real');await confirm(page);
  await page.getByRole('button',{name:/Navajas profesionales/}).first().click();await page.getByRole('button',{name:'Mover stock',exact:true}).click();await page.getByLabel('Ubicación',{exact:true}).selectOption(bar);await page.getByLabel('Hacia',{exact:true}).selectOption(deposit);await page.getByLabel('Cantidad (unidades completas)').fill('2');await page.getByLabel('Motivo',{exact:true}).fill('Reposición del depósito');await confirm(page);
  await page.getByRole('button',{name:/Navajas profesionales/}).first().click();await page.getByRole('button',{name:'Contar stock',exact:true}).click();await page.getByLabel('Ubicación',{exact:true}).selectOption(bar);await page.getByLabel('Cantidad contada').fill('7');await page.getByLabel('Motivo',{exact:true}).fill('Conteo físico de recepción');await confirm(page);
  const s=await request(receptionToken,'/v1/inventory',undefined,'GET');expect(s.body.items.find((i:any)=>i.sku==='RAZOR-UI').physical).toBe(11);expect(s.body.items[0].costMinor).toBeNull();expect(s.body.counts[0].adjusted).toBe(false);
});
test('Owner confirms a physical count and explicitly authorizes another professional origin',async({page})=>{
  await login(page,ctx.email);await inventory(page);await page.getByRole('button',{name:'Más opciones de inventario'}).click();await page.getByRole('button',{name:'Recuentos y discrepancias'}).click();await page.getByRole('button',{name:'Revisar ajuste'}).click();await confirm(page);
  const r=await request(ownerToken,'/v1/inventory/movements',{kind:'OPENING',lines:[{sku:'RAZOR-UI',locationId:kit,purpose:'INTERNAL',quantity:20}],reason:'Existencias atribuidas reales',effectiveAt:new Date().toISOString()});expect(r.status).toBe(200);
  const a=await request(ownerToken,`/v1/inventory/locations/${kit}/access`,{staffMemberId:barber.staffId,allowed:true});expect(a.status).toBe(200);
});
test('Barber records independent consumption, resolves a lost response and persists exactly once',async({page},info)=>{
  await login(page,barber.email);await inventory(page,'/insumos');await expect(page.getByRole('button',{name:'Crear artículo',exact:true})).toHaveCount(0);
  const current=await request(barberToken,'/v1/iam/context',undefined,'GET');await page.evaluate(c=>sessionStorage.setItem(`ykz-h04-draft:${c.businessId}:${c.staffMemberId}:${c.roleAssignmentId}`,JSON.stringify({flow:'NEW',draft:{name:'Admin privado',cost:'987654',lines:[]}})),current.body);
  await page.reload();await expect(page.getByText('Tus permisos actuales no permiten retomar ese borrador.')).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByLabel('Nombre',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:/Navajas profesionales/}).first().click();await page.getByRole('button',{name:'Registrar consumo',exact:true}).click();await page.getByLabel('Ubicación',{exact:true}).selectOption(kit);await page.getByLabel('Cantidad (unidades completas)').fill('1');await page.getByLabel('Motivo o contexto operativo').fill('Una navaja del kit atribuida a otro profesional');
  let operationId='';await page.route('**/v1/inventory/consumptions',async route=>{operationId=route.request().headers()['x-operation-id']!;await route.fetch();await route.abort('failed');},{times:1});
  await page.getByRole('button',{name:'Revisar operación',exact:true}).click();await page.getByRole('button',{name:'Confirmar operación',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('No pudimos confirmar esta operación.');
  await expect(page.getByLabel('Cantidad (unidades completas)')).toBeDisabled();
  await page.getByRole('dialog').getByRole('button',{name:'Consultar estado',exact:true}).click();await expect(page.locator('.inv-flow')).toHaveCount(0);if(await page.locator('.inv-inspector').count())await close(page);
  const [r]=await ctx.db`select count(*)::int n from inventory.movements where operation_id=${operationId}`;expect(r!.n).toBe(1);
  const [c]=await ctx.db`select c.used_by_staff_member_id,e.location_id from inventory.consumptions c join inventory.entries e on e.movement_id=c.movement_id where c.operation_id=${operationId}`;expect(c!.used_by_staff_member_id).toBe(barber.staffId);expect(c!.location_id).toBe(kit);
  await page.reload();await expect(page.getByPlaceholder('Buscar producto o insumo…')).toBeVisible();await page.screenshot({path:`artifacts/h04/screenshots/${info.project.name}-barber-root.png`,fullPage:true,animations:'disabled',scale:'css'});
  const a11y=await new AxeBuilder({page}).include('.inv-content').analyze();expect(a11y.violations).toEqual([]);
  const denied=await request(barberToken,'/v1/inventory/movements',{kind:'RECEIPT',lines:[{sku:'RAZOR-UI',locationId:kit,purpose:'INTERNAL',quantity:9}],reason:'Escalada bloqueada',effectiveAt:new Date().toISOString()});expect(denied.status).toBe(403);
});
test('Draft survives reload, dirty close is guarded and responsive surfaces do not overflow',async({page},info)=>{
  await login(page,ctx.email);await inventory(page);await page.getByRole('button',{name:'Más opciones de inventario'}).click();await page.getByRole('button',{name:'Gestionar artículos',exact:true}).click();await page.getByRole('button',{name:'Crear artículo',exact:true}).first().click();await page.getByLabel('Nombre',{exact:true}).fill('Borrador conservado');
  page.once('dialog',dialog=>dialog.accept());await page.reload();await expect(page.getByLabel('Nombre',{exact:true})).toHaveValue('Borrador conservado');for(let i=0;i<12;i++)await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('dialog'))).toBe(true);await close(page);await expect(page.getByRole('heading',{name:'¿Descartar cambios?'})).toBeVisible();await page.getByRole('button',{name:'Seguir editando'}).click();await expect(page.getByLabel('Nombre',{exact:true})).toHaveValue('Borrador conservado');await page.keyboard.press('Escape');await page.getByRole('button',{name:'Descartar cambios'}).click();
  for(const width of [360,390,768,1024,1280,1440]){await page.setViewportSize({width,height:width>=1280?900:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:`artifacts/h04/screenshots/${info.project.name}-width-${width}.png`,fullPage:true,animations:'disabled',scale:'css'});}
  await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>{const elements=[...document.querySelectorAll<HTMLElement>('.inv-content *')];const sizes=elements.map(e=>parseFloat(getComputedStyle(e).fontSize));elements.forEach((e,i)=>e.style.fontSize=`${sizes[i]!*2}px`);});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:`artifacts/h04/screenshots/${info.project.name}-text-200.png`,scale:'css',animations:'disabled'});
});
test('Owner uses mixed stock, loss, physical return, correction, editing and lifecycle through real forms',async({page},info)=>{
  test.setTimeout(120000);await login(page,ctx.email);await page.goto('/inventario/articulos/nuevo');
  await page.getByLabel('Nombre',{exact:true}).fill('Cera mixta');await page.getByLabel('SKU',{exact:true}).fill('MIXED-UI');await page.getByLabel('Uso',{exact:true}).selectOption('MIXED');await page.getByLabel('Precio de venta (ARS)').fill('1500');await confirm(page);
  await page.getByRole('status').getByRole('button',{name:'Registrar stock inicial',exact:true}).click();await page.getByLabel('Ubicación',{exact:true}).selectOption(bar);await page.getByLabel('Cantidad contada').fill('5');await confirm(page);
  await page.getByRole('button',{name:/Cera mixta/}).first().click();await page.getByRole('button',{name:'Cambiar destino de uso',exact:true}).click();await page.getByLabel('Ubicación',{exact:true}).selectOption(bar);await page.getByLabel('Hacia',{exact:true}).selectOption('INTERNAL');await page.getByLabel('Motivo',{exact:true}).fill('Asignar una unidad al uso interno');await page.getByRole('button',{name:'Revisar operación',exact:true}).click();await page.getByRole('button',{name:'Pasar a uso interno',exact:true}).click();await expect(page.locator('.inv-flow')).toHaveCount(0);await close(page);
  await page.getByRole('button',{name:/Cera mixta/}).first().click();await page.getByRole('button',{name:'Registrar pérdida',exact:true}).click();await page.getByLabel('Ubicación',{exact:true}).selectOption(bar);await page.getByLabel('Destino de uso',{exact:true}).selectOption('INTERNAL');await page.getByLabel('Motivo',{exact:true}).fill('Envase dañado durante la operación');await confirm(page);
  await page.getByRole('button',{name:/Cera mixta/}).first().click();await page.getByRole('button',{name:'Devolución física',exact:true}).click();await page.getByLabel('Ubicación',{exact:true}).selectOption(bar);await page.getByLabel('Destino de uso',{exact:true}).selectOption('INTERNAL');await page.getByLabel('Referencia del hecho físico').fill('Retorno documentado QA');await page.getByLabel('Las unidades están aptas').check();await page.getByLabel('Motivo',{exact:true}).fill('Retorno de una unidad sin usar');await confirm(page);
  await page.getByRole('button',{name:/Cera mixta/}).first().click();await page.getByRole('button',{name:'Historial del artículo'}).click();await expect(page.getByText('Devolución física',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Corregir',exact:true}).first().click();await page.getByLabel('Motivo',{exact:true}).fill('La devolución fue registrada por error');await confirm(page);
  const s=await request(ownerToken,'/v1/inventory',undefined,'GET');const item=s.body.items.find((i:any)=>i.sku==='MIXED-UI');expect(item.physical).toBe(4);expect(item.salePhysical).toBe(4);expect(item.internalPhysical).toBe(0);
  await page.goto(`/inventario/articulos/${item.id}`);await page.getByRole('button',{name:'Editar artículo',exact:true}).click();await page.getByLabel('Nombre',{exact:true}).fill('Cera mixta actualizada');await page.getByLabel('Precio de venta (ARS)').fill('1600');await confirm(page);
  await page.getByRole('button',{name:/Cera mixta actualizada/}).first().click();await page.getByRole('button',{name:'Publicar',exact:true}).click();await expect.poll(async()=>{const r=await request(ownerToken,'/v1/inventory',undefined,'GET');return r.body.items.find((i:any)=>i.sku==='MIXED-UI').published;}).toBe(true);await close(page);
  for(const action of ['Desactivar artículo','Reactivar artículo']){await page.getByRole('button',{name:/Cera mixta actualizada/}).first().click();await page.getByRole('button',{name:action,exact:true}).click();await page.getByLabel('Motivo',{exact:true}).fill('Cambio de disponibilidad en catálogo');await confirm(page);}
  await page.goto('/inventario');await expect(page.getByPlaceholder('Buscar producto o insumo…')).toBeVisible();await page.screenshot({path:`artifacts/h04/screenshots/${info.project.name}-mixed-result.png`,scale:'css',animations:'disabled'});
});
test('Stale count keeps its draft, revalidates current stock and blocks writes while offline',async({page})=>{
  await login(page,ctx.email);await inventory(page);await page.getByRole('button',{name:/Navajas profesionales/}).first().click();await page.getByRole('button',{name:'Contar stock',exact:true}).click();await page.getByLabel('Ubicación',{exact:true}).selectOption(bar);await page.getByLabel('Cantidad contada').fill('8');await page.getByLabel('Motivo',{exact:true}).fill('Conteo concurrente de stock');
  expect((await request(ownerToken,'/v1/inventory/movements',{kind:'RECEIPT',lines:[{sku:'RAZOR-UI',locationId:bar,purpose:'INTERNAL',quantity:1}],reason:'Entrada concurrente real',effectiveAt:new Date().toISOString()})).status).toBe(200);
  await page.getByRole('button',{name:'Revisar operación',exact:true}).click();await page.getByRole('button',{name:'Guardar observación',exact:true}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('El stock cambió');await expect(page.getByLabel('Cantidad contada')).toHaveValue('8');await page.getByRole('button',{name:'Actualizar y revisar'}).click();await expect(page.getByRole('dialog').getByText(/^Sistema: 8 unidades/)).toBeVisible();
  await page.context().setOffline(true);await expect(page.getByRole('button',{name:'Revisar operación',exact:true})).toBeDisabled();await page.context().setOffline(false);await confirm(page);
});
test('Attendance detail links to the real consumption flow without reopening or fabricating Attendance',async({page})=>{
  const created=await request(ownerToken,'/v1/attendance',{staffMemberId:barber.staffId,attendedByStaffMemberId:barber.staffId,walkIn:true,contactSnapshot:{name:'Cliente H04 real',phone:'1155558999'},servicesPerformedSnapshot:[{name:'Corte',durationMinutes:30,priceMinor:12000,currency:'ARS'}],status:'PARTIAL'});expect(created.status).toBe(200);
  await login(page,barber.email);await page.goto('/attendance');await page.getByRole('button',{name:/Abrir atención de Cliente H04 real/}).click();await page.getByRole('link',{name:'Registrar consumo real'}).click();await expect(page.getByRole('heading',{name:'Registrar consumo',exact:true})).toBeVisible();await page.getByLabel('Artículo',{exact:true}).selectOption('RAZOR-UI');await page.getByLabel('Ubicación',{exact:true}).selectOption(bar);await page.getByLabel('Motivo o contexto operativo').fill('Consumo de la atención parcial real');await confirm(page);
  await expect(page).not.toHaveURL(/attendance=/);
  const [r]=await ctx.db`select c.id from inventory.consumptions c join attendance.attendances a on a.id=c.attendance_id where c.business_id=${ctx.businessId} and a.contact_snapshot->>'name'='Cliente H04 real' and a.status='PARTIAL'`;expect(r!.id).toBeTruthy();
});
test('Revoked inventory session cannot mutate through a direct endpoint',async()=>{
  await ctx.db`update team.staff_members set access_status='SUSPENDED' where id=${barber.staffId}`;
  const r=await request(barberToken,'/v1/inventory/consumptions',{sku:'RAZOR-UI',locationId:bar,purpose:'INTERNAL',quantity:1,usedByStaffMemberId:barber.staffId,effectiveAt:new Date().toISOString(),reason:'Sesión revocada'});expect([401,403]).toContain(r.status);
});
