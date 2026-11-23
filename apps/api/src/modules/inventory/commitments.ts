/** Internal transaction primitives for H05/H06. Caller supplies its already
 * authorized business transaction and causal reference. No HTTP creation API.
 * Lock this business before any other Inventory primitive in that transaction.
 * H06 must confirm/deliver ALL order lines in the same transaction (V1).
 *
 * ── H05 · COR-03 / RATIFICACIÓN DE ACTOR B (RTB-06) ────────────────────────
 * `confirmStockCommitment` / `deliverStockCommitment` / `deliverStockCommitments`
 * aceptan una autoridad de EJECUCIÓN. Por defecto (sin `authority`) el
 * comportamiento es EXACTAMENTE el de H04: se exige `inventory.operate` del
 * actor llamante. Ese camino no cambia en absoluto.
 *
 * La autoridad alternativa `CHECKOUT` existe para que la frontera interna
 * H05→H04 ejecute la entrega física de UN checkout autorizado SIN exigir
 * `inventory.operate` al operador comercial (F37/D24). No es un bypass:
 *  · la autoridad se revalida contra PostgreSQL DENTRO de la transacción;
 *  · el actor real se conserva para auditoría (`actor_account_id`,
 *    `system.audit_events`) y para la referencia causal;
 *  · sólo habilita el efecto físico de ESA venta concreta: el SKU, la
 *    ubicación y la cantidad deben coincidir con las líneas de la venta del
 *    checkout; el checkout debe ser del mismo Business y no puede reutilizar
 *    su autoridad;
 *  · no habilita ajustes, pérdidas, consumos arbitrarios ni correcciones.
 *
 * No existe `backendPrincipal`, `systemActor`, `skipAuthorization` ni
 * endpoint público de commit/deliver.
 */
import { z } from "zod";
import { DomainError, positiveStockQuantity, inventoryLineSchema } from "@youngkingz/contracts";
import type { Actor } from "../iam/authorization.js";
import type { Tx } from "../system/operations.js";
import { conflict, item, location, lockInventory, missing, requireInventory } from "./domain.js";
import { physicalEvent, position } from "./commands.js";
import { assertActorStillAuthorized } from "../h05/domain.js";

/**
 * Autoridad de ejecución de un checkout ya validado. La emite el servidor y
 * se revalida contra PostgreSQL en cada uso: un identificador aportado por
 * el cliente NO constituye autoridad.
 */
export type CheckoutAuthority = {
  checkoutId: string;
  businessId: string;
  operationId: string;
  sourceReference: string;
  actorAccountId: string;
};

/**
 * H06 · autoridad de ejecución de UN pedido ya validado. Es un dato de
 * SERVIDOR revalidado contra PostgreSQL dentro de la transacción. No concede
 * `inventory.operate`: la capability que se revalida es la del comando H06
 * (`orders.confirm`, `orders.cancel`, …) y queda ligada a `order:<id>`.
 */
export type OrderAuthority = {
  orderId: string;
  businessId: string;
  operationId: string;
  expectedSourceReference: string;
  actorAccountId: string;
  capability: "orders.confirm" | "orders.cancel" | "orders.cancel_confirmed" | "orders.ready" | "orders.deliver";
};

export type ExecutionAuthority =
  | { kind: "ACTOR" }
  | { kind: "CHECKOUT"; checkoutAuth: CheckoutAuthority }
  | { kind: "ORDER"; orderAuth: OrderAuthority };

const commitmentInput = inventoryLineSchema.extend({ sourceReference:z.string().trim().min(3).max(200) }).strict();

/**
 * Valida la autoridad de ejecución.
 *
 * · `ACTOR` → comportamiento H04 intacto: `inventory.operate` del llamante.
 * · `CHECKOUT` → el checkout debe existir en el Business del actor, su
 *   `operation_id` y `source_reference` deben coincidir, no puede haber sido
 *   entregado ya, y el actor debe conservar `checkout.create` vigente en este
 *   mismo instante.
 */
async function assertExecutionAuthority(tx:Tx,actor:Actor,operationId:string,authority:ExecutionAuthority|undefined):Promise<void>{
  if(!authority||authority.kind==="ACTOR"){requireInventory(actor,'inventory.operate');return;}
  if(authority.kind==="ORDER"){
    const auth=authority.orderAuth;
    if(auth.businessId!==actor.businessId)throw new DomainError("COMMITMENT_BUSINESS_MISMATCH","La autoridad del pedido no pertenece a este negocio",403);
    if(auth.actorAccountId!==actor.accountId)throw new DomainError("ORDER_NOT_OWNED","La autoridad del pedido no corresponde al operador",403);
    const [order]=await tx`select id,operation_id "operationId",status::text status from orders.product_orders where business_id=${actor.businessId} and id=${auth.orderId} for update`;
    if(!order)throw new DomainError("ORDER_NOT_FOUND","El pedido no existe en este negocio",404);
    if(String(order.operationId)!==auth.operationId)throw new DomainError("ORDER_NOT_OWNED","La autoridad no coincide con el pedido",403);
    if(auth.expectedSourceReference!==`order:${auth.orderId}`)throw new DomainError("ORDER_NOT_OWNED","La referencia causal del pedido no es válida",403);
    await assertActorStillAuthorized(tx,actor,auth.capability);
    return;
  }
  const auth=authority.checkoutAuth;
  if(auth.businessId!==actor.businessId)throw new DomainError("COMMITMENT_BUSINESS_MISMATCH","La autoridad de checkout no pertenece a este negocio",403);
  if(auth.actorAccountId!==actor.accountId)throw new DomainError("CHECKOUT_AUTH_INVALID","La autoridad de checkout no corresponde al operador",403);
  // `operationId` es el intento de EJECUCIÓN (un durable attempt aparte,
  // validado por el protocolo de recovery). La autoridad se valida contra
  // el `operation_id` del checkout original, que es lo que prueba que el
  // checkout existe y pertenece a este intento comercial.
  const [checkout]=await tx`select id,operation_id "operationId",source_reference "sourceReference",sale_id "saleId",status::text status,money_operation_id "moneyOperationId" from checkout.checkouts where business_id=${actor.businessId} and id=${auth.checkoutId} for update`;
  if(!checkout)throw new DomainError("CHECKOUT_AUTH_INVALID","El checkout no existe en este negocio",403);
  if(String(checkout.operationId)!==auth.operationId||String(checkout.sourceReference)!==auth.sourceReference)throw new DomainError("CHECKOUT_AUTH_INVALID","La autoridad de checkout no coincide con el checkout",403);
  if(String(checkout.status)==="DELIVERED")throw new DomainError("DELIVERY_DUPLICATED","La entrega de este checkout ya fue registrada",409);
  await assertActorStillAuthorized(tx,actor,'checkout.create');
}

/**
 * Valida que la línea entregada coincide EXACTAMENTE con una línea de
 * producto de la venta del checkout autorizado (mismo SKU, misma ubicación,
 * misma cantidad). Impide reutilizar la autoridad para otro SKU, otra
 * cantidad o una pérdida arbitraria.
 */
async function assertLineMatchesCheckoutSale(tx:Tx,actor:Actor,checkoutSaleId:string,sku:string,locationId:string,quantity:number):Promise<void>{
  const [line]=await tx`select quantity,sku,location_id "locationId" from sales.sale_lines where business_id=${actor.businessId} and sale_id=${checkoutSaleId} and kind='PRODUCT' and sku=${sku} and location_id=${locationId} and superseded_at is null`;
  if(!line)throw new DomainError("DELIVERY_SKU_MISMATCH","El SKU o la ubicación no corresponde a la venta autorizada",409);
  if(Number(line.quantity)!==quantity)throw new DomainError("DELIVERY_QUANTITY_MISMATCH","La cantidad no corresponde a la línea autorizada de la venta",409);
}

export async function confirmStockCommitment(tx:Tx,actor:Actor,operationId:string,body:unknown,authority?:ExecutionAuthority){
  await assertExecutionAuthority(tx,actor,operationId,authority);
  const v=commitmentInput.parse(body);
  if(authority?.kind==="ORDER"&&v.sourceReference!==authority.orderAuth.expectedSourceReference)throw new DomainError("ORDER_NOT_OWNED","La línea no pertenece a la referencia causal del pedido",403);
  await lockInventory(tx,actor.businessId);const i=await item(tx,actor,v.sku);await location(tx,actor,v.locationId);
  if(v.purpose!=='SALE'||i.use==='INTERNAL')throw conflict("El compromiso requiere unidades para venta");
  if(authority?.kind==="CHECKOUT"){
    const [checkout]=await tx`select sale_id "saleId" from checkout.checkouts where business_id=${actor.businessId} and id=${authority.checkoutAuth.checkoutId}`;
    await assertLineMatchesCheckoutSale(tx,actor,String(checkout!.saleId),v.sku,v.locationId,v.quantity);
  }
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
/**
 * H06 · liberación MULTILÍNEA simétrica con autoridad ORDER. Usa el Tx del
 * llamador (misma transacción que `order.cancel`), exige el conjunto completo
 * de compromisos de la referencia causal y nunca toca movimientos físicos.
 * El camino `ACTOR` de `releaseStockCommitment` permanece intacto.
 */
export async function releaseStockCommitments(tx:Tx,actor:Actor,ids:string[],operationId:string,authority?:ExecutionAuthority){
  await assertExecutionAuthority(tx,actor,operationId,authority);
  if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw conflict('Seleccioná el conjunto completo de compromisos');
  await lockInventory(tx,actor.businessId);
  const rows=await tx`select id,state,source_reference "sourceReference" from inventory.commitments where business_id=${actor.businessId} and id=any(${ids}) order by id`;
  if(rows.length!==ids.length)throw missing();
  if(rows.every(c=>c.state==='RELEASED'))return {releasedIds:ids,state:'RELEASED' as const};
  if(rows.some(c=>c.state!=='ACTIVE'))throw conflict('Sólo se pueden liberar compromisos activos');
  const sources=new Set(rows.map(c=>String(c.sourceReference)));if(sources.size!==1)throw conflict('Las líneas deben pertenecer a la misma referencia causal');
  if(authority?.kind==="ORDER"&&String(rows[0]!.sourceReference)!==authority.orderAuth.expectedSourceReference)throw new DomainError("ORDER_NOT_OWNED","Los compromisos no pertenecen a este pedido",403);
  const outstanding=await tx`select id from inventory.commitments where business_id=${actor.businessId} and source_reference=${rows[0]!.sourceReference} and state='ACTIVE'`;
  if(outstanding.length!==rows.length)throw conflict('V1 requiere liberar el conjunto completo de compromisos');
  await tx`update inventory.commitments set state='RELEASED',revision=revision+1 where business_id=${actor.businessId} and id=any(${ids})`;
  return {releasedIds:ids,state:'RELEASED' as const};
}

export async function deliverStockCommitment(tx:Tx,actor:Actor,id:string,operationId:string,quantity:number,authority?:ExecutionAuthority){
  await assertExecutionAuthority(tx,actor,operationId,authority);
  positiveStockQuantity.parse(quantity);await lockInventory(tx,actor.businessId);
  const [c]=await tx`select * from inventory.commitments where business_id=${actor.businessId} and id=${id}`;if(!c)throw missing();
  if(Number(c.quantity)!==quantity)throw conflict("V1 requiere la entrega completa del compromiso");
  if(c.state==='DELIVERED')return {commitmentId:id,movementId:String(c.delivery_movement_id),state:'DELIVERED'};
  if(c.state!=='ACTIVE')throw conflict("El compromiso fue liberado");
  if(authority?.kind==="CHECKOUT"){
    const [checkout]=await tx`select sale_id "saleId" from checkout.checkouts where business_id=${actor.businessId} and id=${authority.checkoutAuth.checkoutId}`;
    await assertLineMatchesCheckoutSale(tx,actor,String(checkout!.saleId),String(c.sku),String(c.location_id),quantity);
    if(String(c.source_reference)!==authority.checkoutAuth.sourceReference)throw new DomainError("CHECKOUT_AUTH_INVALID","El compromiso no pertenece a este checkout",403);
  }
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
export async function confirmStockCommitments(tx:Tx,actor:Actor,operationId:string,lines:unknown[],authority?:ExecutionAuthority){
  if(!lines.length||lines.length>50)throw conflict('El compromiso requiere entre 1 y 50 líneas');
  await lockInventory(tx,actor.businessId);
  const results=[];for(const line of lines)results.push(await confirmStockCommitment(tx,actor,operationId,line,authority));return results;
}
export async function deliverStockCommitments(tx:Tx,actor:Actor,ids:string[],operationId:string,authority?:ExecutionAuthority){
  await assertExecutionAuthority(tx,actor,operationId,authority);
  if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw conflict('Seleccioná el conjunto completo de compromisos');
  const rows=await tx`select * from inventory.commitments where business_id=${actor.businessId} and id=any(${ids}) order by id`;
  if(rows.length!==ids.length)throw missing();
  if(rows.every(c=>c.state==='DELIVERED')&&new Set(rows.map(c=>c.delivery_movement_id)).size===1)return {movementId:String(rows[0]!.delivery_movement_id),state:'DELIVERED'};
  if(rows.some(c=>c.state!=='ACTIVE'))throw conflict('V1 requiere la entrega completa, sin compromisos liberados o ya entregados');
  const sources=new Set(rows.map(c=>c.source_reference));if(sources.size!==1)throw conflict('Las líneas deben pertenecer a la misma referencia causal');
  // T-27: la autoridad CHECKOUT/ORDER debe coincidir con la referencia de TODAS
  // las líneas, no sólo con que todas compartan una referencia entre sí.
  if(authority?.kind==="CHECKOUT"&&String(rows[0]!.source_reference)!==authority.checkoutAuth.sourceReference)throw new DomainError("CHECKOUT_AUTH_INVALID","Los compromisos no pertenecen a este checkout",403);
  if(authority?.kind==="ORDER"&&String(rows[0]!.source_reference)!==authority.orderAuth.expectedSourceReference)throw new DomainError("ORDER_NOT_OWNED","Los compromisos no pertenecen a este pedido",403);
  const outstanding=await tx`select id from inventory.commitments where business_id=${actor.businessId} and source_reference=${rows[0]!.source_reference}`;
  if(outstanding.length!==rows.length)throw conflict('V1 no permite entregar sólo parte de las líneas de la referencia');
  if(authority?.kind==="CHECKOUT"){
    const [checkout]=await tx`select sale_id "saleId" from checkout.checkouts where business_id=${actor.businessId} and id=${authority.checkoutAuth.checkoutId}`;
    for(const c of rows)await assertLineMatchesCheckoutSale(tx,actor,String(checkout!.saleId),String(c.sku),String(c.location_id),Number(c.quantity));
  }
  await tx`update inventory.commitments set state='RELEASED',revision=revision+1 where business_id=${actor.businessId} and id=any(${ids})`;
  const result=await physicalEvent(tx,actor,operationId,'DELIVERY',rows.map(c=>({sku:String(c.sku),locationId:String(c.location_id),purpose:'SALE' as const,delta:-Number(c.quantity)})),'Entrega física completa',new Date().toISOString(),{sourceReference:String(rows[0]!.source_reference)});
  await tx`update inventory.commitments set state='DELIVERED',delivery_movement_id=${result.movementId},revision=revision+1 where id=any(${ids})`;
  return {...result,state:'DELIVERED'};
}
