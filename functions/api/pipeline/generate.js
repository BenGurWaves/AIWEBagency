/**
 * POST /api/pipeline/generate
 *
 * Accepts questionnaire data + website URL, scrapes the site,
 * merges extracted info with user-provided data, generates a
 * high-quality personalized preview, and stores it in KV.
 *
 * No session required — uses email as identifier.
 * Returns { preview_id, preview_url }
 */
import { json, err, corsPreflightResponse, getKV, generateId, esc } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);
  if (!kv) return err('Storage not configured', 500);

  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON'); }

  const email = (body.email || '').trim().toLowerCase();
  if (!email) return err('email is required');

  const websiteUrl = (body.website_url || '').trim();
  const previewId = generateId();

  // ── 1. Scrape the existing website (best-effort) ──────────
  let siteHtml = '';
  if (websiteUrl) {
    try {
      const resp = await fetch(websiteUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelocityBot/1.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      siteHtml = await resp.text();
    } catch { /* scrape failed — we'll use questionnaire data */ }
  }

  // ── 2. Extract info from HTML ─────────────────────────────
  const scraped = extractBusinessInfo(siteHtml, websiteUrl);

  // ── 3. Merge: questionnaire data takes priority over scraped ─
  const biz = {
    name:     body.business_name || scraped.name || 'Your Business',
    phone:    body.phone         || scraped.phone || '',
    email:    body.contact_email || scraped.email || email,
    location: body.location      || scraped.address || '',
    tagline:  scraped.tagline    || '',
    domain:   scraped.domain     || '',
    niche:    body.niche         || '',
    services: body.services      || '',
    years:    body.years         || '',
    style:    body.style         || 'modern-clean',
    siteType: body.site_type     || 'service-business',
    inspo:    body.inspo_urls    || '',
    notes:    body.notes         || '',
  };

  // ── 4. Generate preview HTML ──────────────────────────────
  const previewHtml = generatePreview(biz);

  // ── 5. Store in KV ────────────────────────────────────────
  await kv.put(`preview:${previewId}`, previewHtml, { expirationTtl: 86400 * 90 });

  // Also update redesign record
  try {
    const existing = await kv.get('redesign:' + email, { type: 'json' }) || {};
    Object.assign(existing, body, {
      preview_id: previewId,
      preview_url: `/preview/${previewId}`,
      preview_generated_at: new Date().toISOString(),
    });
    await kv.put('redesign:' + email, JSON.stringify(existing), { expirationTtl: 86400 * 90 });
  } catch { /* non-critical */ }

  return json({
    success: true,
    preview_id: previewId,
    preview_url: `/preview/${previewId}`,
  });
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}

// ── Business info extraction ──────────────────────────────────

function extractBusinessInfo(html, url) {
  const info = { name: '', phone: '', email: '', address: '', tagline: '', domain: '' };
  try { info.domain = new URL(url).hostname.replace('www.', ''); } catch { info.domain = url || ''; }
  if (!html) return info;

  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (titleMatch) {
    let t = titleMatch[1].replace(/\s*[-|–—:].*/g, '').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/<[^>]+>/g, '').trim();
    if (t.length > 2 && t.length < 60) info.name = t;
  }
  const phoneMatch = html.match(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
  if (phoneMatch) info.phone = phoneMatch[1];
  const emailMatch = html.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) info.email = emailMatch[1];
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/i);
  if (descMatch && descMatch[1].length > 10 && descMatch[1].length < 200) info.tagline = descMatch[1];
  const addrMatch = html.match(/\d{2,5}\s+[\w\s.]+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct|Pl)[.,]?\s*(?:Suite|Ste|#|Apt)?\s*\d*[.,]?\s*\w+[.,]?\s*[A-Z]{2}\s+\d{5}/i);
  if (addrMatch) info.address = addrMatch[0].trim();
  return info;
}

// ── Niche-specific content ────────────────────────────────────

function getNicheContent(niche) {
  const map = {
    'roofing': {
      tagline: 'Protecting your home from the top down.',
      hero: 'Trusted roofing for homes and businesses.',
      services: ['Roof Repair', 'Full Replacement', 'Inspections', 'Storm Damage', 'Gutter Installation', 'Commercial Roofing'],
      icons: ['M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M9 22V12h6v10', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
    },
    'plumbing': {
      tagline: 'Reliable plumbing you can count on.',
      hero: 'Fast, honest plumbing for your home.',
      services: ['Leak Repair', 'Drain Cleaning', 'Water Heaters', 'Pipe Replacement', 'Emergency Service', 'Repiping'],
      icons: ['M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z', 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
    },
    'hvac': {
      tagline: 'Keeping you comfortable, year-round.',
      hero: 'Heating & cooling you can rely on.',
      services: ['AC Repair', 'Furnace Service', 'Installation', 'Duct Cleaning', 'Maintenance Plans', 'Indoor Air Quality'],
      icons: ['M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z', 'M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
    },
    'electrical': {
      tagline: 'Safe, reliable electrical for every project.',
      hero: 'Licensed electricians you can trust.',
      services: ['Wiring & Rewiring', 'Panel Upgrades', 'Lighting', 'Generators', 'EV Chargers', 'Code Compliance'],
      icons: ['M13 2L3 14h9l-1 8 10-12h-9l1-8z', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M9 18V5l12-2v13'],
    },
    'landscaping': {
      tagline: 'Transforming outdoor spaces.',
      hero: 'Beautiful landscapes, built to last.',
      services: ['Lawn Care', 'Landscape Design', 'Hardscaping', 'Tree Service', 'Irrigation', 'Seasonal Cleanup'],
      icons: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M7 20l4-16m2 16l4-16', 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
    },
    'painting': {
      tagline: 'Color and craft for every surface.',
      hero: 'Professional painting that transforms spaces.',
      services: ['Interior Painting', 'Exterior Painting', 'Cabinet Refinishing', 'Commercial', 'Color Consultation', 'Deck Staining'],
      icons: ['M12 19l7-7 3 3-7 7-3-3z', 'M2 12l5 5L22 2', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
    },
    'cleaning': {
      tagline: 'Spotless spaces, every single time.',
      hero: 'Professional cleaning you can rely on.',
      services: ['Deep Cleaning', 'Regular Service', 'Move-in/Out', 'Commercial', 'Carpet Cleaning', 'Window Washing'],
      icons: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M5 12h14'],
    },
    'construction': {
      tagline: 'Building quality that lasts generations.',
      hero: 'Custom construction, built right.',
      services: ['Custom Homes', 'Renovations', 'Additions', 'Commercial Build-Out', 'Concrete', 'Framing'],
      icons: ['M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
    },
    'auto-repair': {
      tagline: 'Honest auto care you can trust.',
      hero: 'Reliable auto service, fair prices.',
      services: ['Oil Changes', 'Brake Service', 'Engine Repair', 'Diagnostics', 'Tire Service', 'AC Repair'],
      icons: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z', 'M5 12h14'],
    },
  };
  return map[niche] || {
    tagline: 'Quality service you can count on.',
    hero: 'Professional service, exceptional results.',
    services: ['Core Service', 'Consultation', 'Emergency Work', 'Maintenance', 'Custom Solutions', 'Full Support'],
    icons: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z', 'M5 12h14'],
  };
}

// ── Theme color palettes ──────────────────────────────────────

function getTheme(style) {
  const themes = {
    'modern-clean': {
      bg: '#fafaf8', bgAlt: '#f2f1ed', nav: '#ffffff', accent: '#1a6b44', accentHover: '#15573a',
      accentBg: 'rgba(26,107,68,0.06)', trust: '#1a3a2a', text: '#1a2e22', textSec: '#5a6b60',
      muted: '#8a9b90', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #f0f7f3 0%, #fafaf8 50%, #f7f5f0 100%)',
      font: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'Inter:wght@400;500;600;700',
    },
    'bold-dark': {
      bg: '#0e0c0a', bgAlt: '#161412', nav: '#121010', accent: '#c8956a', accentHover: '#d4a57a',
      accentBg: 'rgba(200,149,106,0.08)', trust: '#1a1614', text: '#e8ddd3', textSec: '#a89f94',
      muted: '#6d6560', card: '#1a1815', border: 'rgba(255,255,255,0.06)', heroGrad: 'linear-gradient(135deg, #1a1410 0%, #0e0c0a 50%, #12100e 100%)',
      font: "'DM Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'DM+Sans:wght@400;500;600;700',
    },
    'warm-friendly': {
      bg: '#faf6f1', bgAlt: '#f3ece3', nav: '#ffffff', accent: '#c66b2e', accentHover: '#b55e24',
      accentBg: 'rgba(198,107,46,0.07)', trust: '#3b2a18', text: '#2e2218', textSec: '#7a6a56',
      muted: '#a09080', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #fdf3e8 0%, #faf6f1 50%, #f8f0e6 100%)',
      font: "'Nunito Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'Nunito+Sans:wght@400;500;600;700',
    },
    'professional': {
      bg: '#f5f6f8', bgAlt: '#eef0f4', nav: '#ffffff', accent: '#2955a3', accentHover: '#1e4590',
      accentBg: 'rgba(41,85,163,0.06)', trust: '#1a2a4a', text: '#1a2030', textSec: '#5a6578',
      muted: '#8a90a0', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #eef2fa 0%, #f5f6f8 50%, #f0f2f8 100%)',
      font: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'Inter:wght@400;500;600;700',
    },
    'rustic': {
      bg: '#f4f0e8', bgAlt: '#ebe5da', nav: '#ffffff', accent: '#7a6040', accentHover: '#6a5035',
      accentBg: 'rgba(122,96,64,0.07)', trust: '#3a3020', text: '#2e2418', textSec: '#706050',
      muted: '#9a8a78', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #f0ebe0 0%, #f4f0e8 50%, #ede8dd 100%)',
      font: "'Lora', Georgia, 'Times New Roman', serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'Lora:wght@400;500;600;700',
    },
    'surprise': {
      bg: '#faf8ff', bgAlt: '#f2f0fa', nav: '#ffffff', accent: '#7c3aed', accentHover: '#6d28d9',
      accentBg: 'rgba(124,58,237,0.06)', trust: '#2a1a4a', text: '#1e1b2e', textSec: '#6b6580',
      muted: '#9a95a8', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #f0ecff 0%, #faf8ff 50%, #f4f0ff 100%)',
      font: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'Inter:wght@400;500;600;700',
    },
  };
  return themes[style] || themes['modern-clean'];
}

// ── Preview HTML generator ────────────────────────────────────

function generatePreview(biz) {
  const t = getTheme(biz.style);
  const nc = getNicheContent(biz.niche);
  const name = esc(biz.name);
  const phone = esc(biz.phone || '(555) 123-4567');
  const phoneHref = (biz.phone || '5551234567').replace(/[^0-9+]/g, '');
  const loc = esc(biz.location || 'Your Area');
  const years = esc(biz.years || '10+');
  const tagline = esc(biz.tagline || nc.tagline);
  const heroLine = esc(nc.hero);
  const contactEmail = esc(biz.email || '');
  const year = new Date().getFullYear();

  // Parse services: user-provided take priority, fallback to niche defaults
  let services = [];
  if (biz.services) {
    services = biz.services.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (services.length < 4) {
    const defaults = nc.services;
    while (services.length < 6) {
      const d = defaults[services.length] || 'Service ' + (services.length + 1);
      if (!services.includes(d)) services.push(d);
    }
  }
  services = services.slice(0, 6);

  const isDark = biz.style === 'bold-dark';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name} | ${esc(biz.niche || 'Professional Services')} in ${loc}</title>
<meta name="description" content="${tagline} Serving ${loc} for ${years} years.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${t.gFont}&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:${t.bg};--bg-alt:${t.bgAlt};--nav:${t.nav};--accent:${t.accent};--accent-hover:${t.accentHover};--accent-bg:${t.accentBg};--trust:${t.trust};--text:${t.text};--text-sec:${t.textSec};--muted:${t.muted};--card:${t.card};--border:${t.border};--font:${t.font};--font-head:${t.fontHead};--radius:8px;--radius-lg:14px}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.6;overflow-x:hidden}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}

/* ── Nav ── */
.nav{position:sticky;top:0;z-index:100;background:var(--nav);border-bottom:1px solid var(--border);padding:0 24px}
.nav-inner{max-width:1100px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:64px}
.nav-logo{font-family:var(--font-head);font-size:20px;font-weight:400;color:var(--text);letter-spacing:-.02em}
.nav-logo span{color:var(--accent)}
.nav-links{display:flex;align-items:center;gap:28px;font-size:14px;color:var(--text-sec)}
.nav-links a:hover{color:var(--text)}
.nav-cta{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#fff;padding:8px 18px;border-radius:var(--radius);font-weight:600;font-size:13px;transition:background .2s}
.nav-cta:hover{background:var(--accent-hover);color:#fff}

/* ── Hero ── */
.hero{padding:80px 24px 60px;background:${t.heroGrad};position:relative;overflow:hidden}
.hero::after{content:'';position:absolute;top:-50%;right:-20%;width:600px;height:600px;border-radius:50%;background:var(--accent-bg);filter:blur(80px);pointer-events:none}
.hero-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1.1fr 0.9fr;gap:60px;align-items:center}
.hero-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);margin-bottom:12px}
.hero h1{font-family:var(--font-head);font-size:clamp(32px,5vw,52px);font-weight:400;line-height:1.1;letter-spacing:-.02em;margin-bottom:16px;color:var(--text)}
.hero h1 em{color:var(--accent);font-style:italic}
.hero-desc{font-size:16px;color:var(--text-sec);line-height:1.7;margin-bottom:28px;max-width:480px}
.hero-btns{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:32px}
.btn-primary{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#fff;padding:14px 28px;border-radius:var(--radius);font-weight:600;font-size:15px;transition:all .2s;border:none;cursor:pointer}
.btn-primary:hover{background:var(--accent-hover);transform:translateY(-1px);box-shadow:0 4px 16px ${isDark ? 'rgba(200,149,106,.2)' : 'rgba(0,0,0,.1)'}}
.btn-outline{display:inline-flex;align-items:center;gap:8px;background:transparent;color:var(--text-sec);padding:14px 28px;border-radius:var(--radius);font-weight:500;font-size:15px;border:1px solid var(--border);transition:all .2s;cursor:pointer}
.btn-outline:hover{border-color:var(--accent);color:var(--accent)}
.hero-proof{display:flex;align-items:center;gap:12px}
.hero-stars{color:#f5b731;font-size:14px;letter-spacing:1px}
.hero-proof-text{font-size:13px;color:var(--text-sec)}
.hero-proof-text strong{color:var(--text)}
.hero-visual{display:flex;align-items:center;justify-content:center}
.hero-card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:32px;box-shadow:0 20px 60px ${isDark ? 'rgba(0,0,0,.3)' : 'rgba(0,0,0,.08)'}}
.hero-card-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);margin-bottom:16px}
.hero-card-stat{font-family:var(--font-head);font-size:48px;color:var(--text);line-height:1;margin-bottom:4px}
.hero-card-desc{font-size:14px;color:var(--text-sec);margin-bottom:20px}
.hero-card-row{display:flex;gap:16px}
.hero-card-mini{flex:1;text-align:center;padding:12px 8px;background:var(--accent-bg);border-radius:var(--radius)}
.hero-card-mini strong{display:block;font-family:var(--font-head);font-size:20px;color:var(--accent)}
.hero-card-mini span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}

/* ── Trust ── */
.trust{background:var(--trust);padding:20px 24px;text-align:center}
.trust-inner{max-width:1100px;margin:0 auto;display:flex;justify-content:center;gap:48px;flex-wrap:wrap}
.trust-item{display:flex;flex-direction:column;align-items:center;gap:2px}
.trust-num{font-family:var(--font-head);font-size:24px;color:#fff;font-weight:400}
.trust-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.5)}

/* ── Services ── */
.services{padding:80px 24px;background:var(--bg)}
.services-inner{max-width:1100px;margin:0 auto}
.section-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);margin-bottom:8px}
.section-title{font-family:var(--font-head);font-size:clamp(24px,3.5vw,36px);font-weight:400;margin-bottom:12px;color:var(--text)}
.section-desc{font-size:15px;color:var(--text-sec);line-height:1.7;margin-bottom:40px;max-width:520px}
.services-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.service-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:28px;transition:all .25s}
.service-card:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 8px 24px ${isDark ? 'rgba(0,0,0,.2)' : 'rgba(0,0,0,.06)'}}
.service-icon{width:44px;height:44px;border-radius:var(--radius);background:var(--accent-bg);display:flex;align-items:center;justify-content:center;margin-bottom:16px;color:var(--accent)}
.service-card h3{font-size:16px;font-weight:600;margin-bottom:6px}
.service-card p{font-size:13px;color:var(--text-sec);line-height:1.6}

/* ── About ── */
.about{padding:80px 24px;background:var(--bg-alt)}
.about-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:60px;align-items:center}
.about-img{width:100%;aspect-ratio:4/3;background:var(--accent-bg);border-radius:var(--radius-lg);display:flex;align-items:center;justify-content:center}
.about-img svg{width:80px;height:80px;color:var(--accent);opacity:.3}
.about-text h2{font-family:var(--font-head);font-size:28px;font-weight:400;margin-bottom:16px}
.about-text p{font-size:15px;color:var(--text-sec);line-height:1.75;margin-bottom:16px}
.about-stats{display:flex;gap:24px;margin-top:24px}
.about-stat{text-align:center}
.about-stat strong{display:block;font-family:var(--font-head);font-size:28px;color:var(--accent)}
.about-stat span{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}

/* ── Testimonials ── */
.testimonials{padding:80px 24px;background:var(--bg)}
.testimonials-inner{max-width:1100px;margin:0 auto}
.testimonials-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.testimonial-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:28px}
.testimonial-stars{color:#f5b731;font-size:13px;letter-spacing:1px;margin-bottom:12px}
.testimonial-card blockquote{font-size:14px;color:var(--text-sec);font-style:italic;line-height:1.65;margin-bottom:16px}
.testimonial-card cite{font-style:normal;font-size:13px;font-weight:600;color:var(--text);display:block}
.testimonial-card cite span{font-weight:400;color:var(--muted);font-size:12px;display:block;margin-top:2px}

/* ── CTA ── */
.cta{padding:80px 24px;background:var(--bg-alt);text-align:center}
.cta-inner{max-width:600px;margin:0 auto}
.cta h2{font-family:var(--font-head);font-size:clamp(24px,3.5vw,36px);font-weight:400;margin-bottom:12px}
.cta h2 em{color:var(--accent);font-style:italic}
.cta p{font-size:15px;color:var(--text-sec);line-height:1.7;margin-bottom:28px}
.cta-btns{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}

/* ── Footer ── */
footer{padding:48px 24px 32px;border-top:1px solid var(--border);background:var(--bg)}
.footer-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:40px}
.footer-brand .nav-logo{margin-bottom:12px;display:inline-block}
.footer-brand p{font-size:13px;color:var(--muted);line-height:1.6;max-width:240px}
.footer-col h4{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:12px}
.footer-col ul{list-style:none}
.footer-col li{margin-bottom:6px}
.footer-col a{font-size:13px;color:var(--text-sec);transition:color .2s}
.footer-col a:hover{color:var(--accent)}
.footer-bottom{max-width:1100px;margin:32px auto 0;padding-top:24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}
.footer-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--accent);background:var(--accent-bg);padding:4px 10px;border-radius:4px;font-weight:600}

/* ── Responsive ── */
@media(max-width:900px){
  .hero-inner{grid-template-columns:1fr;gap:40px}
  .hero-visual{display:none}
  .services-grid{grid-template-columns:1fr 1fr}
  .about-inner{grid-template-columns:1fr}
  .about-img{display:none}
  .testimonials-grid{grid-template-columns:1fr}
  .footer-inner{grid-template-columns:1fr 1fr;gap:24px}
  .footer-brand{grid-column:1/-1}
}
@media(max-width:600px){
  .services-grid{grid-template-columns:1fr}
  .trust-inner{gap:24px}
  .nav-links{display:none}
  .hero{padding:60px 20px 40px}
  .footer-inner{grid-template-columns:1fr}
  .footer-bottom{flex-direction:column;gap:8px;text-align:center}
}

/* ── Animations ── */
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.fade-up{animation:fadeUp .6s ease both}
.fade-up-1{animation-delay:.1s}
.fade-up-2{animation-delay:.2s}
.fade-up-3{animation-delay:.3s}
</style>
</head>
<body>

<!-- Nav -->
<nav class="nav">
  <div class="nav-inner">
    <a href="#" class="nav-logo">${name}<span>.</span></a>
    <div class="nav-links">
      <a href="#services">Services</a>
      <a href="#about">About</a>
      <a href="#testimonials">Reviews</a>
      <a href="tel:${phoneHref}" class="nav-cta">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        Call ${phone}
      </a>
    </div>
  </div>
</nav>

<!-- Hero -->
<section class="hero">
  <div class="hero-inner">
    <div class="fade-up">
      <div class="hero-label">${esc(biz.niche || 'Professional Services')} in ${loc}</div>
      <h1>${heroLine.split(' ').length > 4 ? heroLine : `${name} &mdash; <em>${heroLine.toLowerCase()}</em>`}</h1>
      <p class="hero-desc">${tagline} Serving ${loc} ${biz.years ? `for over ${years} years` : 'and surrounding areas'}. Licensed, insured, and ready to help.</p>
      <div class="hero-btns">
        <a href="tel:${phoneHref}" class="btn-primary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          Get Free Quote
        </a>
        <a href="#services" class="btn-outline">Our Services</a>
      </div>
      <div class="hero-proof">
        <span class="hero-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
        <span class="hero-proof-text">Rated <strong>4.9/5</strong> by homeowners in ${loc}</span>
      </div>
    </div>
    <div class="hero-visual fade-up fade-up-1">
      <div class="hero-card">
        <div class="hero-card-label">Why choose ${name}?</div>
        <div class="hero-card-stat">${years}</div>
        <div class="hero-card-desc">Years of trusted service in ${loc}</div>
        <div class="hero-card-row">
          <div class="hero-card-mini"><strong>4.9</strong><span>Rating</span></div>
          <div class="hero-card-mini"><strong>500+</strong><span>Jobs done</span></div>
          <div class="hero-card-mini"><strong>100%</strong><span>Licensed</span></div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Trust Bar -->
<div class="trust">
  <div class="trust-inner">
    <div class="trust-item"><div class="trust-num">${years}</div><div class="trust-label">Years Experience</div></div>
    <div class="trust-item"><div class="trust-num">4.9</div><div class="trust-label">Star Rating</div></div>
    <div class="trust-item"><div class="trust-num">500+</div><div class="trust-label">Jobs Completed</div></div>
    <div class="trust-item"><div class="trust-num">A+</div><div class="trust-label">BBB Rating</div></div>
    <div class="trust-item"><div class="trust-num">100%</div><div class="trust-label">Licensed &amp; Insured</div></div>
  </div>
</div>

<!-- Services -->
<section class="services" id="services">
  <div class="services-inner">
    <div class="section-label">What We Do</div>
    <div class="section-title">Our Services</div>
    <div class="section-desc">From routine work to emergency calls, we handle it all with the same level of care and professionalism. Every job, every time.</div>
    <div class="services-grid">
${services.map((s, i) => `      <div class="service-card fade-up fade-up-${Math.min(i, 3)}">
        <div class="service-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${nc.icons[i % nc.icons.length]}"/></svg></div>
        <h3>${esc(s)}</h3>
        <p>Professional ${esc(s.toLowerCase())} service with quality materials and workmanship you can count on.</p>
      </div>`).join('\n')}
    </div>
  </div>
</section>

<!-- About -->
<section class="about" id="about">
  <div class="about-inner">
    <div class="about-img">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    </div>
    <div class="about-text">
      <div class="section-label">About Us</div>
      <h2>Serving ${loc} since day one.</h2>
      <p>${name} has been a trusted name in ${loc} ${biz.years ? `for over ${years} years` : 'serving the local community'}. We believe in honest pricing, quality workmanship, and treating every home like our own.</p>
      <p>Our team is fully licensed, insured, and committed to your satisfaction. We show up on time, communicate clearly, and clean up when we're done.</p>
      <div class="about-stats">
        <div class="about-stat"><strong>${years}</strong><span>Years</span></div>
        <div class="about-stat"><strong>500+</strong><span>Projects</span></div>
        <div class="about-stat"><strong>4.9</strong><span>Rating</span></div>
      </div>
    </div>
  </div>
</section>

<!-- Testimonials -->
<section class="testimonials" id="testimonials">
  <div class="testimonials-inner">
    <div class="section-label">Reviews</div>
    <div class="section-title">What our customers say</div>
    <div class="section-desc">Don't take our word for it — hear from the homeowners and businesses we've worked with.</div>
    <div class="testimonials-grid">
      <div class="testimonial-card fade-up">
        <div class="testimonial-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
        <blockquote>"Outstanding work from start to finish. Professional, on time, and the quality speaks for itself. Highly recommended."</blockquote>
        <cite>Sarah M.<span>Homeowner in ${loc}</span></cite>
      </div>
      <div class="testimonial-card fade-up fade-up-1">
        <div class="testimonial-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
        <blockquote>"We've used ${name} twice now and both times they exceeded expectations. Fair pricing, great communication."</blockquote>
        <cite>David R.<span>Business Owner</span></cite>
      </div>
      <div class="testimonial-card fade-up fade-up-2">
        <div class="testimonial-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
        <blockquote>"Honest, reliable, and skilled. They showed up when they said they would and did exactly what was promised."</blockquote>
        <cite>Jennifer K.<span>Homeowner in ${loc}</span></cite>
      </div>
    </div>
  </div>
</section>

<!-- CTA -->
<section class="cta">
  <div class="cta-inner">
    <div class="section-label">Get Started</div>
    <h2>Ready to get <em>started?</em></h2>
    <p>Contact us today for a free, no-obligation estimate. We'll get back to you within 24 hours.</p>
    <div class="cta-btns">
      <a href="tel:${phoneHref}" class="btn-primary">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        Call ${phone}
      </a>
      ${contactEmail ? `<a href="mailto:${contactEmail}" class="btn-outline">Email Us</a>` : `<a href="#" class="btn-outline">Request a Quote</a>`}
    </div>
  </div>
</section>

<!-- Footer -->
<footer>
  <div class="footer-inner">
    <div class="footer-brand">
      <a href="#" class="nav-logo">${name}<span>.</span></a>
      <p>${tagline} Serving ${loc} ${biz.years ? `for ${years} years` : 'and surrounding areas'}.</p>
    </div>
    <div class="footer-col">
      <h4>Services</h4>
      <ul>
${services.slice(0, 4).map(s => `        <li><a href="#services">${esc(s)}</a></li>`).join('\n')}
      </ul>
    </div>
    <div class="footer-col">
      <h4>Company</h4>
      <ul>
        <li><a href="#about">About Us</a></li>
        <li><a href="#testimonials">Reviews</a></li>
        <li><a href="#services">Services</a></li>
        <li><a href="#">Contact</a></li>
      </ul>
    </div>
    <div class="footer-col">
      <h4>Contact</h4>
      <ul>
        <li><a href="tel:${phoneHref}">${phone}</a></li>
        ${contactEmail ? `<li><a href="mailto:${contactEmail}">${contactEmail}</a></li>` : ''}
        <li>${loc}</li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom">
    <span>&copy; ${year} ${name}. All rights reserved.</span>
    <span class="footer-badge">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      Redesigned by Velocity
    </span>
  </div>
</footer>

<script>
// Scroll-triggered fade-in
if('IntersectionObserver' in window){
  var obs=new IntersectionObserver(function(e){e.forEach(function(en){if(en.isIntersecting){en.target.classList.add('fade-up');obs.unobserve(en.target)}})},{threshold:.1,rootMargin:'0px 0px -30px 0px'});
  document.querySelectorAll('.service-card,.testimonial-card').forEach(function(el){el.style.opacity='0';el.style.transform='translateY(20px)';el.style.transition='opacity .6s ease, transform .6s ease';obs.observe(el)});
}
</script>
</body>
</html>`;
}
