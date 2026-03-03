/**
 * POST /api/auth/login
 * Body: { email, password }
 * Verifies credentials, creates session.
 */
import { json, err, corsPreflightResponse, hashPassword, createSession, sessionCookie, getKV } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);
  if (!kv) return err('Storage not configured', 500);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON');
  }

  const email = (body.email || '').trim().toLowerCase();
  const password = (body.password || '').trim();

  if (!email || !password) return err('Email and password are required');

  const user = await kv.get(`user:${email}`, { type: 'json' });
  if (!user) return err('Invalid email or password', 401);

  const hash = await hashPassword(password, user.salt);
  if (hash !== user.password_hash) return err('Invalid email or password', 401);

  const sessionId = await createSession(kv, email);

  return json(
    { success: true, email, plan: user.plan },
    200,
    { 'Set-Cookie': sessionCookie(sessionId) }
  );
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
