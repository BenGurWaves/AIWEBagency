/**
 * POST /api/auth/signup
 * Body: { email, password, website_url? }
 * Creates user, session, and optionally a first project.
 */
import { json, err, corsPreflightResponse, hashPassword, generateId, createSession, sessionCookie, getKV } from '../../_lib/helpers.js';

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
  const websiteUrl = (body.website_url || '').trim();

  if (!email || !password) return err('Email and password are required');
  if (password.length < 6) return err('Password must be at least 6 characters');
  if (!email.includes('@') || !email.includes('.')) return err('Invalid email address');

  // Check if user already exists
  const existing = await kv.get(`user:${email}`, { type: 'json' });
  if (existing) return err('An account with this email already exists. Please log in.', 409);

  // Hash password
  const salt = generateId();
  const passwordHash = await hashPassword(password, salt);

  // Create user
  const user = {
    email,
    password_hash: passwordHash,
    salt,
    plan: 'free',
    created_at: new Date().toISOString(),
  };
  await kv.put(`user:${email}`, JSON.stringify(user), { expirationTtl: 86400 * 365 });

  // Create session
  const sessionId = await createSession(kv, email);

  // If website URL provided, create a project
  let projectId = null;
  if (websiteUrl) {
    projectId = generateId();
    const project = {
      id: projectId,
      user_email: email,
      website_url: websiteUrl,
      status: 'queued',
      progress: 0,
      created_at: new Date().toISOString(),
    };
    await kv.put(`project:${projectId}`, JSON.stringify(project), { expirationTtl: 86400 * 365 });

    // Add to user's project list
    const list = (await kv.get(`user_projects:${email}`, { type: 'json' })) || [];
    list.push(projectId);
    await kv.put(`user_projects:${email}`, JSON.stringify(list), { expirationTtl: 86400 * 365 });
  }

  return json(
    { success: true, email, project_id: projectId },
    200,
    { 'Set-Cookie': sessionCookie(sessionId) }
  );
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
