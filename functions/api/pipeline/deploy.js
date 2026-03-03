/**
 * POST /api/pipeline/deploy
 * Body: { project_id }
 *
 * Deploys the preview to Cloudflare Pages as a live site.
 * Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars.
 * Names the project "[business-name]-2-0".
 */
import { json, err, corsPreflightResponse, getSession, getKV } from '../../_lib/helpers.js';

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

  const projectId = (body.project_id || '').trim();
  if (!projectId) return err('project_id is required');

  const project = await kv.get(`project:${projectId}`, { type: 'json' });
  if (!project) return err('Project not found', 404);
  if (project.user_email !== session.email) return err('Forbidden', 403);
  if (project.status !== 'preview_ready') return err('Preview is not ready yet');

  // Get preview HTML
  const previewHtml = await kv.get(`preview:${projectId}`);
  if (!previewHtml) return err('Preview HTML not found', 404);

  const cfToken = context.env.CLOUDFLARE_API_TOKEN;
  const cfAccount = context.env.CLOUDFLARE_ACCOUNT_ID;

  if (!cfToken || !cfAccount) {
    // No Cloudflare credentials — mark as deployed with preview URL only
    project.status = 'deployed';
    project.deployed_at = new Date().toISOString();
    project.live_url = project.preview_url;
    await kv.put(`project:${projectId}`, JSON.stringify(project), { expirationTtl: 86400 * 365 });

    return json({
      project,
      message: 'Deployed as preview. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID for full Pages deployment.',
    });
  }

  // Generate project name from business name
  const bizName = (project.business_info && project.business_info.name) || 'site';
  const projectName = bizName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40) + '-2-0';

  try {
    // 1. Create Cloudflare Pages project
    const createResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/pages/projects`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: projectName,
          production_branch: 'main',
        }),
      }
    );
    const createData = await createResp.json();

    // Project might already exist — that's fine
    if (!createData.success && !createResp.status === 409) {
      return err('Failed to create Pages project: ' + (createData.errors?.[0]?.message || 'Unknown error'), 500);
    }

    // 2. Direct Upload deployment
    const form = new FormData();
    const indexBlob = new Blob([previewHtml], { type: 'text/html' });
    form.append('index.html', indexBlob, 'index.html');

    const deployResp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/pages/projects/${projectName}/deployments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfToken}`,
        },
        body: form,
      }
    );
    const deployData = await deployResp.json();

    if (deployData.success) {
      const liveUrl = `https://${projectName}.pages.dev`;
      project.status = 'deployed';
      project.deployed_at = new Date().toISOString();
      project.live_url = liveUrl;
      project.cf_project_name = projectName;
      await kv.put(`project:${projectId}`, JSON.stringify(project), { expirationTtl: 86400 * 365 });

      return json({ project });
    } else {
      return err('Deployment failed: ' + (deployData.errors?.[0]?.message || 'Unknown error'), 500);
    }
  } catch (e) {
    return err('Deployment error: ' + e.message, 500);
  }
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
