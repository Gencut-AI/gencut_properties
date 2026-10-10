import postgres from 'postgres';

export type Sql = postgres.Sql;
/** A connection or an open transaction; services accept either. */
export type Db = postgres.Sql | postgres.TransactionSql;

/**
 * Create a connection pool. `prepare: false` keeps it compatible with
 * transaction-mode poolers (Supabase pooler on port 6543).
 */
export function createDb(url: string, options: { max?: number } = {}): Sql {
  return postgres(url, { max: options.max ?? 5, prepare: false, idle_timeout: 20, connect_timeout: 10 });
}
