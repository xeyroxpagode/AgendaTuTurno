import { randomUUID } from "node:crypto";
import { DomainError, MAX_STOCK, inventoryItemSchema, inventoryItemUpdateSchema, inventoryLifecycleSchema, inventoryPublishSchema,
  inventoryLocationSchema, inventoryLocationUpdateSchema, inventoryMovementSchema, inventoryConsumptionSchema,
  inventoryCountSchema, inventoryCountAdjustSchema, inventoryMinimumSchema, inventoryCorrectionSchema,
  type Capability, type InventoryLine, type StockPurpose } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import { executeOperation, audit, type Tx } from "../system/operations.js";
import { checkVersion, conflict, item, location, lockInventory, missing, professional, requireInventory } from "./domain.js";

export async function inventoryOperation<T>(actor: Actor, operationId: string, command: string, capability: Capability, payload: unknown, handler: (tx: Tx) => Promise<T>) {
  requireInventory(actor, capability);
  return executeOperation({ actor, operationId, command: `inventory.${command}`, payload }, async tx => {
    await lockInventory(tx, actor.businessId);
    const data = await handler(tx);
    await audit(tx, { actor, operationId, action: `inventory.${command}`, capability, resourceType: "INVENTORY", changes: { result: data } });
    return data;
  });
}

export async function createItem(actor: Actor, body: unknown, operationId: string) {
  const v = inventoryItemSchema.parse(body);
  return inventoryOperation(actor, operationId, "item.create", "inventory.manage", v, async tx => {
    if(v.costMinor!==null&&!actor.capabilities.has('inventory.cost.read'))throw new DomainError('FORBIDDEN','No tenés permiso para gestionar costos',403);
    if ((await tx`select 1 from inventory.items where business_id=${actor.businessId} and sku=${v.sku}`).length) throw conflict("El SKU ya existe");
    if (v.parentId) {
      const [parent] = await tx`select id,parent_id,active from inventory.items where business_id=${actor.businessId} and id=${v.parentId}`;
      if (!parent) throw missing();
      if (parent.parent_id || !parent.active) throw conflict("Seleccioná un artículo principal activo");
    }
    const [row] = await tx`insert into inventory.items(business_id,sku,name,description,category,use,parent_id,price_minor,cost_minor,image_url)
      values(${actor.businessId},${v.sku},${v.name},${v.description},${v.category},${v.use},${v.parentId},${v.priceMinor},${v.costMinor},${v.imageUrl}) returning id,revision::int revision`;
    if(v.minimum!==null)await tx`insert into inventory.minimums(business_id,sku,location_id,quantity) values(${actor.businessId},${v.sku},null,${v.minimum})`;
    return row!;
  });
}
export async function updateItem(actor: Actor, id: string, body: unknown, operationId: string) {
  const v = inventoryItemUpdateSchema.parse(body);
  return inventoryOperation(actor,operationId,"item.update","inventory.manage",{id,...v},async tx => {
    const [old] = await tx`select * from inventory.items where business_id=${actor.businessId} and id=${id}`;
    if (!old) throw missing(); checkVersion(Number(old.revision),v.expectedRevision);
    if (old.use !== v.use) {
      const partitions = await tx`select purpose,physical total from inventory.positions where business_id=${actor.businessId} and sku=${old.sku}`;
      if (partitions.some(p => p.total !== 0 && v.use !== "MIXED" && p.purpose !== v.use)) throw conflict("Cambiá primero el destino de las unidades existentes");
    }
    const cost=actor.capabilities.has('inventory.cost.read')?v.costMinor:old.cost_minor;
    const [row] = await tx`update inventory.items set name=${v.name},description=${v.description},category=${v.category},use=${v.use},price_minor=${v.priceMinor},cost_minor=${cost},image_url=${v.imageUrl},published=case when ${v.use}='INTERNAL' then false else published end,revision=revision+1 where id=${id} returning id,revision::int revision`;
    return row!;
  });
}
export async function lifecycleItem(actor: Actor,id:string,body:unknown,operationId:string) {
  const v=inventoryLifecycleSchema.parse(body);
  return inventoryOperation(actor,operationId,"item.lifecycle","inventory.manage",{id,...v},async tx=>{
    const [old]=await tx`select * from inventory.items where business_id=${actor.businessId} and id=${id}`;
    if(!old)throw missing();checkVersion(Number(old.revision),v.expectedRevision);
    if(!v.active&&(await tx`select 1 from inventory.commitments where business_id=${actor.businessId} and sku=${old.sku} and state='ACTIVE'`).length)throw conflict("Liberá los compromisos antes de desactivar");
    // Deactivation preserves physical stock and permits later reactivation.
    const [row]=await tx`update inventory.items set active=${v.active},published=case when ${v.active} then published else false end,revision=revision+1 where id=${id} returning id,active,revision::int revision`;
    return row!;
  });
}
export async function publishItem(actor:Actor,id:string,body:unknown,operationId:string){
  const v=inventoryPublishSchema.parse(body);
  return inventoryOperation(actor,operationId,"item.publish","inventory.manage",{id,...v},async tx=>{
    const [old]=await tx`select * from inventory.items where business_id=${actor.businessId} and id=${id}`;
    if(!old)throw missing();checkVersion(Number(old.revision),v.expectedRevision);
    if(v.published&&(!old.active||old.use==='INTERNAL'))throw conflict("Sólo se publican artículos activos para venta");
    const [row]=await tx`update inventory.items set published=${v.published},revision=revision+1 where id=${id} returning id,published,revision::int revision`;return row!;
  });
}
export async function saveLocation(actor:Actor,id:string|null,body:unknown,operationId:string){
  const v=id?inventoryLocationUpdateSchema.parse(body):inventoryLocationSchema.parse(body);
  return inventoryOperation(actor,operationId,"location.save","inventory.manage",{id,...v},async tx=>{
    if(v.staffMemberId)await professional(tx,actor,v.staffMemberId);
    if((await tx`select 1 from inventory.locations where business_id=${actor.businessId} and name=${v.name} and id<>${id??'00000000-0000-0000-0000-000000000000'}`).length)throw conflict("Ya existe una ubicación con ese nombre");
    if(id){
      const old=await location(tx,actor,id,false);checkVersion(Number(old.revision),"expectedRevision" in v?Number(v.expectedRevision):0);
      const hasStock=(await tx`select 1 from inventory.positions where business_id=${actor.businessId} and location_id=${id} and physical<>0`).length;
      const committed=(await tx`select 1 from inventory.commitments where business_id=${actor.businessId} and location_id=${id} and state='ACTIVE'`).length;
      if((!v.active||old.staff_member_id!==v.staffMemberId)&&(hasStock||committed))throw conflict("Trasladá las existencias y resolvé los compromisos antes de cambiar la atribución o desactivar");
      if(old.staff_member_id!==v.staffMemberId&&(await tx`select 1 from inventory.entries where business_id=${actor.businessId} and location_id=${id} limit 1`).length)throw conflict('La atribución de una ubicación con historia se conserva. Creá otra ubicación para el nuevo profesional');
      const [row]=await tx`update inventory.locations set name=${v.name},staff_member_id=${v.staffMemberId},active=${v.active},revision=revision+1 where id=${id} returning id,revision::int revision`;return row!;
    }
    const [row]=await tx`insert into inventory.locations(business_id,name,staff_member_id,active) values(${actor.businessId},${v.name},${v.staffMemberId},${v.active}) returning id,revision::int revision`;return row!;
  });
}
export async function setLocationAccess(actor:Actor,id:string,staffId:string,allowed:boolean,operationId:string){
  return inventoryOperation(actor,operationId,"location.access","inventory.manage",{id,staffId,allowed},async tx=>{
    await location(tx,actor,id);await professional(tx,actor,staffId);
    if(allowed)await tx`insert into inventory.location_access(business_id,location_id,staff_member_id) values(${actor.businessId},${id},${staffId}) on conflict do nothing`;
    else await tx`delete from inventory.location_access where business_id=${actor.businessId} and location_id=${id} and staff_member_id=${staffId}`;
    return {id,staffId,allowed};
  });
}

export async function position(tx:Tx,businessId:string,line:Pick<InventoryLine,"sku"|"locationId"|"purpose">){
  const [p]=await tx`select physical,version::int version from inventory.positions where business_id=${businessId} and sku=${line.sku} and location_id=${line.locationId} and purpose=${line.purpose}`;
  const [c]=await tx`select coalesce(sum(quantity),0)::int committed from inventory.commitments where business_id=${businessId} and sku=${line.sku} and location_id=${line.locationId} and state='ACTIVE'`;
  return {physical:Number(p?.physical??0),version:Number(p?.version??0),committed:line.purpose==='SALE'?Number(c?.committed??0):0};
}
export type DeltaLine = Omit<InventoryLine,"quantity"> & {delta:number};
export async function physicalEvent(tx:Tx,actor:Actor,operationId:string,kind:string,lines:DeltaLine[],reason:string,effectiveAt:string,options:{correctsId?:string;sourceReference?:string;allowNegative?:boolean}={}){
  const id=randomUUID();let discrepancy=false;
  // Aggregate repeated lines, preserving one canonical delta per position/event.
  const grouped=new Map<string,DeltaLine>();
  for(const line of lines){const key=JSON.stringify([line.sku,line.locationId,line.purpose]);const old=grouped.get(key);grouped.set(key,{...line,delta:(old?.delta??0)+line.delta});}
  const entries=[...grouped.values()].filter(l=>l.delta!==0).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if(!entries.length)throw conflict("No hay un cambio físico que registrar");
  for(const line of entries){
    const i=await item(tx,actor,line.sku,kind!=='CORRECTION');await location(tx,actor,line.locationId,kind!=='CORRECTION');
    if((i.use==='SALE'&&line.purpose!=='SALE')||(i.use==='INTERNAL'&&line.purpose!=='INTERNAL'))throw conflict("Destino de uso incompatible con el artículo");
    const p=await position(tx,actor.businessId,line);const after=p.physical+line.delta;
    if(!Number.isSafeInteger(after)||Math.abs(after)>MAX_STOCK||Math.abs(line.delta)>MAX_STOCK)throw new DomainError("VALIDATION_ERROR","La cantidad supera el límite de unidades",400);
    if(after<0)discrepancy=true;
    if(line.delta<0&&!options.allowNegative&&after-p.committed<0)throw conflict("No hay unidades disponibles suficientes; revisá stock y compromisos");
  }
  await tx`insert into inventory.movements(id,business_id,kind,operation_id,actor_account_id,reason,effective_at,source_reference,corrects_id,discrepancy)
    values(${id},${actor.businessId},${kind},${operationId},${actor.accountId},${reason},${effectiveAt},${options.sourceReference??null},${options.correctsId??null},${discrepancy})`;
  for(const line of entries){const p=await position(tx,actor.businessId,line);await tx`insert into inventory.entries(business_id,movement_id,sku,location_id,purpose,delta,position_version) values(${actor.businessId},${id},${line.sku},${line.locationId},${line.purpose},${line.delta},${p.version+1})`;}
  return {movementId:id,discrepancy};
}
export async function createMovement(actor:Actor,body:unknown,operationId:string){
  const v=inventoryMovementSchema.parse(body);const sensitive=v.kind==='OPENING';
  return inventoryOperation(actor,operationId,"movement.create",sensitive?'inventory.adjust':'inventory.operate',v,async tx=>{
    const lines:DeltaLine[]=v.lines.map(l=>({...l,delta:l.quantity*(['LOSS','TRANSFER','REALLOCATE','ISSUE'].includes(v.kind)?-1:1)}));
    if(v.kind==='OPENING')for(const line of lines){if((await tx`select 1 from inventory.entries where business_id=${actor.businessId} and sku=${line.sku} and location_id=${line.locationId} and purpose=${line.purpose}`).length)throw conflict("Esa posición ya tiene historia. Registrá un recuento de stock");}
    if(v.kind==='TRANSFER')lines.push({...lines[0]!,delta:-lines[0]!.delta,locationId:v.destinationLocationId!});
    if(v.kind==='REALLOCATE'){
      const i=await item(tx,actor,lines[0]!.sku);if(i.use!=='MIXED')throw conflict("El artículo no es de uso mixto");
      lines.push({...lines[0]!,delta:-lines[0]!.delta,purpose:v.destinationPurpose!});
    }
    return physicalEvent(tx,actor,operationId,v.kind,lines,v.reason,v.effectiveAt,{sourceReference:v.sourceReference,allowNegative:v.kind==='LOSS'});
  });
}
export async function consume(actor:Actor,body:unknown,operationId:string){
  const v=inventoryConsumptionSchema.parse(body);
  return inventoryOperation(actor,operationId,"consumption.create","inventory.consume",v,async tx=>{
    if(actor.role==='BARBER'&&v.usedByStaffMemberId!==actor.staffMemberId)throw new DomainError("FORBIDDEN","Sólo podés registrar tu consumo real",403);
    if(v.purpose!=='INTERNAL')throw conflict("Asigná las unidades a uso interno antes de consumir");
    await professional(tx,actor,v.usedByStaffMemberId);
    let attendanceRevision:number|null=null;
    if(v.attendanceId){
      const [at]=await tx`select * from attendance.attendances where business_id=${actor.businessId} and id=${v.attendanceId} for share`;
      if(!at)throw missing();
      if(!['COMPLETED','PARTIAL','INTERRUPTED'].includes(at.status))throw conflict("La atención todavía está en curso");
      if(at.attended_by_staff_member_id!==v.usedByStaffMemberId)throw conflict("El profesional debe coincidir con la atención real");
      attendanceRevision=Number(at.revision);if(v.attendanceRevision!==undefined)checkVersion(attendanceRevision,v.attendanceRevision);
    }
    const result=await physicalEvent(tx,actor,operationId,'CONSUMPTION',[{sku:v.sku,locationId:v.locationId,purpose:v.purpose,delta:-v.quantity}],v.reason,v.effectiveAt,{allowNegative:true,sourceReference:v.attendanceId??undefined});
    const [row]=await tx`insert into inventory.consumptions(business_id,movement_id,operation_id,attendance_id,attendance_revision,used_by_staff_member_id) values(${actor.businessId},${result.movementId},${operationId},${v.attendanceId},${attendanceRevision},${v.usedByStaffMemberId}) returning id`;
    return {...result,consumptionId:row!.id};
  });
}
export async function correctMovement(actor:Actor,id:string,body:unknown,operationId:string){
  const v=inventoryCorrectionSchema.parse(body);
  return inventoryOperation(actor,operationId,"movement.correct","inventory.adjust",{id,...v},async tx=>{
    const [m]=await tx`select * from inventory.movements where business_id=${actor.businessId} and id=${id}`;if(!m)throw missing();
    if(m.kind==='DELIVERY')throw conflict("La entrega se corrige mediante el contrato causal del dominio propietario");
    if((await tx`select 1 from inventory.movements where corrects_id=${id}`).length)throw conflict("Ese movimiento ya tiene una corrección");
    const rows=await tx`select sku,location_id,purpose,delta from inventory.entries where movement_id=${id}`;
    const lines=rows.map(r=>({sku:String(r.sku),locationId:String(r.location_id),purpose:r.purpose as StockPurpose,delta:-Number(r.delta)}));
    return physicalEvent(tx,actor,operationId,'CORRECTION',lines,v.reason,new Date().toISOString(),{correctsId:id,allowNegative:true});
  });
}
export async function createCount(actor:Actor,body:unknown,operationId:string){
  const v=inventoryCountSchema.parse(body);
  return inventoryOperation(actor,operationId,"count.create","inventory.operate",v,async tx=>{
    await item(tx,actor,v.sku);await location(tx,actor,v.locationId);const p=await position(tx,actor.businessId,v);
    checkVersion(p.version,v.expectedVersion);
    if(v.previousCountId){const [old]=await tx`select id from inventory.counts where business_id=${actor.businessId} and id=${v.previousCountId} and sku=${v.sku} and location_id=${v.locationId} and purpose=${v.purpose}`;if(!old)throw missing();}
    const [row]=await tx`insert into inventory.counts(business_id,sku,location_id,purpose,observed,reference_quantity,reference_version,observed_at,actor_account_id,operation_id,reason,previous_count_id) values(${actor.businessId},${v.sku},${v.locationId},${v.purpose},${v.observedQuantity},${p.physical},${p.version},${v.observedAt},${actor.accountId},${operationId},${v.reason},${v.previousCountId??null}) returning id`;
    return {countId:row!.id,difference:v.observedQuantity-p.physical,referenceVersion:p.version};
  });
}
export async function adjustCount(actor:Actor,id:string,body:unknown,operationId:string){
  const v=inventoryCountAdjustSchema.parse(body);
  return inventoryOperation(actor,operationId,"count.adjust","inventory.adjust",{id,...v},async tx=>{
    const [c]=await tx`select * from inventory.counts where business_id=${actor.businessId} and id=${id}`;if(!c)throw missing();
    if((await tx`select 1 from inventory.adjustments where count_id=${id}`).length)throw conflict("Ese recuento ya fue confirmado");
    const line={sku:String(c.sku),locationId:String(c.location_id),purpose:c.purpose as StockPurpose};
    const p=await position(tx,actor.businessId,line);checkVersion(p.version,Number(c.reference_version));checkVersion(p.version,v.expectedVersion);
    const delta=Number(c.observed)-p.physical;
    const result=delta?await physicalEvent(tx,actor,operationId,'ADJUSTMENT',[{...line,delta}],v.reason,new Date().toISOString(),{sourceReference:id,allowNegative:true}):{movementId:null,discrepancy:false};
    await tx`insert into inventory.adjustments(business_id,count_id,movement_id,operation_id) values(${actor.businessId},${id},${result.movementId},${operationId})`;
    return {...result,countId:id,difference:delta};
  });
}
export async function setMinimum(actor:Actor,body:unknown,operationId:string){
  const v=inventoryMinimumSchema.parse(body);
  return inventoryOperation(actor,operationId,"minimum.set","inventory.manage",v,async tx=>{
    await item(tx,actor,v.sku,false);if(v.locationId)await location(tx,actor,v.locationId,false);
    if(v.quantity===null){await tx`delete from inventory.minimums where business_id=${actor.businessId} and sku=${v.sku} and location_id is not distinct from ${v.locationId}`;return {configured:false};}
    await tx`insert into inventory.minimums(business_id,sku,location_id,quantity) values(${actor.businessId},${v.sku},${v.locationId},${v.quantity}) on conflict(business_id,sku,location_id) do update set quantity=excluded.quantity,revision=inventory.minimums.revision+1`;
    return {configured:true};
  });
}
