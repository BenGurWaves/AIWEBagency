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

// ── Niche-specific content (enhanced for quality) ─────────────

function getNicheContent(niche, biz) {
  const name = biz.name;
  const loc = biz.location || 'your area';
  const years = biz.years || '10+';

  const base = {
    'roofing': {
      heroHeadline: `The roof over your family deserves better.`,
      heroSub: `${name} has protected homes across ${loc} for ${years} years. When it's time for a roof that lasts, you call the team that stands behind every shingle.`,
      services: [
        { name: 'Roof Replacement', desc: `Complete tear-off and install with manufacturer-backed warranties. We handle permits, disposal, everything.` },
        { name: 'Storm Damage Repair', desc: `Hail, wind, fallen branches — we respond fast and work directly with your insurance company.` },
        { name: 'Roof Inspections', desc: `Catch small problems before they become expensive ones. Detailed reports with photos and recommendations.` },
        { name: 'Leak Detection & Repair', desc: `Persistent leak? We track it to the source and fix it right the first time. No guesswork.` },
        { name: 'Gutter Systems', desc: `Seamless aluminum gutters installed and integrated with your roofing system for complete water management.` },
        { name: 'Commercial Roofing', desc: `Flat roofs, TPO, EPDM, metal — we handle commercial properties of every size with minimal disruption.` },
      ],
      aboutText: `${name} started with a simple belief: every homeowner deserves honest answers about their roof. No pressure sales. No inflated quotes. Just straight talk from people who've been doing this for ${years} years.\n\nWe're fully licensed, insured, and every job comes with our written satisfaction guarantee.`,
      testimonials: [
        { text: `They replaced our entire roof in a day and a half. Showed up when they said, kept the yard clean, and the price was exactly what they quoted. No surprises.`, author: 'Mike R.', role: `Homeowner, ${loc}` },
        { text: `After the storm, five roofers knocked on our door. ${name} was the only one who didn't try to upsell us. They just told us what we needed and did it right.`, author: 'Sarah T.', role: `Homeowner, ${loc}` },
        { text: `Used them for our warehouse roof. Professional crew, on schedule, and the foreman kept us updated every step of the way.`, author: 'David L.', role: `Business Owner` },
      ],
    },
    'plumbing': {
      heroHeadline: `When water goes where it shouldn't, you need someone who answers the phone.`,
      heroSub: `${name} has been the first call for ${loc} homeowners for ${years} years. Fast response. Fair pricing. Plumbing that actually works when we leave.`,
      services: [
        { name: 'Emergency Plumbing', desc: `Burst pipe at 2am? Overflowing toilet? We answer 24/7 and typically arrive within the hour.` },
        { name: 'Drain Cleaning', desc: `Slow drains, backups, root intrusion — we clear the blockage and camera-inspect the line so it stays clear.` },
        { name: 'Water Heater Service', desc: `Repair or replacement for tank and tankless systems. Same-day install available on most models.` },
        { name: 'Leak Detection', desc: `Electronic leak detection finds hidden leaks behind walls and under slabs without tearing up your home.` },
        { name: 'Repiping', desc: `Whole-house repiping with copper or PEX. We plan around your schedule and minimize wall openings.` },
        { name: 'Fixture Installation', desc: `Faucets, toilets, garbage disposals, sump pumps — installed correctly, tested, and warranted.` },
      ],
      aboutText: `${name} was built on the idea that plumbing shouldn't be a mystery. We explain the problem, tell you the options, and give you an honest price before any work begins.\n\nEvery plumber on our team is licensed, background-checked, and trained to treat your home like their own. ${years} years in business means we've seen it all.`,
      testimonials: [
        { text: `Basement flooding on a Sunday night. They were at our door in 40 minutes. Fixed the issue, cleaned up, even left boot covers at the door. That's how you earn a customer for life.`, author: 'Jennifer K.', role: `Homeowner, ${loc}` },
        { text: `Got three quotes for repiping. ${name} wasn't the cheapest, but they were the only ones who actually explained what they were doing and why. Worth every penny.`, author: 'Robert M.', role: `Homeowner, ${loc}` },
        { text: `We use them for all six of our rental properties. Reliable, communicative, and they always text before showing up. Exactly what a landlord needs.`, author: 'Lisa P.', role: `Property Manager` },
      ],
    },
    'hvac': {
      heroHeadline: `Comfortable home. Controlled costs. No excuses.`,
      heroSub: `${name} keeps ${loc} homes at the right temperature year-round. ${years} years of installs, repairs, and maintenance — done right, priced fairly.`,
      services: [
        { name: 'AC Repair & Service', desc: `Fast diagnosis and repair for all makes and models. Most repairs completed same-day.` },
        { name: 'Furnace & Heating', desc: `Tune-ups, repairs, and full system replacements. We work with gas, electric, and heat pump systems.` },
        { name: 'New System Installation', desc: `Right-sized equipment, proper ductwork, and manufacturer rebates. Financing available.` },
        { name: 'Preventive Maintenance', desc: `Bi-annual tune-ups that extend equipment life, improve efficiency, and catch problems early.` },
        { name: 'Duct Cleaning & Sealing', desc: `Improve airflow, reduce dust, and lower energy bills. We seal leaks and clean buildup.` },
        { name: 'Indoor Air Quality', desc: `Air purifiers, humidifiers, UV filtration — solutions for allergies, odors, and healthier breathing.` },
      ],
      aboutText: `${name} has been keeping ${loc} comfortable since day one. We don't push equipment you don't need. We diagnose the problem, explain your options in plain English, and fix it.\n\nOur technicians are NATE-certified, drug-tested, and arrive in marked vehicles with full uniforms. ${years} years of doing this right.`,
      testimonials: [
        { text: `AC died in July. They had a new system in by the next morning. The tech even showed me how to use the smart thermostat before he left.`, author: 'Tom A.', role: `Homeowner, ${loc}` },
        { text: `Been on their maintenance plan for three years. Haven't had a single breakdown. The annual tune-up alone has paid for itself.`, author: 'Nancy W.', role: `Homeowner, ${loc}` },
        { text: `Replaced the entire HVAC system in our restaurant without closing us for a single day. Incredible coordination.`, author: 'Carlos M.', role: `Restaurant Owner` },
      ],
    },
    'electrical': {
      heroHeadline: `Safe wiring. Smart upgrades. No shortcuts.`,
      heroSub: `${name} delivers licensed, code-compliant electrical work across ${loc}. ${years} years of experience means fewer callbacks and more peace of mind.`,
      services: [
        { name: 'Panel Upgrades', desc: `Upgrade from outdated 100-amp to 200-amp service. Support modern appliances, EV chargers, and more.` },
        { name: 'Wiring & Rewiring', desc: `Knob-and-tube replacement, whole-house rewiring, and new construction wiring. Done to code, every time.` },
        { name: 'Lighting Design', desc: `Recessed lighting, under-cabinet, landscape lighting — designed to look great and function perfectly.` },
        { name: 'Generator Installation', desc: `Whole-home standby generators with automatic transfer switches. Never lose power again.` },
        { name: 'EV Charger Installation', desc: `Level 2 charger installation for Tesla, Ford, Rivian, and all EV models. Proper permitting included.` },
        { name: 'Troubleshooting', desc: `Flickering lights, tripped breakers, dead outlets — we find the fault and fix it safely.` },
      ],
      aboutText: `${name} was founded on one principle: electrical work is either done safely or it's done wrong. There's no middle ground.\n\nEvery electrician on our team is a licensed journeyman or master electrician. We pull permits, schedule inspections, and guarantee our work for ${years}+ years.`,
      testimonials: [
        { text: `They rewired our 1960s home without destroying our plaster walls. The crew was meticulous about patching and cleanup. Couldn't even tell they were there.`, author: 'Amanda R.', role: `Homeowner, ${loc}` },
        { text: `Installed a Tesla charger and upgraded our panel on the same visit. One permit, one inspection, done. Exactly what I wanted.`, author: 'Brian K.', role: `Homeowner, ${loc}` },
        { text: `We've used ${name} for three commercial buildouts. Their work passes inspection the first time, every time.`, author: 'Mark S.', role: `General Contractor` },
      ],
    },
  };

  // Generic fallback for niches not explicitly mapped
  const generic = {
    heroHeadline: `The kind of ${niche || 'service'} you'll actually recommend to friends.`,
    heroSub: `${name} has served ${loc} for ${years} years. We built our reputation one job at a time — showing up on time, doing honest work, and standing behind every project.`,
    services: [
      { name: 'Core Service', desc: `Our primary offering, delivered with the quality and attention to detail that built our reputation.` },
      { name: 'Consultation', desc: `Free on-site consultation to assess your needs, answer questions, and provide an honest estimate.` },
      { name: 'Emergency Work', desc: `When things can't wait, neither do we. Rapid response for urgent situations.` },
      { name: 'Maintenance', desc: `Preventive maintenance keeps small issues from becoming big problems. Save money long-term.` },
      { name: 'Custom Solutions', desc: `Every project is different. We tailor our approach to fit your specific situation and budget.` },
      { name: 'Full Support', desc: `From start to finish — planning, execution, cleanup, and follow-up. Complete peace of mind.` },
    ],
    aboutText: `${name} was built on a simple idea: do great work, charge a fair price, and treat every customer the way you'd want to be treated.\n\nWe've been serving ${loc} for ${years} years, and our best marketing is still word of mouth from happy customers.`,
    testimonials: [
      { text: `Professional from start to finish. They showed up on time, did exactly what they said they would, and the price matched the quote. That shouldn't be rare, but it is.`, author: 'Sarah M.', role: `Customer, ${loc}` },
      { text: `We've used ${name} twice now. Both times they went above and beyond. These are the kind of people you want working on your home.`, author: 'David R.', role: `Homeowner` },
      { text: `Honest, reliable, skilled. No gimmicks, no pressure, just solid work. Highly recommended.`, author: 'Karen L.', role: `Customer, ${loc}` },
    ],
  };

  return base[niche] || generic;
}

// ── Enhance user-provided services ────────────────────────────

function enhanceServices(rawServices, nicheContent) {
  if (!rawServices) return nicheContent.services;

  const userServices = rawServices.split(',').map(s => s.trim()).filter(Boolean);

  // If user only provided a few services, pad with niche defaults
  const result = userServices.map(name => {
    // Check if niche content has a matching service for a better description
    const match = nicheContent.services.find(ns =>
      ns.name.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(ns.name.toLowerCase().split(' ')[0].toLowerCase())
    );
    return {
      name: capitalizeWords(name),
      desc: match
        ? match.desc
        : `Expert ${name.toLowerCase()} service delivered with precision and backed by our quality guarantee.`,
    };
  });

  // Pad to at least 4 services
  let i = 0;
  while (result.length < 4 && i < nicheContent.services.length) {
    const fallback = nicheContent.services[i];
    if (!result.find(r => r.name.toLowerCase() === fallback.name.toLowerCase())) {
      result.push(fallback);
    }
    i++;
  }

  return result.slice(0, 6);
}

function capitalizeWords(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ── Theme color palettes ──────────────────────────────────────

function getTheme(style) {
  const themes = {
    'modern-clean': {
      bg: '#fafaf8', bgAlt: '#f2f1ed', nav: '#ffffff', accent: '#1a6b44', accentHover: '#15573a',
      accentBg: 'rgba(26,107,68,0.06)', accentBgSolid: '#eef5f0', trust: '#1a3a2a', text: '#1a2e22', textSec: '#5a6b60',
      muted: '#8a9b90', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #f0f7f3 0%, #fafaf8 50%, #f7f5f0 100%)',
      font: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'Inter:wght@400;500;600;700',
    },
    'bold-dark': {
      bg: '#0e0c0a', bgAlt: '#161412', nav: '#121010', accent: '#c8956a', accentHover: '#d4a57a',
      accentBg: 'rgba(200,149,106,0.08)', accentBgSolid: '#1e1a15', trust: '#1a1614', text: '#e8ddd3', textSec: '#a89f94',
      muted: '#6d6560', card: '#1a1815', border: 'rgba(255,255,255,0.06)', heroGrad: 'linear-gradient(135deg, #1a1410 0%, #0e0c0a 50%, #12100e 100%)',
      font: "'DM Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'DM+Sans:wght@400;500;600;700',
    },
    'warm-friendly': {
      bg: '#faf6f1', bgAlt: '#f3ece3', nav: '#ffffff', accent: '#c66b2e', accentHover: '#b55e24',
      accentBg: 'rgba(198,107,46,0.07)', accentBgSolid: '#fdf3e8', trust: '#3b2a18', text: '#2e2218', textSec: '#7a6a56',
      muted: '#a09080', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #fdf3e8 0%, #faf6f1 50%, #f8f0e6 100%)',
      font: "'Nunito Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'Nunito+Sans:wght@400;500;600;700',
    },
    'professional': {
      bg: '#f5f6f8', bgAlt: '#eef0f4', nav: '#ffffff', accent: '#2955a3', accentHover: '#1e4590',
      accentBg: 'rgba(41,85,163,0.06)', accentBgSolid: '#eef2fa', trust: '#1a2a4a', text: '#1a2030', textSec: '#5a6578',
      muted: '#8a90a0', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #eef2fa 0%, #f5f6f8 50%, #f0f2f8 100%)',
      font: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'Inter:wght@400;500;600;700',
    },
    'rustic': {
      bg: '#f4f0e8', bgAlt: '#ebe5da', nav: '#ffffff', accent: '#7a6040', accentHover: '#6a5035',
      accentBg: 'rgba(122,96,64,0.07)', accentBgSolid: '#f0ebe0', trust: '#3a3020', text: '#2e2418', textSec: '#706050',
      muted: '#9a8a78', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #f0ebe0 0%, #f4f0e8 50%, #ede8dd 100%)',
      font: "'Lora', Georgia, 'Times New Roman', serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'Lora:wght@400;500;600;700',
    },
    'surprise': {
      bg: '#faf8ff', bgAlt: '#f2f0fa', nav: '#ffffff', accent: '#7c3aed', accentHover: '#6d28d9',
      accentBg: 'rgba(124,58,237,0.06)', accentBgSolid: '#f0ecff', trust: '#2a1a4a', text: '#1e1b2e', textSec: '#6b6580',
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
  const nc = getNicheContent(biz.niche, biz);
  const services = enhanceServices(biz.services, nc);
  const name = esc(biz.name);
  const phone = esc(biz.phone || '(555) 123-4567');
  const phoneHref = (biz.phone || '5551234567').replace(/[^0-9+]/g, '');
  const loc = esc(biz.location || 'Your Area');
  const years = esc(biz.years || '10+');
  const contactEmail = esc(biz.email || '');
  const year = new Date().getFullYear();
  const isDark = biz.style === 'bold-dark';
  const heroHeadline = esc(nc.heroHeadline);
  const heroSub = esc(nc.heroSub);
  const aboutText = esc(nc.aboutText).replace(/\\n/g, '<br><br>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name} — ${esc(biz.niche || 'Professional Services')} in ${loc}</title>
<meta name="description" content="${esc(nc.heroSub).substring(0, 155)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${t.gFont}&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:${t.bg};--bg-alt:${t.bgAlt};--nav:${t.nav};--accent:${t.accent};--accent-hover:${t.accentHover};--accent-bg:${t.accentBg};--accent-bg-solid:${t.accentBgSolid};--trust:${t.trust};--text:${t.text};--text-sec:${t.textSec};--muted:${t.muted};--card:${t.card};--border:${t.border};--font:${t.font};--font-head:${t.fontHead};--r:8px;--rl:14px}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.65;overflow-x:hidden}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
.wrap{max-width:1100px;margin:0 auto;padding:0 24px}

/* Nav */
.nav{position:sticky;top:0;z-index:100;background:var(--nav);border-bottom:1px solid var(--border);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.nav-inner{max-width:1100px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;height:64px}
.logo{font-family:var(--font-head);font-size:20px;font-weight:400;color:var(--text);letter-spacing:-.02em}
.logo span{color:var(--accent)}
.nav-links{display:flex;align-items:center;gap:28px;font-size:14px;color:var(--text-sec)}
.nav-links a{transition:color .2s}
.nav-links a:hover{color:var(--text)}
.nav-cta{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#fff;padding:9px 20px;border-radius:var(--r);font-weight:600;font-size:13px;transition:all .2s}
.nav-cta:hover{background:var(--accent-hover);color:#fff;transform:translateY(-1px)}
.nav-toggle{display:none;background:none;border:none;cursor:pointer;padding:6px}
.nav-toggle span{display:block;width:20px;height:2px;background:var(--text);margin:4px 0;transition:all .2s}

/* Hero */
.hero{padding:80px 24px 64px;background:${t.heroGrad};position:relative;overflow:hidden}
.hero::after{content:'';position:absolute;top:-30%;right:-15%;width:500px;height:500px;border-radius:50%;background:var(--accent-bg);filter:blur(80px);pointer-events:none;opacity:.7}
.hero-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1.15fr .85fr;gap:48px;align-items:center;position:relative;z-index:1}
.hero-tag{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);margin-bottom:16px;padding:6px 14px;background:var(--accent-bg-solid);border-radius:100px;border:1px solid var(--accent-bg)}
.hero h1{font-family:var(--font-head);font-size:clamp(28px,4.5vw,46px);font-weight:400;line-height:1.12;letter-spacing:-.02em;margin-bottom:20px;color:var(--text)}
.hero-sub{font-size:16px;color:var(--text-sec);line-height:1.75;margin-bottom:32px;max-width:500px}
.hero-btns{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:36px}
.btn-p{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#fff;padding:14px 28px;border-radius:var(--r);font-weight:600;font-size:15px;transition:all .25s;border:none;cursor:pointer}
.btn-p:hover{background:var(--accent-hover);transform:translateY(-2px);box-shadow:0 8px 24px ${isDark ? 'rgba(200,149,106,.2)' : 'rgba(0,0,0,.12)'}}
.btn-o{display:inline-flex;align-items:center;gap:8px;background:transparent;color:var(--text-sec);padding:14px 28px;border-radius:var(--r);font-weight:500;font-size:15px;border:1px solid var(--border);transition:all .25s;cursor:pointer}
.btn-o:hover{border-color:var(--accent);color:var(--accent)}
.hero-proof{display:flex;align-items:center;gap:14px}
.hero-stars{color:#f5b731;font-size:15px;letter-spacing:2px}
.hero-proof-text{font-size:13px;color:var(--text-sec)}
.hero-proof-text strong{color:var(--text)}

/* Hero card */
.hero-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:32px;box-shadow:0 24px 64px ${isDark ? 'rgba(0,0,0,.4)' : 'rgba(0,0,0,.08)'};position:relative}
.hero-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--accent),var(--accent-hover),var(--accent));border-radius:var(--rl) var(--rl) 0 0}
.hero-card-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);margin-bottom:20px}
.hero-card-stat{font-family:var(--font-head);font-size:52px;color:var(--text);line-height:1;margin-bottom:4px}
.hero-card-desc{font-size:14px;color:var(--text-sec);margin-bottom:24px}
.hero-card-row{display:flex;gap:12px}
.hero-card-mini{flex:1;text-align:center;padding:14px 8px;background:var(--accent-bg-solid);border-radius:var(--r);border:1px solid var(--accent-bg)}
.hero-card-mini strong{display:block;font-family:var(--font-head);font-size:22px;color:var(--accent)}
.hero-card-mini span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}

/* Trust */
.trust{background:var(--trust);padding:24px}
.trust-inner{max-width:1100px;margin:0 auto;display:flex;justify-content:center;gap:48px;flex-wrap:wrap}
.trust-item{display:flex;flex-direction:column;align-items:center;gap:2px}
.trust-num{font-family:var(--font-head);font-size:24px;color:#fff;font-weight:400}
.trust-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.45)}

/* Services */
.services{padding:80px 24px}
.sec-tag{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);margin-bottom:8px}
.sec-title{font-family:var(--font-head);font-size:clamp(22px,3.5vw,34px);font-weight:400;margin-bottom:12px;color:var(--text)}
.sec-desc{font-size:15px;color:var(--text-sec);line-height:1.7;margin-bottom:40px;max-width:540px}
.services-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.svc-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:28px;transition:all .3s}
.svc-card:hover{border-color:var(--accent);transform:translateY(-3px);box-shadow:0 12px 32px ${isDark ? 'rgba(0,0,0,.25)' : 'rgba(0,0,0,.06)'}}
.svc-icon{width:44px;height:44px;border-radius:var(--r);background:var(--accent-bg-solid);display:flex;align-items:center;justify-content:center;margin-bottom:16px;color:var(--accent);border:1px solid var(--accent-bg)}
.svc-card h3{font-size:16px;font-weight:600;margin-bottom:8px}
.svc-card p{font-size:13px;color:var(--text-sec);line-height:1.65}

/* About */
.about{padding:80px 24px;background:var(--bg-alt)}
.about-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:center}
.about-img{width:100%;aspect-ratio:4/3;background:var(--accent-bg-solid);border-radius:var(--rl);display:flex;align-items:center;justify-content:center;border:1px solid var(--accent-bg)}
.about-img svg{width:80px;height:80px;color:var(--accent);opacity:.25}
.about-text h2{font-family:var(--font-head);font-size:28px;font-weight:400;margin-bottom:20px}
.about-text p{font-size:15px;color:var(--text-sec);line-height:1.8;margin-bottom:16px}
.about-stats{display:flex;gap:32px;margin-top:28px;padding-top:24px;border-top:1px solid var(--border)}
.about-stat{text-align:center}
.about-stat strong{display:block;font-family:var(--font-head);font-size:32px;color:var(--accent)}
.about-stat span{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}

/* Testimonials */
.reviews{padding:80px 24px}
.reviews-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.review-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:28px;display:flex;flex-direction:column}
.review-stars{color:#f5b731;font-size:14px;letter-spacing:2px;margin-bottom:16px}
.review-card blockquote{font-size:14px;color:var(--text-sec);line-height:1.7;margin-bottom:auto;padding-bottom:20px;flex:1}
.review-card cite{font-style:normal;font-size:13px;font-weight:600;color:var(--text);display:block;padding-top:16px;border-top:1px solid var(--border)}
.review-card cite span{font-weight:400;color:var(--muted);font-size:12px;display:block;margin-top:2px}

/* CTA */
.cta{padding:80px 24px;background:var(--bg-alt);text-align:center}
.cta-inner{max-width:600px;margin:0 auto}
.cta h2{font-family:var(--font-head);font-size:clamp(22px,3.5vw,34px);font-weight:400;margin-bottom:16px}
.cta p{font-size:15px;color:var(--text-sec);line-height:1.7;margin-bottom:28px}
.cta-btns{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}

/* Footer */
footer{padding:48px 24px 32px;border-top:1px solid var(--border);background:var(--bg)}
.footer-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:40px}
.footer-brand .logo{margin-bottom:12px;display:inline-block}
.footer-brand p{font-size:13px;color:var(--muted);line-height:1.6;max-width:240px}
.footer-col h4{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:12px}
.footer-col ul{list-style:none}
.footer-col li{margin-bottom:6px}
.footer-col a{font-size:13px;color:var(--text-sec);transition:color .2s}
.footer-col a:hover{color:var(--accent)}
.footer-bottom{max-width:1100px;margin:32px auto 0;padding-top:24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}
.footer-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--accent);background:var(--accent-bg-solid);padding:4px 10px;border-radius:4px;font-weight:600;border:1px solid var(--accent-bg)}

@media(max-width:900px){
.hero-inner{grid-template-columns:1fr;gap:32px}
.hero-card{display:none}
.services-grid,.reviews-grid{grid-template-columns:1fr 1fr}
.about-inner{grid-template-columns:1fr}
.about-img{display:none}
.footer-inner{grid-template-columns:1fr 1fr;gap:24px}
.footer-brand{grid-column:1/-1}
}
@media(max-width:600px){
.services-grid,.reviews-grid{grid-template-columns:1fr}
.trust-inner{gap:24px}
.nav-links{display:none}
.nav-toggle{display:block}
.hero{padding:60px 20px 40px}
.footer-inner{grid-template-columns:1fr}
.footer-bottom{flex-direction:column;gap:8px;text-align:center}
}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
.fu{animation:fadeUp .6s ease both}
.fu1{animation-delay:.1s}
.fu2{animation-delay:.2s}
.fu3{animation-delay:.3s}
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-inner">
    <a href="#" class="logo">${name}<span>.</span></a>
    <div class="nav-links">
      <a href="#services">Services</a>
      <a href="#about">About</a>
      <a href="#reviews">Reviews</a>
      <a href="tel:${phoneHref}" class="nav-cta">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        ${phone}
      </a>
    </div>
    <button class="nav-toggle" onclick="this.classList.toggle('open')"><span></span><span></span><span></span></button>
  </div>
</nav>

<section class="hero">
  <div class="hero-inner">
    <div class="fu">
      <div class="hero-tag">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Licensed &amp; Insured \u2022 ${loc}
      </div>
      <h1>${heroHeadline}</h1>
      <p class="hero-sub">${heroSub}</p>
      <div class="hero-btns">
        <a href="tel:${phoneHref}" class="btn-p">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          Get Your Free Quote
        </a>
        <a href="#services" class="btn-o">See Our Work</a>
      </div>
      <div class="hero-proof">
        <span class="hero-stars">\u2605\u2605\u2605\u2605\u2605</span>
        <span class="hero-proof-text"><strong>4.9/5</strong> from 200+ reviews in ${loc}</span>
      </div>
    </div>
    <div class="fu fu1">
      <div class="hero-card">
        <div class="hero-card-label">Why ${name}?</div>
        <div class="hero-card-stat">${years}</div>
        <div class="hero-card-desc">Years serving ${loc}</div>
        <div class="hero-card-row">
          <div class="hero-card-mini"><strong>4.9</strong><span>Rating</span></div>
          <div class="hero-card-mini"><strong>500+</strong><span>Projects</span></div>
          <div class="hero-card-mini"><strong>100%</strong><span>Licensed</span></div>
        </div>
      </div>
    </div>
  </div>
</section>

<div class="trust">
  <div class="trust-inner">
    <div class="trust-item"><div class="trust-num">${years}</div><div class="trust-label">Years Experience</div></div>
    <div class="trust-item"><div class="trust-num">4.9</div><div class="trust-label">Star Rating</div></div>
    <div class="trust-item"><div class="trust-num">500+</div><div class="trust-label">Projects Done</div></div>
    <div class="trust-item"><div class="trust-num">A+</div><div class="trust-label">BBB Rated</div></div>
    <div class="trust-item"><div class="trust-num">100%</div><div class="trust-label">Licensed &amp; Insured</div></div>
  </div>
</div>

<section class="services" id="services">
  <div class="wrap">
    <div class="sec-tag">What We Do</div>
    <div class="sec-title">Services</div>
    <div class="sec-desc">Every project gets our full attention. Here's how we help homeowners and businesses in ${loc}.</div>
    <div class="services-grid">
${services.map((s, i) => `      <div class="svc-card fu fu${Math.min(i, 3)}">
        <div class="svc-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.desc)}</p>
      </div>`).join('\n')}
    </div>
  </div>
</section>

<section class="about" id="about">
  <div class="about-inner wrap">
    <div class="about-img">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    </div>
    <div class="about-text">
      <div class="sec-tag">About ${name}</div>
      <h2>Real people. Real work. Real results.</h2>
      <p>${aboutText}</p>
      <div class="about-stats">
        <div class="about-stat"><strong>${years}</strong><span>Years</span></div>
        <div class="about-stat"><strong>500+</strong><span>Projects</span></div>
        <div class="about-stat"><strong>4.9</strong><span>Rating</span></div>
      </div>
    </div>
  </div>
</section>

<section class="reviews" id="reviews">
  <div class="wrap">
    <div class="sec-tag">Reviews</div>
    <div class="sec-title">What our customers say</div>
    <div class="sec-desc">Real feedback from real people we've worked with.</div>
    <div class="reviews-grid">
${nc.testimonials.map((t, i) => `      <div class="review-card fu fu${i}">
        <div class="review-stars">\u2605\u2605\u2605\u2605\u2605</div>
        <blockquote>${esc(t.text)}</blockquote>
        <cite>${esc(t.author)}<span>${esc(t.role)}</span></cite>
      </div>`).join('\n')}
    </div>
  </div>
</section>

<section class="cta">
  <div class="cta-inner">
    <div class="sec-tag">Ready?</div>
    <h2>Let's talk about your project.</h2>
    <p>No pressure, no obligation. Call us or send an email and we'll get back to you within 24 hours with a free estimate.</p>
    <div class="cta-btns">
      <a href="tel:${phoneHref}" class="btn-p">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        Call ${phone}
      </a>
      ${contactEmail ? `<a href="mailto:${contactEmail}" class="btn-o">Email Us</a>` : ''}
    </div>
  </div>
</section>

<footer>
  <div class="footer-inner">
    <div class="footer-brand">
      <a href="#" class="logo">${name}<span>.</span></a>
      <p>Serving ${loc} ${biz.years ? `for ${years} years` : 'and surrounding areas'}. Licensed, insured, and committed to quality.</p>
    </div>
    <div class="footer-col">
      <h4>Services</h4>
      <ul>
${services.slice(0, 4).map(s => `        <li><a href="#services">${esc(s.name)}</a></li>`).join('\n')}
      </ul>
    </div>
    <div class="footer-col">
      <h4>Company</h4>
      <ul>
        <li><a href="#about">About</a></li>
        <li><a href="#reviews">Reviews</a></li>
        <li><a href="#services">Services</a></li>
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

</body>
</html>`;
}
