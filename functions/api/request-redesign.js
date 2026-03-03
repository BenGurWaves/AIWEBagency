/**
 * Cloudflare Pages Function — handles redesign request form submissions.
 *
 * POST /api/request-redesign
 * Body: { website_url: string, email: string }
 *
 * 1. Validates input
 * 2. Stores lead in Cloudflare KV (if LEADS binding exists)
 * 3. Sends confirmation email via Resend (if RESEND_API_KEY env var is set)
 * 4. Sends internal notification to agency owner (if NOTIFY_EMAIL is set)
 *
 * Environment variables (set in Cloudflare Pages > Settings > Environment variables):
 *   RESEND_API_KEY  — Free at resend.com (3,000 emails/month)
 *   NOTIFY_EMAIL    — Your email to receive lead notifications
 *   FROM_EMAIL      — Send-from address using YOUR verified domain (e.g. hello@velocity.delivery)
 *                     NOTE: onboarding@resend.dev only works for testing to your own email.
 *                     You MUST verify a domain at resend.com/domains for production use.
 *
 * KV Namespace bindings (optional):
 *   LEADS           — For storing lead data
 */

export async function onRequestPost(context) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    // Parse request body
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

    // Validate
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

    // ── Store in KV (optional) ──────────────────────────────
    try {
      if (context.env && context.env.LEADS) {
        const key = 'lead_' + Date.now() + '_' + email.replace(/[^a-z0-9]/gi, '_');
        await context.env.LEADS.put(key, JSON.stringify(lead), {
          expirationTtl: 7776000, // 90 days
        });
      }
    } catch (_) {
      // KV not bound or write failed — continue
    }

    // ── Send emails via Resend (if API key is set) ──────────
    const resendKey = context.env && context.env.RESEND_API_KEY;
    if (resendKey) {
      const fromEmail = (context.env.FROM_EMAIL || 'hello@velocity.delivery');
      const notifyEmail = context.env.NOTIFY_EMAIL || null;

      // 1. Confirmation email to the lead
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + resendKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Velocity <' + fromEmail + '>',
            to: [email],
            subject: 'Working on your preview',
            html: buildConfirmationEmail(websiteUrl),
          }),
        });
      } catch (_) {
        // Email send failed — don't block the response
      }

      // 2. Internal notification to agency owner
      if (notifyEmail) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + resendKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Velocity Leads <' + fromEmail + '>',
              to: [notifyEmail],
              subject: 'New lead: ' + websiteUrl,
              html: buildNotificationEmail(websiteUrl, email),
            }),
          });
        } catch (_) {
          // Notification failed — don't block
        }
      }
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

// ── CORS preflight ─────────────────────────────────────────
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

// ── Email Templates ────────────────────────────────────────

function buildConfirmationEmail(websiteUrl) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#12100e;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <div style="font-size:20px;color:#e8ddd3;margin-bottom:24px;">Velocity<span style="color:#c8956a;">.</span></div>
    <h1 style="font-size:26px;color:#e8ddd3;font-weight:400;line-height:1.3;margin:0 0 16px;">
      Working on your preview&hellip;
    </h1>
    <p style="font-size:15px;color:#a89f94;line-height:1.7;margin:0 0 20px;font-family:-apple-system,system-ui,sans-serif;">
      Thanks for submitting <strong style="color:#e8ddd3;">${escapeHtml(websiteUrl)}</strong>. Our team is reviewing your site right now and building a free preview of what it could look like.
    </p>
    <p style="font-size:15px;color:#a89f94;line-height:1.7;margin:0 0 20px;font-family:-apple-system,system-ui,sans-serif;">
      <strong style="color:#e8ddd3;">What happens next:</strong>
    </p>
    <ol style="font-size:14px;color:#a89f94;line-height:1.8;margin:0 0 24px;padding-left:20px;font-family:-apple-system,system-ui,sans-serif;">
      <li>We audit your current site (speed, mobile, SEO)</li>
      <li>We design a modern, mobile-first preview</li>
      <li>We send you the preview within 24&ndash;48 hours</li>
    </ol>
    <p style="font-size:14px;color:#6d6560;line-height:1.6;margin:0;font-family:-apple-system,system-ui,sans-serif;">
      No obligation. No credit card. If you love it, we&rsquo;ll talk next steps. If not, no hard feelings.
    </p>
    <div style="border-top:1px solid #2e2a24;margin-top:32px;padding-top:20px;">
      <p style="font-size:12px;color:#6d6560;margin:0;font-family:-apple-system,system-ui,sans-serif;">
        Velocity &mdash; Websites for tradespeople who are too busy doing real work.
      </p>
    </div>
  </div>
</body>
</html>`.trim();
}

function buildNotificationEmail(websiteUrl, email) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#12100e;font-family:-apple-system,system-ui,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px;">
    <div style="font-size:20px;color:#e8ddd3;font-family:Georgia,serif;margin-bottom:24px;">Velocity<span style="color:#c8956a;">.</span></div>
    <h1 style="font-size:22px;color:#c8956a;font-weight:600;margin:0 0 16px;">New Lead</h1>
    <table style="font-size:14px;color:#a89f94;line-height:1.8;border-collapse:collapse;">
      <tr>
        <td style="padding:4px 16px 4px 0;color:#6d6560;font-weight:600;">Website</td>
        <td style="padding:4px 0;"><a href="${escapeHtml(websiteUrl)}" style="color:#c8956a;">${escapeHtml(websiteUrl)}</a></td>
      </tr>
      <tr>
        <td style="padding:4px 16px 4px 0;color:#6d6560;font-weight:600;">Email</td>
        <td style="padding:4px 0;"><a href="mailto:${escapeHtml(email)}" style="color:#c8956a;">${escapeHtml(email)}</a></td>
      </tr>
      <tr>
        <td style="padding:4px 16px 4px 0;color:#6d6560;font-weight:600;">Time</td>
        <td style="padding:4px 0;color:#e8ddd3;">${new Date().toISOString()}</td>
      </tr>
    </table>
    <div style="border-top:1px solid #2e2a24;margin-top:24px;padding-top:16px;">
      <p style="font-size:12px;color:#6d6560;margin:0;">This lead was submitted via the Velocity website form.</p>
    </div>
  </div>
</body>
</html>`.trim();
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
