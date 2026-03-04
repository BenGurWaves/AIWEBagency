/**
 * GET /api/admin/signups
 * Returns all tracked signups. Protected by ADMIN_KEY env var.
 * Pass ?key=YOUR_ADMIN_KEY as query param.
 */
import { json, err, corsPreflightResponse, getKV } from '../../_lib/helpers.js';

export async function onRequestGet(context) {
  const kv = getKV(context.env);
  if (!kv) return err('Storage not configured', 500);

  const adminKey = context.env.ADMIN_KEY;
  if (!adminKey) return err('Admin access not configured', 500);

  const url = new URL(context.request.url);
  const key = url.searchParams.get('key') || '';

  if (key !== adminKey) return err('Unauthorized', 401);

  const signups = (await kv.get('admin:signups', { type: 'json' })) || [];

  return json({ signups, total: signups.length });
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
