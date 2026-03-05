/**
 * DELETE /api/projects/:id — delete a project/preview
 */
import { json, err, corsPreflightResponse, getSession, getKV } from '../../_lib/helpers.js';

export async function onRequestDelete(context) {
  const kv = getKV(context.env);
  if (!kv) return err('Storage not configured', 500);

  const session = await getSession(kv, context.request);
  if (!session) return err('Not authenticated', 401);

  const projectId = context.params.id;
  if (!projectId) return err('Project ID required');

  // Verify ownership
  const project = await kv.get(`project:${projectId}`, { type: 'json' });
  if (!project) return err('Project not found', 404);
  if (project.user_email !== session.email) return err('Not authorized', 403);

  // Delete project and preview
  await kv.delete(`project:${projectId}`);
  await kv.delete(`preview:${projectId}`);

  // Remove from user's project list
  const list = (await kv.get(`user_projects:${session.email}`, { type: 'json' })) || [];
  const updated = list.filter(id => id !== projectId);
  await kv.put(`user_projects:${session.email}`, JSON.stringify(updated), { expirationTtl: 86400 * 365 });

  return json({ success: true });
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
