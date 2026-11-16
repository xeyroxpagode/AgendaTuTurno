/** Internal transaction primitives for H05/H06. Caller supplies its already
 * authorized business transaction and causal reference. No HTTP creation API.
 * Lock this business before any other Inventory primitive in that transaction.
 * H06 must confirm/deliver ALL order lines in the same transaction (V1).
 */
import { z } from "zod";
import { positiveStockQuantity, inventoryLineSchema } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";
import { conflict, item, location, lockInventory, missing, requireInventory } from "./domain.js";
import { physicalEvent, position } from "./commands.js";

const commitmentInput = inventoryLineSchema.extend({ sourceReference:z.string().trim().min(3).max(200) }).strict();
export async function confirmStockCommitment(tx:Tx,actor:Actor,operationId:string,body:unknown){
  requireInventory(actor,'inventory.operate');const v=commitmentInput.parse(body);
  await lockInventory(tx,actor.businessId);const i=await item(tx,actor,v.sku);await location(tx,actor,v.locationId);
  if(v.purpose!=='SALE'||i.use==='INTERNAL')throw conflict("El compromiso requiere unidades para venta");
  const [old]=await tx`select * from inventory.commitments where business_id=${actor.businessId} and source_reference=${v.sourceReference} and sku=${v.sku} and location_id=${v.locationId}`;
  if(old){if(Number(old.quantity)!==v.quantity)throw conflict("La referencia ya fue usada con otra cantidad");return {commitmentId:String(old.id),state:String(old.state)};}
  const p=await position(tx,actor.businessId,v);if(p.physical-p.committed<v.quantity)throw conflict("Stock vendible insuficiente");
  const [row]=await tx`insert into inventory.commitments(business_id,source_reference,sku,location_id,quantity,operation_id) values(${actor.businessId},${v.sourceReference},${v.sku},${v.locationId},${v.quantity},${operationId}) returning id`;
  return {commitmentId:String(row!.id),state:'ACTIVE'};
}
export async function releaseStockCommitment(tx:Tx,actor:Actor,id:string){
  requireInventory(actor,'inventory.operate');await lockInventory(tx,actor.businessId);
  const [c]=await tx`select * from inventory.commitments where business_id=${actor.businessId} and id=${id}`;if(!c)throw missing();
  if(c.state==='DELIVERED')throw conflict("La entrega física ya fue registrada");
  if(c.state==='ACTIVE')await tx`update inventory.commitments set state='RELEASED',revision=revision+1 where id=${id}`;
  return {commitmentId:id,state:'RELEASED'};
}
export async function deliverStockCommitment(tx:Tx,actor:Actor,id:string,operationId:string,quantity:number){
  requireInventory(actor,'inventory.operate');positiveStockQuantity.parse(quantity);await lockInventory(tx,actor.businessId);
  const [c]=await tx`select * from inventory.commitments where business_id=${actor.businessId} and id=${id}`;if(!c)throw missing();
  if(Number(c.quantity)!==quantity)throw conflict("V1 requiere la entrega completa del compromiso");
  if(c.state==='DELIVERED')return {commitmentId:id,movementId:String(c.delivery_movement_id),state:'DELIVERED'};
  if(c.state!=='ACTIVE')throw conflict("El compromiso fue liberado");
  const siblings=await tx`select id from inventory.commitments where business_id=${actor.businessId} and source_reference=${c.source_reference} and id<>${id}`;
  if(siblings.length)throw conflict('La referencia contiene varias líneas: entregá el conjunto completo de compromisos');
  const line={sku:String(c.sku),locationId:String(c.location_id),purpose:'SALE' as const};const p=await position(tx,actor.businessId,line);
  if(p.physical<quantity)throw conflict("Las existencias físicas cambiaron; resolvé la discrepancia antes de entregar");
  // Release this reservation before validating the physical outbound; transaction is atomic.
  await tx`update inventory.commitments set state='RELEASED',revision=revision+1 where id=${id}`;
  const result=await physicalEvent(tx,actor,operationId,'DELIVERY',[{...line,delta:-quantity}],'Entrega física confirmada',new Date().toISOString(),{sourceReference:id});
  await tx`update inventory.commitments set state='DELIVERED',delivery_movement_id=${result.movementId},revision=revision+1 where id=${id}`;
  return {...result,commitmentId:id,state:'DELIVERED'};
}

/** Atomic all-or-nothing primitives for a complete future order. H06 supplies
 * the complete validated line set; Inventory never creates a ProductOrder. */
export async function confirmStockCommitments(tx:Tx,actor:Actor,operationId:string,lines:unknown[]){
  if(!lines.length||lines.length>50)throw conflict('El compromiso requiere entre 1 y 50 líneas');
  await lockInventory(tx,actor.businessId);
  const results=[];for(const line of lines)results.push(await confirmStockCommitment(tx,actor,operationId,line));return results;
}
export async function deliverStockCommitments(tx:Tx,actor:Actor,ids:string[],operationId:string){
  requireInventory(actor,'inventory.operate');await lockInventory(tx,actor.businessId);
  if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw conflict('Seleccioná el conjunto completo de compromisos');
  const rows=await tx`select * from inventory.commitments where business_id=${actor.businessId} and id=any(${ids}) order by id`;
  if(rows.length!==ids.length)throw missing();
  if(rows.every(c=>c.state==='DELIVERED')&&new Set(rows.map(c=>c.delivery_movement_id)).size===1)return {movementId:String(rows[0]!.delivery_movement_id),state:'DELIVERED'};
  if(rows.some(c=>c.state!=='ACTIVE'))throw conflict('V1 requiere la entrega completa, sin compromisos liberados o ya entregados');
  const sources=new Set(rows.map(c=>c.source_reference));if(sources.size!==1)throw conflict('Las líneas deben pertenecer a la misma referencia causal');
  const outstanding=await tx`select id from inventory.commitments where business_id=${actor.businessId} and source_reference=${rows[0]!.source_reference}`;
  if(outstanding.length!==rows.length)throw conflict('V1 no permite entregar sólo parte de las líneas de la referencia');
  await tx`update inventory.commitments set state='RELEASED',revision=revision+1 where business_id=${actor.businessId} and id=any(${ids})`;
  const result=await physicalEvent(tx,actor,operationId,'DELIVERY',rows.map(c=>({sku:String(c.sku),locationId:String(c.location_id),purpose:'SALE' as const,delta:-Number(c.quantity)})),'Entrega física completa',new Date().toISOString(),{sourceReference:String(rows[0]!.source_reference)});
  await tx`update inventory.commitments set state='DELIVERED',delivery_movement_id=${result.movementId},revision=revision+1 where business_id=${actor.businessId} and id=any(${ids})`;
  return {...result,state:'DELIVERED'};
}
