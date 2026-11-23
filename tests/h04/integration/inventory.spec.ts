import { randomUUID } from 'node:crypto';
import { beforeAll,describe,expect,it } from 'vitest';
import { roleCapabilities } from '@youngkingz/contracts';
import { inventorySchemaSummary } from '@youngkingz/database';
import { database } from '../../../apps/api/src/lib/runtime';
import type { Actor } from '../../../apps/api/src/modules/iam/authorization';
import * as cmd from '../../../apps/api/src/modules/inventory/commands';
import { inventorySnapshot,inventoryOperationStatus,listMovements,reconcileInventory } from '../../../apps/api/src/modules/inventory/queries';
import { confirmStockCommitment,confirmStockCommitments,deliverStockCommitment,deliverStockCommitments,releaseStockCommitment } from '../../../apps/api/src/modules/inventory/commitments';
import { registerAttendance } from '../../../apps/api/src/modules/attendance/commands';
import { buildApp } from '../../../apps/api/src/app';
let owner:Actor,barberA:Actor,barberB:Actor,reception:Actor,other:Actor;
let shared:string,attributed:string,deposit:string;let initialItemId:string;
const now=()=>new Date().toISOString();
const itemBody=(sku:string,use='INTERNAL')=>({sku,name:`Artículo ${sku}`,use,...(use!=='INTERNAL'?{priceMinor:12000}:{}),costMinor:500});
async function seedActor(businessId:string,role:Actor['role'],name:string):Promise<Actor>{
  const [p]=await database.client`insert into iam.persons(first_name) values(${name}) returning id`;
  const [s]=await database.client`insert into team.staff_members(business_id,person_id,employment_status,access_status) values(${businessId},${p!.id},'ACTIVE','ACTIVE') returning id`;
  const [a]=await database.client`insert into iam.user_accounts(person_id,verified_email,status) values(${p!.id},${`${randomUUID()}@example.test`},'ACTIVE') returning id`;
  return {accountId:String(a!.id),personId:String(p!.id),staffMemberId:String(s!.id),businessId,role,capabilities:new Set(roleCapabilities[role]),accessSessionId:'',roleAssignmentId:'',contextRevision:1,email:''};
}
async function move(kind:string,sku:string,locationId:string,quantity:number,extra:Record<string,unknown>={},actor=owner){return cmd.createMovement(actor,{kind,lines:[{sku,locationId,purpose:sku.startsWith('SALE')?'SALE':'INTERNAL',quantity}],reason:'Hecho físico verificado',effectiveAt:now(),...extra},randomUUID());}
async function balance(sku:string,locationId=shared,purpose='INTERNAL'){const [r]=await database.client`select physical,version::int version from inventory.positions where business_id=${owner.businessId} and sku=${sku} and location_id=${locationId} and purpose=${purpose}`;return {physical:Number(r?.physical??0),version:Number(r?.version??0)};}
beforeAll(async()=>{
  const [target]=await database.client`select current_database() name`;if(!String(target!.name).startsWith('youngkingz_h04_qa_'))throw new Error('H04 integration requires isolated QA database');
  const [b]=await database.client`insert into business.businesses(provisioning_key,display_name,timezone,status) values(${randomUUID()},'H04 QA evidence','America/Argentina/Buenos_Aires','ACTIVE') returning id`;
  owner=await seedActor(String(b!.id),'OWNER','Dueño');barberA=await seedActor(owner.businessId,'BARBER','Barbero A');barberB=await seedActor(owner.businessId,'BARBER','Barbero B');reception=await seedActor(owner.businessId,'RECEPTIONIST','Recepción');
  const [b2]=await database.client`insert into business.businesses(provisioning_key,display_name,timezone,status) values(${randomUUID()},'H04 Other','America/Argentina/Buenos_Aires','ACTIVE') returning id`;other=await seedActor(String(b2!.id),'OWNER','Otro');
  shared=String((await cmd.saveLocation(owner,null,{name:'Barra'},randomUUID())).data.id);deposit=String((await cmd.saveLocation(owner,null,{name:'Depósito'},randomUUID())).data.id);attributed=String((await cmd.saveLocation(owner,null,{name:'Kit A',staffMemberId:barberA.staffMemberId},randomUUID())).data.id);
});
describe('H04 real PostgreSQL acceptance',()=>{
  it('creates no stock, variants have independent identity, SKU replay is safe',async()=>{
    const id=randomUUID(),body=itemBody('RAZOR');const r=await cmd.createItem(owner,body,id);initialItemId=String(r.data.id);
    expect((await cmd.createItem(owner,body,id)).replayed).toBe(true);
    await expect(cmd.createItem(owner,{...body,name:'Distinto'},id)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    const variant=await cmd.createItem(owner,{...itemBody('RAZOR-V'),parentId:initialItemId},randomUUID());expect(variant.data.id).not.toBe(initialItemId);expect((await balance('RAZOR')).physical).toBe(0);
    await cmd.createItem(owner,{...itemBody('MINIMUM-AT-CREATION'),minimum:0},randomUUID());const withMinimum=(await inventorySnapshot(owner)).items.find(i=>i.sku==='MINIMUM-AT-CREATION')!;expect(withMinimum.minimum).toBe(0);expect(withMinimum.physical).toBe(0);
  });
  it('opening is auditable and cannot be repeated with a different identity',async()=>{
    await move('OPENING','RAZOR',shared,10);await expect(move('OPENING','RAZOR',shared,10)).rejects.toMatchObject({code:'CONFLICT'});expect((await balance('RAZOR')).physical).toBe(10);
  });
  it('same-operation simultaneous receipt commits exactly once',async()=>{
    const op=randomUUID();const body={kind:'RECEIPT',lines:[{sku:'RAZOR',locationId:shared,purpose:'INTERNAL',quantity:3}],reason:'Recepción simultánea',effectiveAt:now()};
    const result=await Promise.all([cmd.createMovement(reception,body,op),cmd.createMovement(reception,body,op)]);expect(result.filter(r=>r.replayed)).toHaveLength(1);expect((await balance('RAZOR')).physical).toBe(13);
  });
  it('multi-article receipt is atomic including rollback of earlier lines',async()=>{
    const body={kind:'RECEIPT',lines:[{sku:'RAZOR',locationId:shared,purpose:'INTERNAL',quantity:2},{sku:'MISSING',locationId:shared,purpose:'INTERNAL',quantity:1}],reason:'Recepción múltiple',effectiveAt:now()};
    await expect(cmd.createMovement(reception,body,randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});expect((await balance('RAZOR')).physical).toBe(13);
    body.lines[1]!.sku='RAZOR-V';await cmd.createMovement(reception,body,randomUUID());expect((await balance('RAZOR-V')).physical).toBe(1);
  });
  it('transfer has two entries, preserves total and rejects insufficient source atomically',async()=>{
    const r=await move('TRANSFER','RAZOR',shared,4,{destinationLocationId:deposit});const e=await database.client`select delta from inventory.entries where movement_id=${r.data.movementId!}`;expect(e).toHaveLength(2);expect(e.reduce((s,e)=>s+Number(e.delta),0)).toBe(0);
    const before=await balance('RAZOR');await expect(move('TRANSFER','RAZOR',shared,999,{destinationLocationId:deposit})).rejects.toMatchObject({code:'CONFLICT'});expect(await balance('RAZOR')).toEqual(before);
  });
  it('serializes opposite transfers and concurrent first-position initialization',async()=>{
    await Promise.all([move('TRANSFER','RAZOR',shared,1,{destinationLocationId:deposit}),move('TRANSFER','RAZOR',deposit,1,{destinationLocationId:shared})]);
    await Promise.all([move('RECEIPT','RAZOR-V',deposit,2),move('RECEIPT','RAZOR-V',deposit,3)]);expect((await balance('RAZOR-V',deposit)).physical).toBe(5);
  });
  it('records a real negative loss and an immutable compensating correction',async()=>{
    const r=await move('LOSS','RAZOR-V',shared,5);expect(r.data.discrepancy).toBe(true);expect((await balance('RAZOR-V')).physical).toBe(-4);
    await cmd.correctMovement(owner,String(r.data.movementId),{reason:'Se registró una pérdida equivocada'},randomUUID());expect((await balance('RAZOR-V')).physical).toBe(1);
    await expect(cmd.correctMovement(owner,String(r.data.movementId),{reason:'Duplicar corrección'},randomUUID())).rejects.toMatchObject({code:'CONFLICT'});
    await expect(database.client`update inventory.movements set reason='alterado' where id=${r.data.movementId!}`).rejects.toMatchObject({code:'23514'});
    await expect(database.client`delete from inventory.entries where movement_id=${r.data.movementId!}`).rejects.toMatchObject({code:'23514'});
  });
  it('physical returns require fitness and causal reference; issues do not affect finances',async()=>{
    await move('RETURN','RAZOR',shared,1,{sourceReference:'Retorno físico documentado',fitForUse:true});await move('ISSUE','RAZOR',shared,1,{sourceReference:'Entrega operativa autorizada'});
    // FIXTURE CIERRE H06: la ausencia de `sales.sales` no es un oráculo H04;
    // H05/H06 pueden estar presentes. El oráculo es que no se crea efecto financiero.
    const [r]=await database.client`select to_regclass('finance.expenses') expense`;expect(r!.expense).toBeNull();
  });
  it('mixed-use reallocation preserves total and location independently',async()=>{
    await cmd.createItem(owner,itemBody('MIXED','MIXED'),randomUUID());await cmd.createMovement(owner,{kind:'OPENING',lines:[{sku:'MIXED',locationId:shared,purpose:'SALE',quantity:5}],reason:'Recuento inicial',effectiveAt:now()},randomUUID());
    await cmd.createMovement(owner,{kind:'REALLOCATE',lines:[{sku:'MIXED',locationId:shared,purpose:'SALE',quantity:1}],destinationPurpose:'INTERNAL',reason:'Uso en el local',effectiveAt:now()},randomUUID());
    expect((await balance('MIXED',shared,'SALE')).physical).toBe(4);expect((await balance('MIXED')).physical).toBe(1);const s=await inventorySnapshot(owner);expect(s.items.find(i=>i.sku==='MIXED')!.physical).toBe(5);
  });
  it('preserves observations, rejects stale adjustments, and revalidates with a new observation',async()=>{
    const p=await balance('RAZOR');const c=await cmd.createCount(reception,{sku:'RAZOR',locationId:shared,purpose:'INTERNAL',observedQuantity:p.physical+2,expectedVersion:p.version,observedAt:now(),reason:'Conteo físico'},randomUUID());expect((await balance('RAZOR')).physical).toBe(p.physical);
    await move('RECEIPT','RAZOR',shared,1);await expect(cmd.adjustCount(owner,String(c.data.countId),{expectedVersion:p.version,reason:'Confirmar diferencia'},randomUUID())).rejects.toMatchObject({code:'STALE_REVISION'});
    const current=await balance('RAZOR');const fresh=await cmd.createCount(reception,{sku:'RAZOR',locationId:shared,purpose:'INTERNAL',observedQuantity:3,expectedVersion:current.version,observedAt:now(),reason:'Nueva observación física',previousCountId:c.data.countId},randomUUID());await cmd.adjustCount(owner,String(fresh.data.countId),{expectedVersion:current.version,reason:'Confirmar reconteo'},randomUUID());expect((await balance('RAZOR')).physical).toBe(3);
    expect((await inventorySnapshot(owner)).counts.filter(c=>c.sku==='RAZOR')).toHaveLength(2);
  });
  it('matching count confirms without inventing a zero-delta movement',async()=>{
    const p=await balance('RAZOR');const c=await cmd.createCount(reception,{sku:'RAZOR',locationId:shared,purpose:'INTERNAL',observedQuantity:p.physical,expectedVersion:p.version,observedAt:now(),reason:'Conteo coincidente'},randomUUID());const r=await cmd.adjustCount(owner,String(c.data.countId),{expectedVersion:p.version,reason:'Sin diferencia'},randomUUID());expect(r.data.movementId).toBeNull();expect(await balance('RAZOR')).toEqual(p);
  });
  it('B consumes a razor physically attributed to A only after explicit access; A remains origin',async()=>{
    await move('OPENING','RAZOR',attributed,20);
    const body={sku:'RAZOR',locationId:attributed,purpose:'INTERNAL',quantity:1,usedByStaffMemberId:barberB.staffMemberId,effectiveAt:now(),reason:'Uso real por B'};
    await expect(cmd.consume(barberB,body,randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
    await cmd.setLocationAccess(owner,attributed,barberB.staffMemberId,true,randomUUID());const r=await cmd.consume(barberB,body,randomUUID());expect((await balance('RAZOR',attributed)).physical).toBe(19);
    const [c]=await database.client`select used_by_staff_member_id,attendance_id from inventory.consumptions where movement_id=${r.data.movementId}`;expect(c!.used_by_staff_member_id).toBe(barberB.staffMemberId);expect(c!.attendance_id).toBeNull();
    await cmd.setLocationAccess(owner,attributed,barberB.staffMemberId,false,randomUUID());expect((await inventorySnapshot(barberB)).locations.some(l=>l.id===attributed)).toBe(false);
  });
  it.each(['COMPLETED','PARTIAL','INTERRUPTED'] as const)('consumes from real %s walk-in Attendance without modifying its lifecycle',async status=>{
    const at=await registerAttendance({actor:owner,staffMemberId:barberA.staffMemberId,attendedByStaffMemberId:barberA.staffMemberId,walkIn:true,contactSnapshot:{name:`Cliente ${status}`,phone:status==='COMPLETED'?'1155557777':status==='PARTIAL'?'1155557778':'1155557779'},servicesPerformedSnapshot:[{name:'Corte',durationMinutes:30,priceMinor:10000,currency:'ARS'}],status,operationId:randomUUID()});
    const [before]=await database.client`select revision,status from attendance.attendances where id=${at.attendanceId}`;
    const r=await cmd.consume(barberA,{sku:'RAZOR',locationId:shared,purpose:'INTERNAL',quantity:2,usedByStaffMemberId:barberA.staffMemberId,attendanceId:at.attendanceId,attendanceRevision:Number(before!.revision),effectiveAt:now(),reason:'Material utilizado en atención'},randomUUID());
    await cmd.consume(barberA,{sku:'RAZOR',locationId:shared,purpose:'INTERNAL',quantity:1,usedByStaffMemberId:barberA.staffMemberId,attendanceId:at.attendanceId,attendanceRevision:Number(before!.revision),effectiveAt:now(),reason:'Segundo consumo legítimo posterior'},randomUUID());
    const consumptionRows=await database.client`select id from inventory.consumptions where attendance_id=${at.attendanceId}`;expect(consumptionRows).toHaveLength(2);
    const [after]=await database.client`select revision,status from attendance.attendances where id=${at.attendanceId}`;expect(after).toEqual(before);expect(r.data.consumptionId).toBeTruthy();
  });
  it('independent consumption permits negative stock, distinct facts and safe double tap',async()=>{
    const body={sku:'RAZOR',locationId:shared,purpose:'INTERNAL',quantity:4,usedByStaffMemberId:barberA.staffMemberId,effectiveAt:now(),reason:'Consumo operativo posterior'};const op=randomUUID();const before=await balance('RAZOR');
    const r=await Promise.all([cmd.consume(barberA,body,op),cmd.consume(barberA,body,op)]);expect(r.filter(r=>r.replayed)).toHaveLength(1);expect((await balance('RAZOR')).physical).toBe(before.physical-4);expect(r[0]!.data.discrepancy).toBe(true);
    await cmd.consume(barberA,body,randomUUID());expect((await balance('RAZOR')).physical).toBe(before.physical-8);
    await cmd.correctMovement(owner,String(r[0]!.data.movementId),{reason:'Rectificar consumo duplicado en origen'},randomUUID());
    const status=await inventoryOperationStatus(barberA,op);expect(status.status).toBe('SUCCEEDED');expect(status.responseBody.movementId).toBe(r[0]!.data.movementId);
    await expect(inventoryOperationStatus(barberB,op)).rejects.toMatchObject({code:'NOT_FOUND'});
  });
  it('enforces barber scopes, basic vs delegated reception and no cost leakage',async()=>{
    await expect(cmd.createItem(barberA,itemBody('DENIED'),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(cmd.createItem(reception,itemBody('DENIED'),randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
    const delegated={...reception,capabilities:new Set([...reception.capabilities,'inventory.manage' as const])};await cmd.createItem(delegated,{sku:'DELEGATED',name:'Delegado',use:'INTERNAL'},randomUUID());
    const s=await inventorySnapshot(barberA);expect(s.items.every(i=>i.costMinor===null)).toBe(true);expect(s.items.every(i=>i.use!=='SALE')).toBe(true);
    await expect(cmd.consume(barberA,{sku:'RAZOR',locationId:shared,purpose:'INTERNAL',quantity:1,usedByStaffMemberId:barberB.staffMemberId,effectiveAt:now(),reason:'Otro profesional'},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  it('minimums distinguish null/zero and global uniqueness includes NULL',async()=>{
    await cmd.setMinimum(owner,{sku:'RAZOR',quantity:0},randomUUID());await cmd.setMinimum(owner,{sku:'RAZOR',quantity:5},randomUUID());const rows=await database.client`select quantity from inventory.minimums where business_id=${owner.businessId} and sku='RAZOR' and location_id is null`;expect(rows).toHaveLength(1);expect(rows[0]!.quantity).toBe(5);
    await cmd.setMinimum(owner,{sku:'RAZOR',locationId:attributed,quantity:25},randomUUID());expect((await inventorySnapshot(owner)).positions.find(p=>p.locationId===attributed&&p.sku==='RAZOR')!.criticality).toBe('LOW');
    await expect(cmd.setMinimum(reception,{sku:'RAZOR',quantity:1},randomUUID())).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  it('competing last-unit commitments serialize, release and delivery are individually idempotent',async()=>{
    await cmd.createItem(owner,itemBody('SALE-LAST','SALE'),randomUUID());await move('OPENING','SALE-LAST',shared,1);
    const confirm=(reference:string)=>{const op=randomUUID();return cmd.inventoryOperation(owner,op,'fixture.confirm','inventory.operate',{reference},tx=>confirmStockCommitment(tx,owner,op,{sku:'SALE-LAST',locationId:shared,purpose:'SALE',quantity:1,sourceReference:reference}));};
    const both=await Promise.allSettled([confirm('H06-fixture-A'),confirm('H06-fixture-B')]);expect(both.filter(r=>r.status==='fulfilled')).toHaveLength(1);const win=both.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof confirm>>>;const id=win.value.data.commitmentId;
    expect((await balance('SALE-LAST',shared,'SALE')).physical).toBe(1);const snap=await inventorySnapshot(owner);expect(snap.items.find(i=>i.sku==='SALE-LAST')).toMatchObject({physical:1,committed:1,sellable:0});
    for(let i=0;i<2;i++)await cmd.inventoryOperation(owner,randomUUID(),'fixture.release','inventory.operate',{id},tx=>releaseStockCommitment(tx,owner,id));
    const c=await confirm('H06-fixture-C');const deliver=()=>{const op=randomUUID();return cmd.inventoryOperation(owner,op,'fixture.deliver','inventory.operate',{id:c.data.commitmentId},tx=>deliverStockCommitment(tx,owner,c.data.commitmentId,op,1));};
    const first=await deliver(),second=await deliver();expect(first.data.movementId).toBe(second.data.movementId);expect((await balance('SALE-LAST',shared,'SALE')).physical).toBe(0);
  });
  it('lifecycle preserves stock and revision, publication is independent',async()=>{
    const [old]=await database.client`select revision::int revision from inventory.items where id=${initialItemId}`;const off=await cmd.lifecycleItem(owner,initialItemId,{active:false,expectedRevision:old!.revision,reason:'Pausa de catálogo'},randomUUID());const before=await balance('RAZOR');
    await expect(move('RECEIPT','RAZOR',shared,1)).rejects.toMatchObject({code:'CONFLICT'});await cmd.lifecycleItem(owner,initialItemId,{active:true,expectedRevision:off.data.revision,reason:'Reactivar catálogo'},randomUUID());expect(await balance('RAZOR')).toEqual(before);
    const r=await cmd.createItem(owner,itemBody('SALE-PUBLISH','SALE'),randomUUID());await cmd.publishItem(owner,String(r.data.id),{published:true,expectedRevision:1},randomUUID());await expect(cmd.publishItem(owner,String(r.data.id),{published:false,expectedRevision:1},randomUUID())).rejects.toMatchObject({code:'STALE_REVISION'});
  });
  it('future multi-line order contracts reserve and deliver atomically under one operation',async()=>{
    for(const sku of ['SALE-BATCH-A','SALE-BATCH-B']){await cmd.createItem(owner,itemBody(sku,'SALE'),randomUUID());await move('OPENING',sku,shared,2);}
    const lines=['SALE-BATCH-A','SALE-BATCH-B'].map(sku=>({sku,locationId:shared,purpose:'SALE',quantity:1,sourceReference:'H06-batch-fixture'}));
    const confirmOp=randomUUID();const c=await cmd.inventoryOperation(owner,confirmOp,'fixture.batch.confirm','inventory.operate',{lines},tx=>confirmStockCommitments(tx,owner,confirmOp,lines));expect(c.data).toHaveLength(2);
    const id=c.data[0]!.commitmentId;const invalidOp=randomUUID();await expect(cmd.inventoryOperation(owner,invalidOp,'fixture.partial','inventory.operate',{id},tx=>deliverStockCommitment(tx,owner,id,invalidOp,2))).rejects.toMatchObject({code:'CONFLICT'});
    const deliverOp=randomUUID();const delivered=await cmd.inventoryOperation(owner,deliverOp,'fixture.batch.deliver','inventory.operate',{ids:c.data.map(c=>c.commitmentId)},tx=>deliverStockCommitments(tx,owner,c.data.map(c=>c.commitmentId),deliverOp));
    for(const sku of ['SALE-BATCH-A','SALE-BATCH-B'])expect((await balance(sku,shared,'SALE')).physical).toBe(1);
    expect((await database.client`select id from inventory.entries where movement_id=${delivered.data.movementId}`).length).toBe(2);
    const failingOp=randomUUID();const before=(await inventorySnapshot(owner)).items.find(i=>i.sku==='SALE-BATCH-A')!.committed;
    await expect(cmd.inventoryOperation(owner,failingOp,'fixture.batch.rollback','inventory.operate',{},tx=>confirmStockCommitments(tx,owner,failingOp,[{...lines[0],sourceReference:'H06-reject-fixture'},{...lines[1],sourceReference:'H06-reject-fixture',quantity:999}]))).rejects.toMatchObject({code:'CONFLICT'});
    expect((await inventorySnapshot(owner)).items.find(i=>i.sku==='SALE-BATCH-A')!.committed).toBe(before);
    const secondConfirmOp=randomUUID();const secondLines=lines.map(line=>({...line,sourceReference:'H06-no-partial-after-release'}));const second=await cmd.inventoryOperation(owner,secondConfirmOp,'fixture.batch.confirm','inventory.operate',{secondLines},tx=>confirmStockCommitments(tx,owner,secondConfirmOp,secondLines));
    await cmd.inventoryOperation(owner,randomUUID(),'fixture.partial.release','inventory.operate',{},tx=>releaseStockCommitment(tx,owner,second.data[0]!.commitmentId));
    const partialDeliverOp=randomUUID();await expect(cmd.inventoryOperation(owner,partialDeliverOp,'fixture.partial.after-release','inventory.operate',{},tx=>deliverStockCommitments(tx,owner,[second.data[1]!.commitmentId],partialDeliverOp))).rejects.toMatchObject({code:'CONFLICT'});
  });
  it('concurrent delivery and release have one terminal result and a single coherent physical effect',async()=>{
    await cmd.createItem(owner,itemBody('SALE-RACE','SALE'),randomUUID());await move('OPENING','SALE-RACE',shared,1);
    const op=randomUUID();const c=await cmd.inventoryOperation(owner,op,'fixture.race.confirm','inventory.operate',{},tx=>confirmStockCommitment(tx,owner,op,{sku:'SALE-RACE',locationId:shared,purpose:'SALE',quantity:1,sourceReference:'H06-delivery-release-race'}));
    const deliverOp=randomUUID(),releaseOp=randomUUID();const results=await Promise.allSettled([
      cmd.inventoryOperation(owner,deliverOp,'fixture.race.deliver','inventory.operate',{},tx=>deliverStockCommitment(tx,owner,c.data.commitmentId,deliverOp,1)),
      cmd.inventoryOperation(owner,releaseOp,'fixture.race.release','inventory.operate',{},tx=>releaseStockCommitment(tx,owner,c.data.commitmentId)),
    ]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const [stored]=await database.client`select state from inventory.commitments where id=${c.data.commitmentId}`;
    expect((await balance('SALE-RACE',shared,'SALE')).physical).toBe(stored!.state==='DELIVERED'?0:1);
  });
  it('rejects non-terminal Attendance, cross-business Attendance FK, invalid ledger shape and append-after-commit',async()=>{
    const at=await registerAttendance({actor:owner,staffMemberId:barberA.staffMemberId,walkIn:true,contactSnapshot:{name:'Atención en curso',phone:'1155588990'},operationId:randomUUID()});
    const body={sku:'RAZOR',locationId:shared,purpose:'INTERNAL',quantity:1,usedByStaffMemberId:barberA.staffMemberId,effectiveAt:now(),reason:'Verificar integración',attendanceId:at.attendanceId};
    await expect(cmd.consume(barberA,body,randomUUID())).rejects.toMatchObject({code:'CONFLICT'});
    await cmd.createItem(other,itemBody('CROSS-ATTENDANCE'),randomUUID());const crossLocation=String((await cmd.saveLocation(other,null,{name:'Cross-Attendance'},randomUUID())).data.id);
    const crossOp=randomUUID();await expect(cmd.inventoryOperation(other,crossOp,'fixture.cross','inventory.operate',{},async tx=>{
      const m=await cmd.physicalEvent(tx,other,crossOp,'CONSUMPTION',[{sku:'CROSS-ATTENDANCE',locationId:crossLocation,purpose:'INTERNAL',delta:-1}],'Verificar aislamiento Attendance',now(),{allowNegative:true});
      return tx`insert into inventory.consumptions(business_id,movement_id,operation_id,attendance_id,attendance_revision,used_by_staff_member_id) values(${other.businessId},${m.movementId},${crossOp},${at.attendanceId},1,${other.staffMemberId})`;
    })).rejects.toMatchObject({code:'23503'});
    const badOp=randomUUID();await expect(cmd.inventoryOperation(owner,badOp,'fixture.bad.transfer','inventory.operate',{},tx=>cmd.physicalEvent(tx,owner,badOp,'TRANSFER',[{sku:'RAZOR',locationId:shared,purpose:'INTERNAL',delta:1}],'Invalid physical shape',now()))).rejects.toMatchObject({code:'23514'});
    const [entry]=await database.client`select * from inventory.entries where business_id=${owner.businessId} order by position_version desc limit 1`;
    await expect(database.client`insert into inventory.entries(business_id,movement_id,sku,location_id,purpose,delta,position_version) values(${owner.businessId},${entry!.movement_id},${entry!.sku},${entry!.location_id},${entry!.purpose},1,${Number(entry!.position_version)+1})`).rejects.toMatchObject({code:'23514'});
  });
  it('rejects cross-business references through commands and direct SQL',async()=>{
    await expect(cmd.consume(other,{sku:'RAZOR',locationId:shared,purpose:'INTERNAL',quantity:1,usedByStaffMemberId:other.staffMemberId,effectiveAt:now(),reason:'Cross tenant'},randomUUID())).rejects.toMatchObject({code:'NOT_FOUND'});
    await expect(database.client`insert into inventory.locations(business_id,name,staff_member_id) values(${other.businessId},'Cross',${barberA.staffMemberId})`).rejects.toMatchObject({code:'23503'});
    await expect(database.client`insert into inventory.minimums(business_id,sku,location_id,quantity) values(${owner.businessId},'RAZOR',${(await cmd.saveLocation(other,null,{name:'Other'},randomUUID())).data.id!},1)`).rejects.toMatchObject({code:'23503'});
    await expect(database.client`update inventory.positions set physical=999 where business_id=${owner.businessId}`).rejects.toMatchObject({code:'23514'});
  });
  it('reconstructs every physical position and version exactly from immutable entries',async()=>{
    const mismatch=await database.client`select p.* from inventory.positions p full join inventory.reconstructed_positions r using(business_id,sku,location_id,purpose) where coalesce(p.business_id,r.business_id)=${owner.businessId} and (p.physical is distinct from r.physical or p.version is distinct from r.version)`;expect(mismatch).toHaveLength(0);
    const history=await listMovements(owner,{limit:100});expect(history.items.length).toBeGreaterThan(10);const [r]=await database.client`select count(*)::int n from inventory.movements m where m.business_id=${owner.businessId} and not exists(select 1 from system.audit_events a where a.operation_id=m.operation_id and a.business_id=m.business_id)`;expect(r!.n).toBe(0);
    expect((await reconcileInventory(owner)).consistent).toBe(true);await expect(reconcileInventory(barberA)).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  it('ORM column names/nullability match PostgreSQL; all physical quantities are integers',async()=>{
    for(const table of inventorySchemaSummary()){
      const actual=await database.client`select column_name,is_nullable,data_type from information_schema.columns where table_schema='inventory' and table_name=${table.name} order by ordinal_position`;
      expect(actual.map(r=>r.column_name).sort()).toEqual(table.columns.map(c=>c.name).sort());
      for(const column of table.columns){const row=actual.find(r=>r.column_name===column.name)!;expect(row.is_nullable==='NO').toBe(column.notNull);if(['delta','physical','quantity','observed'].includes(column.name))expect(row.data_type).toBe('integer');}
    }
  });
  it('HTTP endpoints authenticate and do not expose arbitrary commitment creation',async()=>{
    const app=await buildApp();try{expect((await app.inject({method:'GET',url:'/v1/inventory'})).statusCode).toBe(401);expect((await app.inject({method:'POST',url:'/v1/inventory/commitments',payload:{}})).statusCode).toBe(404);}finally{await app.close();}
  });
});
