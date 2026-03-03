/**
 * GET  /api/projects — list user's projects
 * POST /api/projects — create a new project
 */
import { json, err, corsPreflightResponse, getSession, generateId, getKV } from '../../_lib/helpers.js';

export async function onRequestGet(context) {
  const kv = getKV(context.env);
  if (!kv) return err('Storage not configured', 500);

  const session = await getSession(kv, context.request);
  if (!session) return err('Not authenticated', 401);

  const projectIds = (await kv.get(`user_projects:${session.email}`, { type: 'json' })) || [];
  const projects = [];

  for (const id of projectIds) {
    const p = await kv.get(`project:${id}`, { type: 'json' });
    if (p) projects.push(p);
  }

  return json({ projects });
}

export async function onRequestPost(context) {
  const kv = getKV(context.env);
  if (!kv) return err('Storage not configured', 500);

  const session = await getSession(kv, context.request);
  if (!session) return err('Not authenticated', 401);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON');
  }

  const websiteUrl = (body.website_url || '').trim();
  if (!websiteUrl) return err('website_url is required');

  const projectId = generateId();
  const project = {
    id: projectId,
    user_email: session.email,
    website_url: websiteUrl,
    status: 'queued',
    progress: 0,
    created_at: new Date().toISOString(),
  };
  await kv.put(`project:${projectId}`, JSON.stringify(project), { expirationTtl: 86400 * 365 });

  const list = (await kv.get(`user_projects:${session.email}`, { type: 'json' })) || [];
  list.push(projectId);
  await kv.put(`user_projects:${session.email}`, JSON.stringify(list), { expirationTtl: 86400 * 365 });

  return json({ success: true, project });
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
