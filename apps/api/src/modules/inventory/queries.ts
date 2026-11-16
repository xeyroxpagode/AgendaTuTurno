import { inventoryQuerySchema, stockCriticality } from "@youngkingz/contracts";
import { database } from "../../lib/runtime.js";
import type { Actor } from "../iam/authorization.js";
import { missing, requireInventory } from "./domain.js";

export async function inventorySnapshot(actor:Actor){
  requireInventory(actor,'inventory.read');
  // REPEATABLE READ ensures counts, positions and commitments describe the same snapshot.
  return database.client.begin('isolation level repeatable read read only',async tx=>{
    const barber=actor.role==='BARBER';
    const locations=await tx`select l.id,l.name,l.staff_member_id "staffMemberId",l.active,l.revision::int revision,
      (select concat(p.first_name,' ',p.last_name) from team.staff_members s join iam.persons p on p.id=s.person_id where s.id=l.staff_member_id) "professionalName"
      from inventory.locations l where l.business_id=${actor.businessId}
      and (${!barber} or l.staff_member_id is null or l.staff_member_id=${actor.staffMemberId} or exists(select 1 from inventory.location_access a where a.business_id=l.business_id and a.location_id=l.id and a.staff_member_id=${actor.staffMemberId})) order by l.name`;
    const ids=locations.map(l=>String(l.id));
    const minimums=await tx`select sku,location_id,quantity from inventory.minimums where business_id=${actor.businessId}`;
    const positions=await tx`select p.sku,p.location_id "locationId",p.purpose,p.physical,p.version::int version,
      case when p.purpose='SALE' then (select coalesce(sum(c.quantity),0)::int from inventory.commitments c where c.business_id=p.business_id and c.sku=p.sku and c.location_id=p.location_id and c.state='ACTIVE') else 0 end committed,
      (select m.quantity from inventory.minimums m where m.business_id=p.business_id and m.sku=p.sku and m.location_id=p.location_id) minimum
      from inventory.positions p join inventory.items i on i.business_id=p.business_id and i.sku=p.sku
      where p.business_id=${actor.businessId} and p.location_id=any(${ids}) and (${!barber} or (p.purpose='INTERNAL' and i.use<>'SALE'))`;
    const items=await tx`select id,sku,name,description,category,use,unit,parent_id "parentId",active,published,price_minor "priceMinor",
      ${actor.capabilities.has('inventory.cost.read')?tx`cost_minor`:tx`null::int`} "costMinor", image_url "imageUrl",revision::int revision,
      (select m.quantity from inventory.minimums m where m.business_id=i.business_id and m.sku=i.sku and m.location_id is null) minimum
      from inventory.items i where business_id=${actor.businessId} and (${!barber} or use<>'SALE') order by name,sku`;
    const enriched=items.map(i=>{
      const ps=positions.filter(p=>p.sku===i.sku);const physical=ps.reduce((s,p)=>s+Number(p.physical),0);const committed=ps.reduce((s,p)=>s+Number(p.committed),0);
      const salePhysical=ps.filter(p=>p.purpose==='SALE').reduce((s,p)=>s+Number(p.physical),0);
      const locationStates=locations.map(l=>{const local=ps.filter(p=>p.locationId===l.id);const total=local.reduce((sum,p)=>sum+Number(p.physical),0);const minimum=minimums.find(m=>m.sku===i.sku&&m.location_id===l.id)?.quantity;return {physical:total,minimum:minimum==null?null:Number(minimum)};});
      const globalShortage=i.minimum===null?0:Math.max(0,Number(i.minimum)-physical);
      const locationShortage=locationStates.reduce((sum,p)=>sum+(p.minimum===null?0:Math.max(0,p.minimum-p.physical)),0);
      const base=stockCriticality(physical,i.minimum===null?null:Number(i.minimum),ps.length>0);
      return {...i,physical,committed,sellable:Math.max(0,salePhysical-committed),salePhysical,internalPhysical:physical-salePhysical,
        shortage:Math.max(globalShortage,locationShortage),criticality:locationStates.some(p=>p.physical<0)?'NEGATIVE':locationShortage>0&&base!=='ZERO'?'LOW':base};
    });
    const counts=barber?[]:await tx`select c.id,c.sku,c.location_id "locationId",c.purpose,c.observed,c.reference_quantity "referenceQuantity",c.reference_version::int "referenceVersion",c.observed_at "observedAt",c.reason,c.previous_count_id "previousCountId",
      a.operation_id is not null adjusted,coalesce(p.version,0)::int "currentVersion",coalesce(p.physical,0) "currentPhysical"
      from inventory.counts c left join inventory.adjustments a on a.count_id=c.id
      left join inventory.positions p on p.business_id=c.business_id and p.sku=c.sku and p.location_id=c.location_id and p.purpose=c.purpose
      where c.business_id=${actor.businessId} order by c.created_at desc limit 100`;
    const professionals=await tx`select s.id,concat(p.first_name,' ',p.last_name) name from team.staff_members s join iam.persons p on p.id=s.person_id where s.business_id=${actor.businessId} and s.employment_status='ACTIVE' and (${!barber} or s.id=${actor.staffMemberId}) order by name`;
    return {items:enriched,locations,positions:positions.map(p=>({...p,sellable: p.purpose==='SALE'?Math.max(0,Number(p.physical)-Number(p.committed)):0,
      criticality:stockCriticality(positions.filter(other=>other.sku===p.sku&&other.locationId===p.locationId).reduce((sum,other)=>sum+Number(other.physical),0),p.minimum===null?null:Number(p.minimum))})),counts,professionals};
  });
}
export async function listMovements(actor:Actor,query:unknown){
  requireInventory(actor,'inventory.read');const q=inventoryQuerySchema.parse(query);const barber=actor.role==='BARBER';
  const rows=await database.client`select m.id,m.kind,m.reason,m.effective_at "effectiveAt",m.created_at "createdAt",m.operation_id "operationId",m.source_reference "sourceReference",m.corrects_id "correctsId",m.discrepancy,
    concat(p.first_name,' ',p.last_name) "actorName",c.used_by_staff_member_id "usedByStaffMemberId",c.attendance_id "attendanceId",
    exists(select 1 from inventory.movements r where r.corrects_id=m.id) corrected,
    (select jsonb_agg(jsonb_build_object('sku',e.sku,'locationId',e.location_id,'purpose',e.purpose,'delta',e.delta,'version',e.position_version)) from inventory.entries e where e.movement_id=m.id) entries
    from inventory.movements m join iam.user_accounts ua on ua.id=m.actor_account_id join iam.persons p on p.id=ua.person_id
    left join inventory.consumptions c on c.movement_id=m.id
    where m.business_id=${actor.businessId} and (${!barber} or (c.used_by_staff_member_id=${actor.staffMemberId} and m.kind='CONSUMPTION'))
    and (${q.sku??null}::text is null or exists(select 1 from inventory.entries e where e.movement_id=m.id and e.sku=${q.sku??null}))
    ${q.before?database.client`and (m.created_at,m.id)<(select created_at,id from inventory.movements where business_id=${actor.businessId} and id=${q.before})`:database.client``}
    order by m.created_at desc,m.id desc limit ${q.limit+1}`;
  return {items:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?String(rows[q.limit-1]!.id):null};
}
export async function inventoryOperationStatus(actor:Actor,id:string){
  requireInventory(actor,'inventory.read');
  const [r]=await database.client`select operation_id "operationId",status::text status,response_body "responseBody",response_status "responseStatus",error_code "errorCode" from system.operation_attempts where business_id=${actor.businessId} and actor_account_id=${actor.accountId} and operation_id=${id} and command_name like 'inventory.%'`;
  if(!r)throw missing();return r;
}
export async function listCommitments(actor:Actor){
  requireInventory(actor,'inventory.operate');
  return {items:await database.client`select id,sku,location_id "locationId",quantity,state,source_reference "sourceReference",revision::int revision from inventory.commitments where business_id=${actor.businessId} order by id limit 100`};
}
export async function reconcileInventory(actor:Actor){
  requireInventory(actor,'inventory.manage');
  const differences=await database.client`select coalesce(p.sku,r.sku) sku,coalesce(p.location_id,r.location_id) "locationId",coalesce(p.purpose,r.purpose) purpose,p.physical "projectedPhysical",r.physical "ledgerPhysical",p.version "projectedVersion",r.version "ledgerVersion"
    from inventory.positions p full join inventory.reconstructed_positions r using(business_id,sku,location_id,purpose)
    where coalesce(p.business_id,r.business_id)=${actor.businessId} and (p.physical is distinct from r.physical or p.version is distinct from r.version)`;
  return {consistent:differences.length===0,differences};
}
