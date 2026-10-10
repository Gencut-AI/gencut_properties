import postgres from 'postgres';

/** Open one short-lived connection and run `select 1`. */
export async function probeDatabase(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1, prepare: false });
  try {
    const rows = await sql`select 1 as ok`;
    return rows[0]?.ok === 1;
  } finally {
    await sql.end({ timeout: 1 });
  }
}
