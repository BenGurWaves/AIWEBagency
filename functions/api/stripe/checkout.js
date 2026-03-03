/**
 * POST /api/stripe/checkout
 * Creates a Stripe Checkout Session for the selected plan.
 *
 * Body: { plan: "starter"|"professional"|"premium", email: string }
 * Returns: { url: "https://checkout.stripe.com/..." }
 *
 * Env vars needed:
 *   STRIPE_SECRET_KEY — Stripe secret key (sk_live_... or sk_test_...)
 */
import { json, err, corsPreflightResponse, getKV } from '../../_lib/helpers.js';

const PLANS = {
  starter: {
    name: 'Starter — 5-page custom website',
    amount: 99700, // $997.00
  },
  professional: {
    name: 'Professional — Multi-page + CMS + Blog',
    amount: 199700, // $1,997.00
  },
  premium: {
    name: 'Premium — Full custom + booking system',
    amount: 349700, // $3,497.00
  },
};

export async function onRequestPost(context) {
  const stripeKey = context.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return err('Stripe not configured. Set STRIPE_SECRET_KEY.', 500);

  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON'); }

  const planKey = (body.plan || '').toLowerCase();
  const email = (body.email || '').trim().toLowerCase();
  if (!planKey || !PLANS[planKey]) return err('Invalid plan. Choose starter, professional, or premium.');
  if (!email) return err('Email is required');

  const plan = PLANS[planKey];
  const origin = new URL(context.request.url).origin;

  // Create Stripe Checkout Session via Stripe API
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('customer_email', email);
  params.append('success_url', origin + '/dashboard.html?payment=success&plan=' + planKey);
  params.append('cancel_url', origin + '/dashboard.html?payment=cancelled');
  params.append('line_items[0][price_data][currency]', 'usd');
  params.append('line_items[0][price_data][product_data][name]', plan.name);
  params.append('line_items[0][price_data][product_data][description]', 'One-time payment. Includes design, development, and deployment.');
  params.append('line_items[0][price_data][unit_amount]', String(plan.amount));
  params.append('line_items[0][quantity]', '1');
  params.append('metadata[plan]', planKey);
  params.append('metadata[email]', email);
  params.append('payment_intent_data[metadata][plan]', planKey);
  params.append('payment_intent_data[metadata][email]', email);

  try {
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(stripeKey + ':'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const session = await resp.json();

    if (session.error) {
      return err('Stripe error: ' + (session.error.message || 'Unknown'), 500);
    }

    // Store checkout reference in KV for tracking
    const kv = getKV(context.env);
    if (kv) {
      try {
        await kv.put('checkout:' + session.id, JSON.stringify({
          email, plan: planKey, amount: plan.amount,
          created_at: new Date().toISOString(),
        }), { expirationTtl: 86400 * 7 });
      } catch { /* non-critical */ }
    }

    return json({ url: session.url, session_id: session.id });
  } catch (e) {
    return err('Failed to create checkout session: ' + e.message, 500);
  }
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
