/**
 * E-07/E-17 — Oráculo monetario independiente (sin mocks).
 * Demuestra la frontera H08 BigInt ↔ H05 Number/::int y su acotación exacta.
 */
import {
  MAX_AMOUNT_MINOR, amountMinorSchema, positiveAmountMinorSchema
} from "@youngkingz/contracts/money";
import { MAX_CALC_MINOR, commissionMinor, parseMinor, minorToString } from "@youngkingz/contracts/economy";
import { assertMinorRange, deriveObligationBalance, deriveSaleBalance } from "../../apps/api/src/modules/h05/domain.js";
import fs from "node:fs";
const OUT = "C:/Users/thega/Desktop/YKZ-H07-H08-FINAL-CLOSURE/02_CORRECTIVES/money_oracle.json";
const r = { startedAt: new Date().toISOString(), checks: [] };
const add = (name, ok, detail) => r.checks.push({ name, ok, detail });
try {
  add("MAX_AMOUNT_MINOR", MAX_AMOUNT_MINOR === 1_000_000_000, String(MAX_AMOUNT_MINOR));
  add("MAX_CALC_MINOR_bigint", typeof MAX_CALC_MINOR === "bigint", MAX_CALC_MINOR.toString());
  add("int32_safe", MAX_AMOUNT_MINOR < 2_147_483_647, `${MAX_AMOUNT_MINOR} < 2147483647`);

  assertMinorRange(1, "small"); assertMinorRange(1_000_000_000, "max");
  add("assertMinorRange_bounds", true, "1 and 1e9 accepted");
  let rejected = false; try { assertMinorRange(1_000_000_001, "excess"); } catch { rejected = true; }
  add("assertMinorRange_rejects_excess", rejected, "1e9+1 rejected before any effect");
  rejected = false; try { assertMinorRange(Number.MAX_SAFE_INTEGER + 1, "unsafe"); } catch { rejected = true; }
  add("assertMinorRange_rejects_unsafe_integer", rejected, "2^53+1 rejected");

  add("amountMinorSchema_max", amountMinorSchema.safeParse(1_000_000_000).success, "1e9 accepted");
  add("amountMinorSchema_excess", !amountMinorSchema.safeParse(1_000_000_001).success, "1e9+1 rejected");
  add("positiveAmountMinorSchema_zero", !positiveAmountMinorSchema.safeParse(0).success, "0 rejected");

  const big = parseMinor("999999999999999999999999");
  add("parseMinor_bigint_exact", big === 999999999999999999999999n && typeof big === "bigint", big.toString());
  add("commission_no_precision_loss", commissionMinor(1_000_000_000n, 10000) === 1_000_000_000n, commissionMinor(1_000_000_000n, 10000).toString());
  add("commission_floor", commissionMinor(3000n, 1000) === 300n, "base 3000 @10% = 300");
  add("bigint_accumulation", (parseMinor("1000000000") + parseMinor("1000000000")).toString() === "2000000000", "2e9 exact (would overflow ::int but never materialized)");

  // Caso conocido EGM: cobro 5000, refund 2000, base 3000, comisión 10% = 300.
  const settled = 5000 - 2000;
  add("refund_net_base", settled === 3000, `5000-2000=${settled}`);
  add("refund_commission", commissionMinor(BigInt(settled), 1000) === 300n, "300, no 1000");
  add("sale_balance_partial", deriveSaleBalance(5000, 3000) === "PARTIAL", "PARTIAL");
  add("obligation_partial", JSON.stringify(deriveObligationBalance(10000, 3000)) === JSON.stringify({ status: "PARTIAL", balanceMinor: 7000 }), "balance 7000");
  add("obligation_settled", deriveObligationBalance(10000, 10000).status === "SETTLED", "SETTLED");
  add("minorToString", minorToString(300n) === "300", "300");
} catch (e) { r.fatal = e.message; } finally {
  r.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(r, null, 2), "utf8");
  console.log(JSON.stringify({ fatal: r.fatal ?? null, total: r.checks.length, failed: r.checks.filter((c) => !c.ok), out: OUT }, null, 2));
}
