import { describe,expect,it } from 'vitest';
import { inventoryItemSchema, inventoryMovementSchema, inventoryConsumptionSchema, stockCriticality, stockQuantity, MAX_STOCK, roleCapabilities, grantableCapabilitiesByRole } from '@youngkingz/contracts';
describe('H04 whole-unit contracts and IAM',()=>{
  it('rejects fractions, overflow, NaN and infinity',()=>{for(const n of [-1,.5,MAX_STOCK+1,NaN,Infinity])expect(stockQuantity.safeParse(n).success).toBe(false);expect(stockQuantity.parse(0)).toBe(0);});
  it('normalizes SKU, requires sale price, rejects arbitrary stock fields',()=>{
    expect(inventoryItemSchema.parse({sku:'wax-1',name:'Cera',use:'INTERNAL'}).sku).toBe('WAX-1');
    expect(inventoryItemSchema.safeParse({sku:'A',name:'A',use:'SALE'}).success).toBe(false);
    expect(inventoryItemSchema.safeParse({sku:'A',name:'A',use:'INTERNAL',stock:10}).success).toBe(false);
  });
  it('distinguishes all criticality states including configured zero',()=>{
    expect(stockCriticality(0,null,false)).toBe('NO_POSITION');expect(stockCriticality(0,0)).toBe('ZERO');
    expect(stockCriticality(2,null)).toBe('UNCONFIGURED');expect(stockCriticality(2,0)).toBe('OK');expect(stockCriticality(2,3)).toBe('LOW');expect(stockCriticality(-1,null)).toBe('NEGATIVE');
  });
  it('supports independent consumption and rejects a forged business field',()=>{
    const v={sku:'A',locationId:crypto.randomUUID(),purpose:'INTERNAL',quantity:1,usedByStaffMemberId:crypto.randomUUID(),effectiveAt:new Date().toISOString(),reason:'Limpieza'};
    expect(inventoryConsumptionSchema.parse(v).attendanceId).toBeNull();expect(inventoryConsumptionSchema.safeParse({...v,businessId:crypto.randomUUID()}).success).toBe(false);
  });
  it('validates transfer dimensions and fit physical returns',()=>{
    const line={sku:'A',locationId:crypto.randomUUID(),purpose:'INTERNAL',quantity:1};const v={kind:'TRANSFER',lines:[line],effectiveAt:new Date().toISOString(),reason:'Reponer'};
    expect(inventoryMovementSchema.safeParse({...v,destinationLocationId:line.locationId}).success).toBe(false);
    expect(inventoryMovementSchema.safeParse({...v,kind:'RETURN'}).success).toBe(false);
  });
  it('keeps barber consumption separate from administration and financial authority',()=>{
    expect(roleCapabilities.BARBER).toContain('inventory.consume');expect(roleCapabilities.BARBER).not.toContain('inventory.operate');expect(roleCapabilities.BARBER).not.toContain('inventory.manage');expect(roleCapabilities.RECEPTIONIST).toContain('inventory.operate');expect(roleCapabilities.RECEPTIONIST).not.toContain('inventory.adjust');expect(grantableCapabilitiesByRole.BARBER).toEqual([]);
  });
});
