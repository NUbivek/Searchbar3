import { Pool, QueryResult } from 'pg';

let pool: Pool;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    pool.on('error', (err) => {
      console.error('[db] unexpected pool error', err);
    });
  }
  return pool;
}

export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await getPool().query<T>(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn('[db] slow query detected', { duration, text: text.slice(0, 100) });
    }
    return result;
  } catch (err) {
    console.error('[db] query error', { text: text.slice(0, 100), err });
    throw err;
  }
}

export default getPool;
