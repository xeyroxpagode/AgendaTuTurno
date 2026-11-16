import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, pgSchema, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { businesses, operationAttempts, staffMembers } from "./base.js";
import { attendances } from "./attendance.js";
export const inventorySchema=pgSchema('inventory');
const businessId=()=>uuid('business_id').notNull().references(()=>businesses.id);
const revision=()=>bigint('revision',{mode:'number'}).notNull().default(1);
const createdAt=()=>timestamp('created_at',{withTimezone:true}).notNull().defaultNow();
export const inventoryItems=inventorySchema.table('items',{
  id:uuid('id').primaryKey().defaultRandom(),businessId:businessId(),sku:text('sku').notNull(),name:text('name').notNull(),description:text('description').notNull().default(''),category:text('category').notNull().default(''),
  use:text('use').notNull(),unit:text('unit').notNull().default('unidad'),parentId:uuid('parent_id'),active:boolean('active').notNull().default(true),published:boolean('published').notNull().default(false),
  priceMinor:integer('price_minor'),costMinor:integer('cost_minor'),imageUrl:text('image_url'),revision:revision(),createdAt:createdAt(),
},t=>[unique().on(t.businessId,t.id),unique().on(t.businessId,t.sku),check('inventory_item_use',sql`${t.use} in ('SALE','INTERNAL','MIXED')`),check('inventory_item_unit',sql`${t.unit}='unidad'`),
  check('inventory_item_price',sql`${t.use}='INTERNAL' or ${t.priceMinor} is not null`),check('inventory_item_published',sql`not ${t.published} or (${t.active} and ${t.use}<>'INTERNAL')`),
  foreignKey({columns:[t.businessId,t.parentId],foreignColumns:[t.businessId,t.id]})]);
export const inventoryLocations=inventorySchema.table('locations',{
  id:uuid('id').primaryKey().defaultRandom(),businessId:businessId(),name:text('name').notNull(),staffMemberId:uuid('staff_member_id'),active:boolean('active').notNull().default(true),revision:revision(),
},t=>[unique().on(t.businessId,t.id),unique().on(t.businessId,t.name),foreignKey({columns:[t.businessId,t.staffMemberId],foreignColumns:[staffMembers.businessId,staffMembers.id]})]);
export const inventoryLocationAccess=inventorySchema.table('location_access',{
  businessId:businessId(),locationId:uuid('location_id').notNull(),staffMemberId:uuid('staff_member_id').notNull(),
},t=>[primaryKey({columns:[t.businessId,t.locationId,t.staffMemberId]}),foreignKey({columns:[t.businessId,t.locationId],foreignColumns:[inventoryLocations.businessId,inventoryLocations.id]}),foreignKey({columns:[t.businessId,t.staffMemberId],foreignColumns:[staffMembers.businessId,staffMembers.id]})]);
export const inventoryMovements=inventorySchema.table('movements',{
  id:uuid('id').primaryKey().defaultRandom(),businessId:businessId(),kind:text('kind').notNull(),operationId:uuid('operation_id').notNull().unique(),actorAccountId:uuid('actor_account_id').notNull(),reason:text('reason').notNull(),
  effectiveAt:timestamp('effective_at',{withTimezone:true}).notNull(),createdAt:createdAt(),sourceReference:text('source_reference'),correctsId:uuid('corrects_id').unique(),discrepancy:boolean('discrepancy').notNull().default(false),
},t=>[unique().on(t.businessId,t.id),unique().on(t.businessId,t.id,t.operationId),foreignKey({columns:[t.businessId,t.operationId],foreignColumns:[operationAttempts.businessId,operationAttempts.operationId]}),
  foreignKey({columns:[t.businessId,t.correctsId],foreignColumns:[t.businessId,t.id]}),check('inventory_movement_kind',sql`${t.kind} in ('OPENING','RECEIPT','CONSUMPTION','LOSS','RETURN','TRANSFER','REALLOCATE','ISSUE','ADJUSTMENT','CORRECTION','DELIVERY')`),
  index('inventory_movements_recent').on(t.businessId,t.createdAt,t.id)]);
export const inventoryEntries=inventorySchema.table('entries',{
  id:uuid('id').primaryKey().defaultRandom(),businessId:businessId(),movementId:uuid('movement_id').notNull(),sku:text('sku').notNull(),locationId:uuid('location_id').notNull(),purpose:text('purpose').notNull(),delta:integer('delta').notNull(),positionVersion:bigint('position_version',{mode:'number'}).notNull(),
},t=>[foreignKey({columns:[t.businessId,t.movementId],foreignColumns:[inventoryMovements.businessId,inventoryMovements.id]}),foreignKey({columns:[t.businessId,t.sku],foreignColumns:[inventoryItems.businessId,inventoryItems.sku]}),foreignKey({columns:[t.businessId,t.locationId],foreignColumns:[inventoryLocations.businessId,inventoryLocations.id]}),
  unique().on(t.businessId,t.sku,t.locationId,t.purpose,t.positionVersion),check('inventory_entry_delta',sql`${t.delta}<>0 and ${t.delta} between -1000000000 and 1000000000`),check('inventory_entry_purpose',sql`${t.purpose} in ('SALE','INTERNAL')`)]);
export const inventoryPositions=inventorySchema.table('positions',{
  businessId:businessId(),sku:text('sku').notNull(),locationId:uuid('location_id').notNull(),purpose:text('purpose').notNull(),physical:integer('physical').notNull().default(0),version:bigint('version',{mode:'number'}).notNull().default(0),
},t=>[primaryKey({columns:[t.businessId,t.sku,t.locationId,t.purpose]}),foreignKey({columns:[t.businessId,t.sku],foreignColumns:[inventoryItems.businessId,inventoryItems.sku]}),foreignKey({columns:[t.businessId,t.locationId],foreignColumns:[inventoryLocations.businessId,inventoryLocations.id]}),check('inventory_position_range',sql`${t.physical} between -1000000000 and 1000000000`)]);
export const inventoryConsumptions=inventorySchema.table('consumptions',{
  id:uuid('id').primaryKey().defaultRandom(),businessId:businessId(),movementId:uuid('movement_id').notNull().unique(),operationId:uuid('operation_id').notNull().unique(),attendanceId:uuid('attendance_id'),attendanceRevision:bigint('attendance_revision',{mode:'number'}),usedByStaffMemberId:uuid('used_by_staff_member_id').notNull(),
},t=>[unique().on(t.businessId,t.id),foreignKey({columns:[t.businessId,t.movementId,t.operationId],foreignColumns:[inventoryMovements.businessId,inventoryMovements.id,inventoryMovements.operationId]}),foreignKey({columns:[t.businessId,t.attendanceId],foreignColumns:[attendances.businessId,attendances.id]}),foreignKey({columns:[t.businessId,t.usedByStaffMemberId],foreignColumns:[staffMembers.businessId,staffMembers.id]})]);
export const inventoryCounts=inventorySchema.table('counts',{
  id:uuid('id').primaryKey().defaultRandom(),businessId:businessId(),sku:text('sku').notNull(),locationId:uuid('location_id').notNull(),purpose:text('purpose').notNull(),observed:integer('observed').notNull(),referenceQuantity:integer('reference_quantity').notNull(),referenceVersion:bigint('reference_version',{mode:'number'}).notNull(),observedAt:timestamp('observed_at',{withTimezone:true}).notNull(),createdAt:createdAt(),actorAccountId:uuid('actor_account_id').notNull(),operationId:uuid('operation_id').notNull().unique(),reason:text('reason').notNull(),previousCountId:uuid('previous_count_id'),
},t=>[unique().on(t.businessId,t.id),foreignKey({columns:[t.businessId,t.sku],foreignColumns:[inventoryItems.businessId,inventoryItems.sku]}),foreignKey({columns:[t.businessId,t.locationId],foreignColumns:[inventoryLocations.businessId,inventoryLocations.id]}),foreignKey({columns:[t.businessId,t.operationId],foreignColumns:[operationAttempts.businessId,operationAttempts.operationId]}),foreignKey({columns:[t.businessId,t.previousCountId],foreignColumns:[t.businessId,t.id]})]);
export const inventoryAdjustments=inventorySchema.table('adjustments',{
  businessId:businessId(),countId:uuid('count_id').primaryKey(),movementId:uuid('movement_id').unique(),operationId:uuid('operation_id').notNull().unique(),
},t=>[foreignKey({columns:[t.businessId,t.countId],foreignColumns:[inventoryCounts.businessId,inventoryCounts.id]}),foreignKey({columns:[t.businessId,t.movementId,t.operationId],foreignColumns:[inventoryMovements.businessId,inventoryMovements.id,inventoryMovements.operationId]})]);
export const inventoryMinimums=inventorySchema.table('minimums',{
  id:uuid('id').primaryKey().defaultRandom(),businessId:businessId(),sku:text('sku').notNull(),locationId:uuid('location_id'),quantity:integer('quantity').notNull(),revision:revision(),
},t=>[unique().on(t.businessId,t.sku,t.locationId).nullsNotDistinct(),foreignKey({columns:[t.businessId,t.sku],foreignColumns:[inventoryItems.businessId,inventoryItems.sku]}),foreignKey({columns:[t.businessId,t.locationId],foreignColumns:[inventoryLocations.businessId,inventoryLocations.id]}),check('inventory_minimum_range',sql`${t.quantity} between 0 and 1000000000`)]);
export const inventoryCommitments=inventorySchema.table('commitments',{
  id:uuid('id').primaryKey().defaultRandom(),businessId:businessId(),sourceReference:text('source_reference').notNull(),sku:text('sku').notNull(),locationId:uuid('location_id').notNull(),quantity:integer('quantity').notNull(),state:text('state').notNull().default('ACTIVE'),revision:revision(),operationId:uuid('operation_id').notNull(),deliveryMovementId:uuid('delivery_movement_id'),
},t=>[unique().on(t.businessId,t.id),unique().on(t.businessId,t.sourceReference,t.sku,t.locationId),foreignKey({columns:[t.businessId,t.sku],foreignColumns:[inventoryItems.businessId,inventoryItems.sku]}),foreignKey({columns:[t.businessId,t.locationId],foreignColumns:[inventoryLocations.businessId,inventoryLocations.id]}),foreignKey({columns:[t.businessId,t.operationId],foreignColumns:[operationAttempts.businessId,operationAttempts.operationId]}),foreignKey({columns:[t.businessId,t.deliveryMovementId],foreignColumns:[inventoryMovements.businessId,inventoryMovements.id]}),check('inventory_commitment_state',sql`${t.state} in ('ACTIVE','RELEASED','DELIVERED')`)]);
