import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
}

// Service role client - bypasses RLS, use only on backend
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: { persistSession: false },
    db: { schema: 'public' },
  }
);

// Helper: execute a query and throw on error
export async function query(queryFn) {
  const { data, error } = await queryFn;
  if (error) {
    const err = new Error(error.message);
    err.statusCode = error.code === '23505' ? 409 : 500;
    err.pgCode = error.code;
    throw err;
  }
  return data;
}

// Helper: get single row or 404
export async function queryOne(queryFn, resourceName = 'Resource') {
  const { data, error } = await queryFn;
  if (error) {
    const err = new Error(error.message);
    err.statusCode = 500;
    throw err;
  }
  if (!data || (Array.isArray(data) && data.length === 0)) {
    const err = new Error(`${resourceName} not found`);
    err.statusCode = 404;
    throw err;
  }
  return Array.isArray(data) ? data[0] : data;
}
