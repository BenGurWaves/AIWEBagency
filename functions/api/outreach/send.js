/**
 * POST /api/outreach/send
 *
 * Sends an automated outreach email to a prospect.
 * Optionally generates a preview first, then includes it in the email.
 *
 * Body: {
 *   to_email: string,         — prospect's email
 *   business_name: string,    — their business name
 *   website_url: string,      — their current website
 *   preview_url?: string,     — optional: pre-generated preview URL
 *   niche?: string,           — optional: for personalization
 * }
 *
 * Env vars:
 *   RESEND_API_KEY, FROM_EMAIL, NOTIFY_EMAIL
 */
import { json, err, corsPreflightResponse, getKV, generateId, esc } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);
  const resendKey = context.env.RESEND_API_KEY;
  if (!resendKey) return err('RESEND_API_KEY not configured', 500);

  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON'); }

  const toEmail = (body.to_email || '').trim();
  const bizName = (body.business_name || '').trim();
  const websiteUrl = (body.website_url || '').trim();
  const previewUrl = (body.preview_url || '').trim();
  const niche = (body.niche || '').trim();

  if (!toEmail) return err('to_email is required');
  if (!bizName) return err('business_name is required');

  const fromEmail = context.env.FROM_EMAIL || 'hello@velocity.delivery';

  // Build personalized outreach email
  const subject = bizName + ' — your website could be working harder for you';
  const html = buildOutreachEmail(bizName, websiteUrl, previewUrl, niche);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Velocity <' + fromEmail + '>',
        to: [toEmail],
        subject: subject,
        html: html,
      }),
    });

    const result = await res.json();

    // Log outreach in KV
    if (kv) {
      const key = 'outreach:' + Date.now() + ':' + toEmail.replace(/[^a-z0-9]/gi, '_');
      await kv.put(key, JSON.stringify({
        to: toEmail,
        business_name: bizName,
        website_url: websiteUrl,
        preview_url: previewUrl,
        sent_at: new Date().toISOString(),
        resend_id: result.id || null,
        success: res.ok,
      }), { expirationTtl: 86400 * 90 });
    }

    return json({
      success: res.ok,
      message: res.ok ? 'Outreach email sent' : 'Failed to send',
      resend_id: result.id || null,
    });
  } catch (e) {
    return err('Email send failed: ' + e.message, 500);
  }
}

function buildOutreachEmail(bizName, websiteUrl, previewUrl, niche) {
  const escaped = {
    name: esc(bizName),
    url: esc(websiteUrl || ''),
    preview: esc(previewUrl || ''),
  };

  const nicheText = niche
    ? `As a fellow ${esc(niche)} professional`
    : 'As a local business';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#12100e;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:560px;margin:0 auto;padding:48px 28px;">

  <div style="font-size:22px;color:#e8ddd3;margin-bottom:32px;">Velocity<span style="color:#c8956a;">.</span></div>

  <h1 style="font-size:24px;color:#e8ddd3;font-weight:400;line-height:1.3;margin:0 0 16px;">
    Hi ${escaped.name},
  </h1>

  <p style="font-size:15px;color:#a89f94;line-height:1.75;margin:0 0 16px;font-family:-apple-system,system-ui,sans-serif;">
    I came across your website${websiteUrl ? ' at <a href="' + escaped.url + '" style="color:#c8956a;">' + escaped.url + '</a>' : ''} and noticed a few things that might be costing you customers.
  </p>

  <p style="font-size:15px;color:#a89f94;line-height:1.75;margin:0 0 20px;font-family:-apple-system,system-ui,sans-serif;">
    ${nicheText}, your website is often the first thing potential customers see. Right now, yours might be turning people away before they even pick up the phone.
  </p>

  <div style="background:#1a1815;border:1px solid #2e2a24;border-radius:12px;padding:24px;margin-bottom:24px;">
    <h2 style="font-size:16px;color:#e8ddd3;font-weight:400;margin:0 0 14px;font-family:Georgia,serif;">
      What we found:
    </h2>
    <table style="width:100%;border-collapse:collapse;font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#a89f94;">
      <tr><td style="padding:6px 0;"><span style="color:#c0695a;margin-right:8px;">&#9679;</span> Slow loading time — visitors leave after 3 seconds</td></tr>
      <tr><td style="padding:6px 0;"><span style="color:#c0695a;margin-right:8px;">&#9679;</span> Not optimized for mobile — 60%+ of searches are on phones</td></tr>
      <tr><td style="padding:6px 0;"><span style="color:#c0695a;margin-right:8px;">&#9679;</span> Missing SEO basics — hard to find on Google</td></tr>
      <tr><td style="padding:6px 0;"><span style="color:#c0695a;margin-right:8px;">&#9679;</span> Outdated design — doesn't inspire customer confidence</td></tr>
    </table>
  </div>

  ${previewUrl ? `
  <div style="text-align:center;margin-bottom:24px;">
    <p style="font-size:14px;color:#c8956a;font-weight:600;margin:0 0 12px;font-family:-apple-system,system-ui,sans-serif;">
      We already built a free preview of what your new site could look like:
    </p>
    <a href="${escaped.preview}" style="display:inline-block;background:#c8956a;color:#12100e;font-family:-apple-system,system-ui,sans-serif;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;">
      See your free preview &rarr;
    </a>
  </div>
  ` : `
  <div style="text-align:center;margin-bottom:24px;">
    <p style="font-size:14px;color:#a89f94;margin:0 0 12px;font-family:-apple-system,system-ui,sans-serif;">
      We'd love to show you what your website could look like — completely free:
    </p>
    <a href="https://velocity.delivery/#start" style="display:inline-block;background:#c8956a;color:#12100e;font-family:-apple-system,system-ui,sans-serif;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;">
      Get your free redesign &rarr;
    </a>
  </div>
  `}

  <div style="background:#1a1815;border:1px solid #2e2a24;border-radius:12px;padding:24px;margin-bottom:24px;">
    <h2 style="font-size:16px;color:#e8ddd3;font-weight:400;margin:0 0 12px;font-family:Georgia,serif;">
      How it works:
    </h2>
    <p style="font-size:13px;color:#a89f94;line-height:1.7;margin:0;font-family:-apple-system,system-ui,sans-serif;">
      <strong style="color:#e8ddd3;">1.</strong> We redesign your website for free (no strings attached)<br>
      <strong style="color:#e8ddd3;">2.</strong> You preview it and tell us what you think<br>
      <strong style="color:#e8ddd3;">3.</strong> If you love it, we build and deploy it. If not, no hard feelings.
    </p>
  </div>

  <p style="font-size:14px;color:#6d6560;line-height:1.7;margin:0 0 8px;font-family:-apple-system,system-ui,sans-serif;text-align:center;">
    No credit card. No obligation. No sales calls.<br>Just a better website, if you want it.
  </p>

  <div style="border-top:1px solid #2e2a24;margin-top:32px;padding-top:20px;text-align:center;">
    <p style="font-size:16px;color:#e8ddd3;margin:0 0 6px;font-family:Georgia,serif;">Velocity<span style="color:#c8956a;">.</span></p>
    <p style="font-size:12px;color:#6d6560;margin:0;font-family:-apple-system,system-ui,sans-serif;">
      Websites for tradespeople who are too busy doing real work.
    </p>
  </div>
</div>
</body></html>`;
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
