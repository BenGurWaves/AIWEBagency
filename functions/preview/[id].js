/**
 * GET /preview/:id
 * Serves the generated preview HTML for a project.
 */

export async function onRequestGet(context) {
  const kv = context.env.DATA || context.env.LEADS;
  const projectId = context.params.id;

  if (!kv || !projectId) {
    return new Response('Not found', { status: 404 });
  }

  const html = await kv.get(`preview:${projectId}`);
  if (!html) {
    return new Response('Preview not found', { status: 404 });
  }

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
