import type { Family } from '@supakernel/contracts'

export function outboxTable(family: Family): string {
  return family === 'postgres' ? '_supakernel.outbox' : '_supakernel_outbox'
}

/**
 * Managed change-capture outbox (contract §15). A trigger on every managed table writes one
 * row per mutation **in the same transaction**, with a monotonic `seq`, the op, PK, old/new
 * record and commit timestamp. The dispatcher reads it only after commit.
 */
export function outboxSchemaStatements(family: Family): string[] {
  if (family === 'postgres') {
    return [
      'CREATE SCHEMA IF NOT EXISTS _supakernel',
      'DROP TABLE IF EXISTS _supakernel.outbox',
      `CREATE TABLE _supakernel.outbox (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        schema_name text NOT NULL,
        table_name text NOT NULL,
        op text NOT NULL,
        pk jsonb NOT NULL,
        old_record jsonb,
        new_record jsonb,
        commit_ts timestamptz NOT NULL DEFAULT now()
      )`,
      // SECURITY DEFINER: the trigger fires inside the caller's transaction, which runs under
      // `SET LOCAL ROLE "authenticated"` when native RLS is active. Writing to the managed
      // `_supakernel.outbox` must not depend on the caller's schema privileges (contract §15).
      `CREATE OR REPLACE FUNCTION _supakernel.emit_change() RETURNS trigger
       LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
       DECLARE pk_cols text[] := TG_ARGV; pk_obj jsonb := '{}'::jsonb; c text; src jsonb;
       BEGIN
         src := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
         FOREACH c IN ARRAY pk_cols LOOP pk_obj := pk_obj || jsonb_build_object(c, src -> c); END LOOP;
         INSERT INTO _supakernel.outbox (schema_name, table_name, op, pk, old_record, new_record)
         VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, pk_obj,
                 CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
                 CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
         RETURN NULL;
       END $$`,
      'REVOKE ALL ON FUNCTION _supakernel.emit_change() FROM PUBLIC',
    ]
  }
  return [
    'DROP TABLE IF EXISTS _supakernel_outbox',
    `CREATE TABLE _supakernel_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_name TEXT NOT NULL,
      table_name TEXT NOT NULL,
      op TEXT NOT NULL,
      pk TEXT NOT NULL,
      old_record TEXT,
      new_record TEXT,
      commit_ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  ]
}

/** Install the managed triggers on one table (contract §15). */
export function outboxTriggerStatements(
  family: Family,
  table: { name: string; columns: readonly string[]; primaryKey: readonly string[] },
): string[] {
  const pk = table.primaryKey.length > 0 ? table.primaryKey : ['rowid']
  if (family === 'postgres') {
    const args = pk.map((c) => `'${c}'`).join(', ')
    return [
      `DROP TRIGGER IF EXISTS sk_outbox_${table.name} ON "${table.name}"`,
      `CREATE TRIGGER sk_outbox_${table.name}
       AFTER INSERT OR UPDATE OR DELETE ON "${table.name}"
       FOR EACH ROW EXECUTE FUNCTION _supakernel.emit_change(${args})`,
    ]
  }
  const jsonObj = (ref: 'NEW' | 'OLD'): string =>
    `json_object(${table.columns.map((c) => `'${c}', ${ref}."${c}"`).join(', ')})`
  const pkObj = (ref: 'NEW' | 'OLD'): string =>
    `json_object(${pk.map((c) => `'${c}', ${ref}."${c}"`).join(', ')})`
  const ins = `INSERT INTO _supakernel_outbox (schema_name, table_name, op, pk, old_record, new_record)`
  return [
    `DROP TRIGGER IF EXISTS sk_outbox_${table.name}_ins`,
    `DROP TRIGGER IF EXISTS sk_outbox_${table.name}_upd`,
    `DROP TRIGGER IF EXISTS sk_outbox_${table.name}_del`,
    `CREATE TRIGGER sk_outbox_${table.name}_ins AFTER INSERT ON "${table.name}" BEGIN
       ${ins} VALUES ('public', '${table.name}', 'INSERT', ${pkObj('NEW')}, NULL, ${jsonObj('NEW')}); END`,
    `CREATE TRIGGER sk_outbox_${table.name}_upd AFTER UPDATE ON "${table.name}" BEGIN
       ${ins} VALUES ('public', '${table.name}', 'UPDATE', ${pkObj('NEW')}, ${jsonObj('OLD')}, ${jsonObj('NEW')}); END`,
    `CREATE TRIGGER sk_outbox_${table.name}_del AFTER DELETE ON "${table.name}" BEGIN
       ${ins} VALUES ('public', '${table.name}', 'DELETE', ${pkObj('OLD')}, ${jsonObj('OLD')}, NULL); END`,
  ]
}
