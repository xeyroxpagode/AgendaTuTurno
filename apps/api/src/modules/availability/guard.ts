import type { Tx } from "../system/operations.js";

export async function lockAvailabilityGuard(tx: Tx, businessId: string) {
  await tx`insert into availability.business_guards(business_id) values (${businessId}) on conflict do nothing`;
  const [guard] = await tx`select business_id "businessId", revision from availability.business_guards where business_id=${businessId} for update`;
  if (!guard) throw new Error("Availability guard could not be acquired");
  return { businessId: guard.businessId as string, revision: Number(guard.revision) };
}
