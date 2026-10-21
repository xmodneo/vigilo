import { sql } from 'drizzle-orm';

import type { VigiloDatabase } from '../db/types.ts';

/** PostgreSQL transaction timestamps freeze at BEGIN; authority time must not. */
export async function freshDatabaseTime(database: VigiloDatabase): Promise<Date> {
  const result = await database.execute(sql`select clock_timestamp() as authority_time`);
  const candidate = result as unknown as { rows?: { authority_time: Date | string }[] } | { authority_time: Date | string }[];
  const rows = Array.isArray(candidate) ? candidate : candidate.rows ?? [];
  const reported = rows[0]?.authority_time;
  const time = reported instanceof Date ? reported : typeof reported === 'string' ? new Date(reported) : null;
  if (!time || !Number.isFinite(time.getTime())) throw new Error('database_authority_time_unavailable');
  return time;
}

export async function assertDatabaseExpiryLive(database: VigiloDatabase, expiry: Date): Promise<void> {
  const result = await database.execute(sql`select clock_timestamp() < ${expiry.toISOString()}::timestamptz as authority_live`);
  const candidate = result as unknown as { rows?: { authority_live: boolean }[] } | { authority_live: boolean }[];
  const rows = Array.isArray(candidate) ? candidate : candidate.rows ?? [];
  if (rows.length !== 1 || rows[0]?.authority_live !== true) throw new Error('execution_authority_expired');
}
