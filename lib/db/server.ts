import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../../db/schema.ts';
import type { VigiloDatabase } from './types.ts';

let database: VigiloDatabase | undefined;

export function getDatabase(databaseUrl: string): VigiloDatabase {
  if (!database) {
    const client = postgres(databaseUrl, {
      max: 1,
      prepare: false,
    });
    database = drizzle(client, { schema });
  }

  return database;
}
