import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import type * as schema from '../../db/schema.ts';

export type VigiloDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
