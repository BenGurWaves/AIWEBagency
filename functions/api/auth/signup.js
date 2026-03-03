/**
 * POST /api/auth/signup
 * Body: { email, password, website_url? }
 * Creates user, session, optionally a first project, and sends welcome email.
 */
import { json, err, corsPreflightResponse, hashPassword, generateId, createSession, sessionCookie, getKV, esc } from '../../_lib/helpers.js';

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

  // ── Send welcome email via Resend ──────────────────────────
  const resendKey = context.env && context.env.RESEND_API_KEY;
  if (resendKey) {
    const fromEmail = (context.env.FROM_EMAIL || 'hello@velocity.delivery');
    const notifyEmail = context.env.NOTIFY_EMAIL || null;

    // 1. Welcome email to the customer
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
          subject: websiteUrl ? 'Your redesign is on the way!' : 'Welcome to Velocity!',
          html: buildWelcomeEmail(email, websiteUrl),
        }),
      });
    } catch (_) {
      // Don't block sign-up if email fails
    }

    // 2. Notify agency owner about new sign-up
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
            subject: 'New sign-up: ' + email + (websiteUrl ? ' — ' + websiteUrl : ''),
            html: buildSignupNotification(email, websiteUrl),
          }),
        });
      } catch (_) {}
    }
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

// ── Email Templates ───────────────────────────────────────────

function buildWelcomeEmail(email, websiteUrl) {
  const websiteSection = websiteUrl ? `
    <p style="font-size:15px;color:#a89f94;line-height:1.7;margin:0 0 24px;font-family:-apple-system,system-ui,sans-serif;">
      We&rsquo;re already working on a redesign for <strong style="color:#e8ddd3;">${esc(websiteUrl)}</strong>. Sit tight &mdash; your custom preview will be ready within 24&ndash;48 hours.
    </p>` : `
    <p style="font-size:15px;color:#a89f94;line-height:1.7;margin:0 0 24px;font-family:-apple-system,system-ui,sans-serif;">
      Your account is all set. Head to your dashboard to submit your website and get a free redesign preview.
    </p>`;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#12100e;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:560px;margin:0 auto;padding:48px 28px;">

    <!-- Logo -->
    <div style="font-size:22px;color:#e8ddd3;margin-bottom:32px;">Velocity<span style="color:#c8956a;">.</span></div>

    <!-- Welcome -->
    <h1 style="font-size:28px;color:#e8ddd3;font-weight:400;line-height:1.3;margin:0 0 8px;">
      Welcome aboard!
    </h1>
    <p style="font-size:16px;color:#c8956a;font-family:-apple-system,system-ui,sans-serif;margin:0 0 24px;font-weight:600;">
      Your Velocity account is ready.
    </p>

    ${websiteSection}

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
            <strong style="color:#e8ddd3;font-size:14px;display:block;margin-bottom:2px;">Fill out the questionnaire</strong>
            <span style="color:#6d6560;font-size:13px;">Tell us about your business, style preferences, and what you need.</span>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 12px 10px 0;vertical-align:top;">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(200,149,106,0.15);color:#c8956a;text-align:center;line-height:28px;font-size:13px;font-weight:700;">2</div>
          </td>
          <td style="padding:10px 0;">
            <strong style="color:#e8ddd3;font-size:14px;display:block;margin-bottom:2px;">We design your custom preview</strong>
            <span style="color:#6d6560;font-size:13px;">A personalized mockup of your new site, built for your trade.</span>
          </td>
        </tr>
        <tr>
          <td style="padding:10px 12px 10px 0;vertical-align:top;">
            <div style="width:28px;height:28px;border-radius:50%;background:rgba(200,149,106,0.15);color:#c8956a;text-align:center;line-height:28px;font-size:13px;font-weight:700;">3</div>
          </td>
          <td style="padding:10px 0;">
            <strong style="color:#e8ddd3;font-size:14px;display:block;margin-bottom:2px;">Review &amp; approve</strong>
            <span style="color:#6d6560;font-size:13px;">Love it? We build it. Not quite right? Request revisions for free.</span>
          </td>
        </tr>
      </table>
    </div>

    <!-- Dashboard CTA -->
    <div style="text-align:center;margin-bottom:28px;">
      <a href="https://velocity.delivery/dashboard.html" style="display:inline-block;background:#c8956a;color:#12100e;font-family:-apple-system,system-ui,sans-serif;font-size:15px;font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;">
        Go to your dashboard &rarr;
      </a>
    </div>

    <!-- What's Included -->
    <div style="background:#1a1815;border:1px solid #2e2a24;border-radius:12px;padding:24px;margin-bottom:24px;">
      <h2 style="font-size:16px;color:#e8ddd3;font-weight:400;margin:0 0 14px;font-family:Georgia,serif;">
        What&rsquo;s included (completely free):
      </h2>
      <table style="width:100%;border-collapse:collapse;font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#a89f94;">
        <tr><td style="padding:6px 0;"><span style="color:#7fb069;margin-right:8px;">&#10003;</span> Full website audit report</td></tr>
        <tr><td style="padding:6px 0;"><span style="color:#7fb069;margin-right:8px;">&#10003;</span> Custom redesign preview</td></tr>
        <tr><td style="padding:6px 0;"><span style="color:#7fb069;margin-right:8px;">&#10003;</span> Mobile &amp; desktop mockups</td></tr>
        <tr><td style="padding:6px 0;"><span style="color:#7fb069;margin-right:8px;">&#10003;</span> Speed &amp; SEO analysis</td></tr>
        <tr><td style="padding:6px 0;"><span style="color:#7fb069;margin-right:8px;">&#10003;</span> No credit card required</td></tr>
      </table>
    </div>

    <!-- Zero-pressure -->
    <p style="font-size:14px;color:#6d6560;line-height:1.6;margin:0 0 8px;font-family:-apple-system,system-ui,sans-serif;text-align:center;">
      No obligation. No credit card. No sales calls.<br>If you love it, we&rsquo;ll talk. If not, no hard feelings.
    </p>

    <!-- Footer -->
    <div style="border-top:1px solid #2e2a24;margin-top:36px;padding-top:24px;text-align:center;">
      <p style="font-size:18px;color:#e8ddd3;margin:0 0 6px;font-family:Georgia,serif;">Velocity<span style="color:#c8956a;">.</span></p>
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

function buildSignupNotification(email, websiteUrl) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#12100e;font-family:-apple-system,system-ui,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:48px 28px;">
    <div style="font-size:22px;color:#e8ddd3;font-family:Georgia,serif;margin-bottom:28px;">Velocity<span style="color:#c8956a;">.</span></div>

    <div style="background:rgba(200,149,106,0.12);border:1px solid rgba(200,149,106,0.25);border-radius:10px;padding:16px 20px;margin-bottom:24px;">
      <h1 style="font-size:20px;color:#c8956a;font-weight:700;margin:0 0 4px;">New Account Created</h1>
      <p style="font-size:13px;color:#a89f94;margin:0;">A customer just signed up on the dashboard.</p>
    </div>

    <div style="background:#1a1815;border:1px solid #2e2a24;border-radius:10px;padding:20px;margin-bottom:24px;">
      <table style="width:100%;font-size:14px;color:#a89f94;line-height:1.8;border-collapse:collapse;">
        <tr>
          <td style="padding:8px 16px 8px 0;color:#6d6560;font-weight:600;">Email</td>
          <td style="padding:8px 0;"><a href="mailto:${esc(email)}" style="color:#c8956a;">${esc(email)}</a></td>
        </tr>
        ${websiteUrl ? `<tr style="border-top:1px solid #2e2a24;">
          <td style="padding:8px 16px 8px 0;color:#6d6560;font-weight:600;">Website</td>
          <td style="padding:8px 0;"><a href="${esc(websiteUrl)}" style="color:#c8956a;word-break:break-all;">${esc(websiteUrl)}</a></td>
        </tr>` : ''}
        <tr style="border-top:1px solid #2e2a24;">
          <td style="padding:8px 16px 8px 0;color:#6d6560;font-weight:600;">Signed up</td>
          <td style="padding:8px 0;color:#e8ddd3;">${new Date().toISOString()}</td>
        </tr>
      </table>
    </div>

    <div style="text-align:center;">
      <a href="mailto:${esc(email)}" style="display:inline-block;background:#c8956a;color:#12100e;font-size:14px;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;">
        Reply to customer
      </a>
    </div>

    <div style="border-top:1px solid #2e2a24;margin-top:28px;padding-top:20px;text-align:center;">
      <p style="font-size:12px;color:#6d6560;margin:0;">Velocity Internal &mdash; New account sign-up notification.</p>
    </div>
  </div>
</body>
</html>`.trim();
}
