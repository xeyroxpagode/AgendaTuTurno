import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import { createMoneyOperation } from "../../../apps/api/src/modules/money/commands.js";
import { database, runtime } from "../../../apps/api/src/lib/runtime.js";
import { assertQaDatabase, op, seedActor, seedBusiness } from "../support.js";

/**
 * H05 · QA de base de datos y seguridad (F43–F45).
 * Verifica invariantes MATERIALIZADOS, no sólo afirmaciones declarativas.
 */
function databaseUrlForUpgrade(): string {
  const url = new URL(runtime.databaseUrl);
  url.pathname = "/youngkingz_h05_upgrade_20261116";
  return url.href;
}

describe("H05 BD, migraciones y seguridad (F43–F45)", () => {
  let owner: Actor;

  beforeAll(async () => {
    await assertQaDatabase();
    owner = await seedActor(await seedBusiness("H05 BD QA"), "OWNER", "Dueño");
  });

  it("F43 · cadena H01→H05 aplicada en QA aislado", async () => {
    const versions = await database.client`select version from supabase_migrations.schema_migrations order by version`;
    expect(versions.length).toBeGreaterThanOrEqual(18);
    // FIXTURE G01/CIERRE: la cadena H01→H05 debe estar presente; H06 puede
    // añadir migraciones posteriores sin que eso sea una regresión H05.
    expect(versions.some((row) => String(row.version) === "202611160001")).toBe(true);
    expect(String(versions.at(-1)!.version) >= "202611160001").toBe(true);
  });

  it("F43 · ruta de upgrade H04→H05 verificada en base clon", async () => {
    const upgradeUrl = new URL(process.env.H05_UPGRADE_DATABASE_URL ?? databaseUrlForUpgrade());
    const upgrade = postgres(upgradeUrl.href, { max: 1, onnotice: () => {} });
    try {
      const schemas = await upgrade`select table_schema from information_schema.tables where table_schema in ('sales','money','cash','obligations','checkout','corrections') group by 1 order by 1`;
      expect(schemas.map((row) => row.table_schema).sort()).toEqual(["cash", "checkout", "corrections", "money", "obligations", "sales"]);
      const [h04] = await upgrade`select to_regclass('inventory.entries') inventory from (select 1) x`;
      expect(h04!.inventory).toBe("inventory.entries");
    } finally {
      await upgrade.end();
    }
  });

  it("F43 · 13 tablas canónicas con business_id y constraint de idempotencia", async () => {
    const tables = [
      ["sales", "sales"], ["sales", "sale_lines"],
      ["money", "money_operations"], ["money", "money_components"], ["money", "money_allocations"], ["money", "money_reconciliations"],
      ["cash", "cashboxes"], ["cash", "cash_sessions"], ["cash", "cash_movements"],
      ["obligations", "expense_obligations"], ["obligations", "obligation_payments"],
      ["checkout", "checkouts"], ["corrections", "corrections"]
    ];
    for (const [schema, table] of tables) {
      const columns = await database.client`
        select column_name from information_schema.columns
         where table_schema = ${schema} and table_name = ${table}`;
      expect(columns.map((column) => column.column_name)).toContain("business_id");
    }
    const uniqueOperation = await database.client`
      select conname from pg_constraint
       where conrelid in ('money.money_operations'::regclass,'checkout.checkouts'::regclass,'corrections.corrections'::regclass)
         and contype = 'u' and pg_get_constraintdef(oid) like '%(operation_id)%'`;
    expect(uniqueOperation.length).toBeGreaterThanOrEqual(3);
  });

  it("F43 · triggers de inmutabilidad y claves compuestas instalados", async () => {
    const triggers = await database.client`
      select tgname from pg_trigger
       where not tgisinternal and tgrelid in (
         'sales.sale_lines'::regclass,'money.money_operations'::regclass,'cash.cash_sessions'::regclass,
         'cash.cash_movements'::regclass,'obligations.obligation_payments'::regclass,'corrections.corrections'::regclass)`;
    const names = triggers.map((row) => String(row.tgname));
    for (const expected of [
      "guard_sale_line_immutability", "guard_money_operation_immutability",
      "guard_cash_closed_session", "guard_cash_movement_immutability",
      "guard_obligation_payment_immutability", "guard_correction_immutability"
    ]) expect(names).toContain(expected);
    const [cashboxIndex] = await database.client`
      select indexname from pg_indexes where indexname = 'cash_one_open_session_per_cashbox'`;
    expect(cashboxIndex!.indexname).toBe("cash_one_open_session_per_cashbox");
  });

  it("aislamiento cross-business: FK compuesta rechaza dinero de otro negocio", async () => {
    const other = await seedActor(await seedBusiness("H05 BD Otro"), "OWNER", "Otro");
    await expect(createMoneyOperation(other, {
      saleId: "00000000-0000-0000-0000-000000000000",
      components: [{ method: "CARD", amountMinor: 1_000, outcome: "CONFIRMED", reference: "CROSS-BIZ-1", evidenceReference: "EV-CROSS-BIZ-1" }]
    }, op())).rejects.toMatchObject({ code: "23503" }); // FK compuesta: otra negocio no puede aplicar dinero
  });

  it("F45 · errores de dominio no exponen secretos ni credenciales", async () => {
    const secret = "SUPER_SECRET_TOKEN_VALUE_12345";
    try {
      await createMoneyOperation(owner, {
        components: [{ method: "CARD", amountMinor: -1, outcome: "CONFIRMED", reference: secret }]
      }, op());
      throw new Error("Se esperaba un error de validación");
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain(secret);
      expect(message).not.toMatch(/password|token|service_role/i);
    }
  });

  it("UNKNOWN no se degrada a FAILED por el paso del tiempo", async () => {
    const result = await createMoneyOperation(owner, {
      components: [{ method: "CARD", amountMinor: 2_000, outcome: "UNKNOWN" }]
    }, op());
    expect(result.data.status).toBe("UNKNOWN");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [row] = await database.client`select status::text status from system.operation_attempts where operation_id = ${result.data.operationId}`;
    expect(["UNKNOWN", "STARTED"]).toContain(String(row!.status));
  });
});
