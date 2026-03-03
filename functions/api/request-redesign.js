/**
 * Cloudflare Pages Function — handles redesign request form submissions.
 *
 * POST /api/request-redesign
 * Body: { website_url: string, email: string }
 *
 * Stores leads in Cloudflare KV if the LEADS binding exists.
 * Works fine without KV — just returns success.
 */

export async function onRequestPost(context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    let body;
    try {
      body = await context.request.json();
    } catch (_) {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { status: 400, headers }
      );
    }

    const websiteUrl = (body.website_url || '').trim();
    const email = (body.email || '').trim().toLowerCase();

    if (!websiteUrl || !email) {
      return new Response(
        JSON.stringify({ error: 'website_url and email are required' }),
        { status: 400, headers }
      );
    }

    if (!email.includes('@') || !email.includes('.')) {
      return new Response(
        JSON.stringify({ error: 'Invalid email address' }),
        { status: 400, headers }
      );
    }

    const lead = {
      website_url: websiteUrl,
      email: email,
      submitted_at: new Date().toISOString(),
      source: 'website_form',
      status: 'new',
    };

    // Try KV storage if the binding exists — never let it crash the request
    try {
      if (context.env && context.env.LEADS) {
        const key = 'lead_' + Date.now() + '_' + email.replace(/[^a-z0-9]/gi, '_');
        await context.env.LEADS.put(key, JSON.stringify(lead), {
          expirationTtl: 7776000, // 90 days
        });
      }
    } catch (_) {
      // KV not configured or write failed — that's fine, continue
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Redesign request received.',
      }),
      { status: 200, headers }
    );
  } catch (_) {
    return new Response(
      JSON.stringify({ error: 'Something went wrong' }),
      { status: 500, headers }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
