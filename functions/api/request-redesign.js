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

    // ── Persist lead data in KV for later retrieval by email ──
    try {
      if (context.env && (context.env.LEADS || context.env.DATA)) {
        const kv = context.env.DATA || context.env.LEADS;
        const existingRaw = await kv.get('redesign:' + email, { type: 'json' });
        const redesignData = existingRaw || {};
        // Merge new data with existing (keep previous questionnaire answers etc)
        Object.assign(redesignData, lead);
        // Preserve any additional fields sent (niche, services, style, etc)
        const extraFields = ['business_name', 'niche', 'services', 'location', 'style', 'site_type', 'phone', 'contact_email', 'years', 'inspo_urls', 'notes', 'revision'];
        for (const f of extraFields) {
          if (body[f]) redesignData[f] = body[f];
        }
        await kv.put('redesign:' + email, JSON.stringify(redesignData), { expirationTtl: 7776000 });
      }
    } catch (_) {}

    // ── Send emails via Resend (if API key is set) ──────────
    const resendKey = context.env && context.env.RESEND_API_KEY;
    let customerEmailSent = false;
    let notificationSent = false;

    if (resendKey) {
      const fromEmail = (context.env.FROM_EMAIL || 'hello@velocity.delivery');
      const notifyEmail = context.env.NOTIFY_EMAIL || null;

      // 1. Confirmation email to the customer
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + resendKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Velocity <' + fromEmail + '>',
            to: [email],
            subject: 'Your free redesign is on the way!',
            html: buildConfirmationEmail(websiteUrl),
          }),
        });
        customerEmailSent = res.ok;
      } catch (_) {}

      // 2. Internal notification to agency owner
      if (notifyEmail) {
        try {
          const res = await fetch('https://api.resend.com/emails', {
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
          notificationSent = res.ok;
        } catch (_) {}
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Redesign request received.',
        email_sent: customerEmailSent,
        notification_sent: notificationSent,
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
  <div style="max-width:560px;margin:0 auto;padding:48px 28px;">

    <!-- Logo -->
    <div style="margin-bottom:32px;"><div style="font-size:22px;color:#e8ddd3;">Velocity<span style="color:#c8956a;">.</span></div><a href="https://calyvent.com" style="font-size:10px;color:#6d6560;font-family:-apple-system,system-ui,sans-serif;text-decoration:none;letter-spacing:0.03em;">by Calyvent</a></div>

    <!-- Welcome -->
    <h1 style="font-size:28px;color:#e8ddd3;font-weight:400;line-height:1.3;margin:0 0 8px;">
      Welcome to Velocity!
    </h1>
    <p style="font-size:16px;color:#c8956a;font-family:-apple-system,system-ui,sans-serif;margin:0 0 24px;font-weight:600;">
      Your free website redesign is on its way.
    </p>

    <p style="font-size:15px;color:#a89f94;line-height:1.7;margin:0 0 24px;font-family:-apple-system,system-ui,sans-serif;">
      Thanks for submitting <strong style="color:#e8ddd3;">${escapeHtml(websiteUrl)}</strong>. We&rsquo;re excited to show you what your website <em>could</em> look like &mdash; fast, modern, and built to get you more customers.
    </p>

    <!-- What Happens Next -->
    <div style="background:#1a1815;border:1px solid #2e2a24;border-radius:12px;padding:24px;margin-bottom:24px;">
      <h2 style="font-size:18px;color:#e8ddd3;font-weight:400;margin:0 0 16px;font-family:Georgia,serif;">
        Here&rsquo;s what happens next:
      </h2>
      <table style="width:100%;border-collapse:collapse;font-family:-apple-system,system-ui,sans-serif;">
        <tr>
          <td style="padding:10px 12px 10px 0;vertical-align:top;width:32px;">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(200,149,106,0.15);color:#c8956a;text-align:center;line-height:28px;font-size:13px;font-weight:700;">1</div>
          </td>
          <td style="padding:10px 0;">
            <strong style="color:#e8ddd3;font-size:14px;display:block;margin-bottom:2px;">We audit your current site</strong>
            <span style="color:#6d6560;font-size:13px;">Speed, mobile experience, SEO, security &mdash; the works.</span>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 12px 10px 0;vertical-align:top;">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(200,149,106,0.15);color:#c8956a;text-align:center;line-height:28px;font-size:13px;font-weight:700;">2</div>
          </td>
          <td style="padding:10px 0;">
            <strong style="color:#e8ddd3;font-size:14px;display:block;margin-bottom:2px;">We design a modern preview</strong>
            <span style="color:#6d6560;font-size:13px;">Mobile-first, lightning fast, tailored to your trade.</span>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 12px 10px 0;vertical-align:top;">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(200,149,106,0.15);color:#c8956a;text-align:center;line-height:28px;font-size:13px;font-weight:700;">3</div>
          </td>
          <td style="padding:10px 0;">
            <strong style="color:#e8ddd3;font-size:14px;display:block;margin-bottom:2px;">Your preview is ready in 2 minutes to 48 hours</strong>
            <span style="color:#6d6560;font-size:13px;">Log into your dashboard to watch the progress live.</span>
          </td>
        </tr>
      </table>
    </div>

    <!-- Dashboard CTA -->
    <div style="text-align:center;margin-bottom:28px;">
      <p style="font-size:14px;color:#a89f94;margin:0 0 12px;font-family:-apple-system,system-ui,sans-serif;">
        Track your redesign progress in real time:
      </p>
      <a href="https://velocity.delivery/auth.html" style="display:inline-block;background:#c8956a;color:#12100e;font-family:-apple-system,system-ui,sans-serif;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;">
        Open your dashboard &rarr;
      </a>
    </div>

    <!-- What's Included -->
    <div style="background:#1a1815;border:1px solid #2e2a24;border-radius:12px;padding:24px;margin-bottom:24px;">
      <h2 style="font-size:16px;color:#e8ddd3;font-weight:400;margin:0 0 14px;font-family:Georgia,serif;">
        What you get (completely free):
      </h2>
      <table style="width:100%;border-collapse:collapse;font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#a89f94;">
        <tr>
          <td style="padding:6px 0;"><span style="color:#7fb069;margin-right:8px;">&#10003;</span> Full website audit report</td>
        </tr>
        <tr>
          <td style="padding:6px 0;"><span style="color:#7fb069;margin-right:8px;">&#10003;</span> Custom redesign preview</td>
        </tr>
        <tr>
          <td style="padding:6px 0;"><span style="color:#7fb069;margin-right:8px;">&#10003;</span> Mobile &amp; desktop mockups</td>
        </tr>
        <tr>
          <td style="padding:6px 0;"><span style="color:#7fb069;margin-right:8px;">&#10003;</span> Speed &amp; SEO analysis</td>
        </tr>
        <tr>
          <td style="padding:6px 0;"><span style="color:#7fb069;margin-right:8px;">&#10003;</span> No credit card required</td>
        </tr>
      </table>
    </div>

    <!-- About Velocity -->
    <div style="margin-bottom:28px;">
      <h2 style="font-size:16px;color:#e8ddd3;font-weight:400;margin:0 0 10px;font-family:Georgia,serif;">
        Why Velocity?
      </h2>
      <p style="font-size:14px;color:#a89f94;line-height:1.7;margin:0 0 12px;font-family:-apple-system,system-ui,sans-serif;">
        We build websites exclusively for tradespeople &mdash; plumbers, roofers, HVAC techs, electricians, and landscapers. We know your customers search on their phones, need to call you fast, and judge your business by your site before they ever pick up the phone.
      </p>
      <p style="font-size:14px;color:#a89f94;line-height:1.7;margin:0;font-family:-apple-system,system-ui,sans-serif;">
        Our sites are <strong style="color:#e8ddd3;">fast</strong> (under 2 seconds), <strong style="color:#e8ddd3;">mobile-first</strong>, and <strong style="color:#e8ddd3;">built to convert</strong>. No bloated WordPress. No monthly contracts. Just a website that works as hard as you do.
      </p>
    </div>

    <!-- FAQ Snippet -->
    <div style="background:#1a1815;border:1px solid #2e2a24;border-radius:12px;padding:24px;margin-bottom:28px;">
      <h2 style="font-size:16px;color:#e8ddd3;font-weight:400;margin:0 0 16px;font-family:Georgia,serif;">
        Quick questions:
      </h2>
      <p style="font-size:13px;color:#a89f94;line-height:1.6;margin:0 0 12px;font-family:-apple-system,system-ui,sans-serif;">
        <strong style="color:#e8ddd3;">Is this really free?</strong><br>
        Yes. The preview costs you nothing. We only charge if you decide to move forward with a full build.
      </p>
      <p style="font-size:13px;color:#a89f94;line-height:1.6;margin:0 0 12px;font-family:-apple-system,system-ui,sans-serif;">
        <strong style="color:#e8ddd3;">How long until my site goes live?</strong><br>
        Most sites are live within 5&ndash;7 business days after you approve the preview.
      </p>
      <p style="font-size:13px;color:#a89f94;line-height:1.6;margin:0;font-family:-apple-system,system-ui,sans-serif;">
        <strong style="color:#e8ddd3;">Do I need to provide anything?</strong><br>
        Nope. We handle everything &mdash; copy, images, design, hosting. Just sit back.
      </p>
    </div>

    <!-- Zero-pressure note -->
    <p style="font-size:14px;color:#6d6560;line-height:1.6;margin:0 0 8px;font-family:-apple-system,system-ui,sans-serif;text-align:center;">
      No obligation. No credit card. No sales calls.<br>If you love it, we&rsquo;ll talk. If not, no hard feelings.
    </p>

    <!-- Footer -->
    <div style="border-top:1px solid #2e2a24;margin-top:36px;padding-top:24px;text-align:center;">
      <p style="font-size:18px;color:#e8ddd3;margin:0 0 2px;font-family:Georgia,serif;">Velocity<span style="color:#c8956a;">.</span></p>
      <a href="https://calyvent.com" style="font-size:10px;color:#6d6560;font-family:-apple-system,system-ui,sans-serif;text-decoration:none;">by Calyvent</a>
      <p style="font-size:12px;color:#6d6560;margin:0 0 4px;font-family:-apple-system,system-ui,sans-serif;">
        Websites for tradespeople who are too busy doing real work.
      </p>
      <p style="font-size:11px;color:#4a4540;margin:0;font-family:-apple-system,system-ui,sans-serif;">
        Questions? Just reply to this email &mdash; a real person reads every message.
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
  <div style="max-width:560px;margin:0 auto;padding:48px 28px;">

    <!-- Logo -->
    <div style="margin-bottom:28px;"><div style="font-size:22px;color:#e8ddd3;font-family:Georgia,serif;">Velocity<span style="color:#c8956a;">.</span></div><a href="https://calyvent.com" style="font-size:10px;color:#6d6560;font-family:-apple-system,system-ui,sans-serif;text-decoration:none;">by Calyvent</a></div>

    <!-- Alert Banner -->
    <div style="background:rgba(200,149,106,0.12);border:1px solid rgba(200,149,106,0.25);border-radius:10px;padding:16px 20px;margin-bottom:24px;">
      <h1 style="font-size:20px;color:#c8956a;font-weight:700;margin:0 0 4px;">New Lead Submitted</h1>
      <p style="font-size:13px;color:#a89f94;margin:0;">A potential customer just requested a free redesign from the website.</p>
    </div>

    <!-- Lead Details -->
    <div style="background:#1a1815;border:1px solid #2e2a24;border-radius:10px;padding:20px;margin-bottom:24px;">
      <h2 style="font-size:14px;color:#6d6560;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 14px;">Lead Details</h2>
      <table style="width:100%;font-size:14px;color:#a89f94;line-height:1.8;border-collapse:collapse;">
        <tr>
          <td style="padding:8px 16px 8px 0;color:#6d6560;font-weight:600;white-space:nowrap;vertical-align:top;">Website</td>
          <td style="padding:8px 0;"><a href="${escapeHtml(websiteUrl)}" style="color:#c8956a;word-break:break-all;">${escapeHtml(websiteUrl)}</a></td>
        </tr>
        <tr style="border-top:1px solid #2e2a24;">
          <td style="padding:8px 16px 8px 0;color:#6d6560;font-weight:600;white-space:nowrap;vertical-align:top;">Email</td>
          <td style="padding:8px 0;"><a href="mailto:${escapeHtml(email)}" style="color:#c8956a;">${escapeHtml(email)}</a></td>
        </tr>
        <tr style="border-top:1px solid #2e2a24;">
          <td style="padding:8px 16px 8px 0;color:#6d6560;font-weight:600;white-space:nowrap;vertical-align:top;">Submitted</td>
          <td style="padding:8px 0;color:#e8ddd3;">${new Date().toISOString()}</td>
        </tr>
        <tr style="border-top:1px solid #2e2a24;">
          <td style="padding:8px 16px 8px 0;color:#6d6560;font-weight:600;white-space:nowrap;vertical-align:top;">Source</td>
          <td style="padding:8px 0;color:#e8ddd3;">Website form (velocity.delivery)</td>
        </tr>
      </table>
    </div>

    <!-- Action Items -->
    <div style="background:#1a1815;border:1px solid #2e2a24;border-radius:10px;padding:20px;margin-bottom:24px;">
      <h2 style="font-size:14px;color:#6d6560;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 14px;">Action Items</h2>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#a89f94;line-height:1.6;">
        <tr>
          <td style="padding:6px 0;"><span style="color:#c8956a;margin-right:8px;">&#9679;</span> Confirmation email sent to lead automatically</td>
        </tr>
        <tr>
          <td style="padding:6px 0;"><span style="color:#c8956a;margin-right:8px;">&#9679;</span> Lead saved to pipeline (status: new)</td>
        </tr>
        <tr>
          <td style="padding:6px 0;"><span style="color:#c8956a;margin-right:8px;">&#9679;</span> Audit their site: <a href="${escapeHtml(websiteUrl)}" style="color:#c8956a;">${escapeHtml(websiteUrl)}</a></td>
        </tr>
        <tr>
          <td style="padding:6px 0;"><span style="color:#c8956a;margin-right:8px;">&#9679;</span> Generate redesign preview (2 min to 48 hours depending on demand)</td>
        </tr>
      </table>
    </div>

    <!-- Quick Actions -->
    <div style="text-align:center;margin-bottom:24px;">
      <a href="mailto:${escapeHtml(email)}" style="display:inline-block;background:#c8956a;color:#12100e;font-size:14px;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;margin-right:8px;">
        Reply to lead
      </a>
      <a href="${escapeHtml(websiteUrl)}" style="display:inline-block;background:transparent;color:#c8956a;font-size:14px;font-weight:600;padding:12px 28px;border-radius:8px;text-decoration:none;border:1px solid rgba(200,149,106,0.3);">
        View their site
      </a>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #2e2a24;margin-top:28px;padding-top:20px;text-align:center;">
      <p style="font-size:12px;color:#6d6560;margin:0;">
        Velocity Internal Notification &mdash; Lead submitted via website form.
      </p>
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
