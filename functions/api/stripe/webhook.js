/**
 * POST /api/stripe/webhook
 * Handles Stripe webhook events (payment_intent.succeeded, checkout.session.completed).
 * Updates user plan in KV and sends confirmation email.
 *
 * Env vars:
 *   STRIPE_WEBHOOK_SECRET — Stripe webhook signing secret (whsec_...)
 *   STRIPE_SECRET_KEY     — For verifying signatures
 *   RESEND_API_KEY        — For sending payment confirmation email
 *   FROM_EMAIL            — Sender email
 *   NOTIFY_EMAIL          — Agency owner notification email
 */
import { getKV } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);
  const webhookSecret = context.env.STRIPE_WEBHOOK_SECRET;
  const rawBody = await context.request.text();

  // Parse event (with optional signature verification)
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid payload', { status: 400 });
  }

  // If webhook secret is set, verify signature
  if (webhookSecret) {
    const sig = context.request.headers.get('stripe-signature') || '';
    const verified = await verifyStripeSignature(rawBody, sig, webhookSecret);
    if (!verified) return new Response('Invalid signature', { status: 400 });
  }

  const type = event.type;

  if (type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = (session.customer_email || session.metadata?.email || '').toLowerCase();
    const plan = session.metadata?.plan || 'starter';

    if (email && kv) {
      // Update user plan
      try {
        const userData = await kv.get('user:' + email, { type: 'json' });
        if (userData) {
          userData.plan = plan;
          userData.paid_at = new Date().toISOString();
          userData.stripe_session = session.id;
          await kv.put('user:' + email, JSON.stringify(userData), { expirationTtl: 86400 * 365 });
        }
      } catch { /* non-critical */ }

      // Update redesign record
      try {
        const redesign = await kv.get('redesign:' + email, { type: 'json' });
        if (redesign) {
          redesign.plan = plan;
          redesign.paid_at = new Date().toISOString();
          await kv.put('redesign:' + email, JSON.stringify(redesign), { expirationTtl: 86400 * 90 });
        }
      } catch { /* non-critical */ }

      // Send payment confirmation email
      const resendKey = context.env.RESEND_API_KEY;
      if (resendKey) {
        const fromEmail = context.env.FROM_EMAIL || 'hello@velocity.delivery';
        const planNames = { starter: 'Starter', professional: 'Professional', premium: 'Premium' };
        const planPrices = { starter: '$997', professional: '$1,997', premium: '$3,497' };

        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'Velocity <' + fromEmail + '>',
              to: [email],
              subject: 'Payment confirmed — we\'re building your website!',
              html: buildPaymentEmail(planNames[plan] || plan, planPrices[plan] || ''),
            }),
          });
        } catch { /* non-critical */ }

        // Notify agency
        const notifyEmail = context.env.NOTIFY_EMAIL;
        if (notifyEmail) {
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: 'Velocity <' + fromEmail + '>',
                to: [notifyEmail],
                subject: 'Payment received: ' + email + ' — ' + (planNames[plan] || plan),
                html: '<h2>Payment received!</h2><p>Customer: ' + email + '</p><p>Plan: ' + (planNames[plan] || plan) + '</p><p>Amount: ' + (planPrices[plan] || 'N/A') + '</p>',
              }),
            });
          } catch { /* non-critical */ }
        }
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Simple HMAC-SHA256 signature verification for Stripe webhooks
async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = {};
    sigHeader.split(',').forEach(p => {
      const [k, v] = p.split('=');
      parts[k] = v;
    });
    const timestamp = parts.t;
    const sig = parts.v1;
    if (!timestamp || !sig) return false;

    const signedPayload = timestamp + '.' + payload;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
    const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
    return expected === sig;
  } catch {
    return false;
  }
}

function buildPaymentEmail(planName, price) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#12100e;font-family:-apple-system,system-ui,sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:48px 28px;">
  <div style="font-size:22px;color:#e8ddd3;font-family:Georgia,serif;margin-bottom:28px;">Velocity<span style="color:#c8956a;">.</span></div>
  <div style="background:rgba(127,176,105,0.12);border:1px solid rgba(127,176,105,0.25);border-radius:10px;padding:20px;margin-bottom:24px;text-align:center;">
    <div style="font-size:24px;margin-bottom:8px;">&#10003;</div>
    <h1 style="font-size:22px;color:#7fb069;margin:0 0 4px;">Payment Confirmed!</h1>
    <p style="font-size:14px;color:#a89f94;margin:0;">${planName} Plan &mdash; ${price}</p>
  </div>
  <h2 style="font-size:18px;color:#e8ddd3;font-weight:400;margin:0 0 12px;font-family:Georgia,serif;">We're building your website.</h2>
  <p style="font-size:14px;color:#a89f94;line-height:1.7;margin:0 0 20px;">
    Thank you for choosing Velocity. Our team is now working on your site. Here's what happens next:
  </p>
  <div style="background:#1a1815;border:1px solid #2e2a24;border-radius:10px;padding:20px;margin-bottom:24px;">
    <p style="font-size:13px;color:#a89f94;line-height:1.8;margin:0;">
      <span style="color:#7fb069;margin-right:6px;">&#10003;</span> <strong style="color:#e8ddd3;">Day 1-2:</strong> We finalize the design based on your approved preview<br>
      <span style="color:#7fb069;margin-right:6px;">&#10003;</span> <strong style="color:#e8ddd3;">Day 3-5:</strong> Full website build, responsive & mobile-tested<br>
      <span style="color:#7fb069;margin-right:6px;">&#10003;</span> <strong style="color:#e8ddd3;">Day 5-7:</strong> Final review, deployment, and go-live!
    </p>
  </div>
  <div style="text-align:center;margin-bottom:24px;">
    <a href="https://velocity.delivery/dashboard.html" style="display:inline-block;background:#c8956a;color:#12100e;font-size:14px;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;">Track progress in your dashboard &rarr;</a>
  </div>
  <div style="border-top:1px solid #2e2a24;margin-top:28px;padding-top:20px;text-align:center;">
    <p style="font-size:12px;color:#6d6560;margin:0;">Questions? Just reply to this email.</p>
  </div>
</div>
</body></html>`;
}
