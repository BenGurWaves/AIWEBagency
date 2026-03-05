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
    customAccent: body.custom_accent || null,
    customPalette: body.custom_palette || null,
  };

  // ── 3b. Scrape inspiration URLs for layout/color cues ────
  let inspoHints = {};
  if (biz.inspo) {
    const urls = biz.inspo.split(/[\s,]+/).filter(u => u.startsWith('http'));
    for (const url of urls.slice(0, 75)) {
      try {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelocityBot/1.0)' },
          redirect: 'follow',
          signal: AbortSignal.timeout(5000),
        });
        const html = await resp.text();
        const extracted = extractInspoHints(html);
        if (extracted.accentColor && !inspoHints.accentColor) inspoHints.accentColor = extracted.accentColor;
        if (extracted.palette && !inspoHints.palette) inspoHints.palette = extracted.palette;
        if (extracted.isDark !== undefined && inspoHints.isDark === undefined) inspoHints.isDark = extracted.isDark;
        if (extracted.hasHeroVideo) inspoHints.hasHeroVideo = true;
        if (extracted.layoutHint) inspoHints.layoutHint = extracted.layoutHint;
        if (extracted.fonts && !inspoHints.fonts) inspoHints.fonts = extracted.fonts;
        if (extracted.borderRadius && !inspoHints.borderRadius) inspoHints.borderRadius = extracted.borderRadius;
        if (extracted.spacing && !inspoHints.spacing) inspoHints.spacing = extracted.spacing;
        if (extracted.layoutAlign && !inspoHints.layoutAlign) inspoHints.layoutAlign = extracted.layoutAlign;
      } catch { /* inspo scrape failed — skip */ }
    }
    // Apply inspo hints to biz if no user preference overrides
    if (inspoHints.accentColor && !biz.customAccent) biz.customAccent = inspoHints.accentColor;
    if (inspoHints.palette && !biz.customPalette) biz.inspoPalette = inspoHints.palette;
    if (inspoHints.isDark && biz.style === 'modern-clean') biz.style = 'bold-dark';
    if (inspoHints.fonts) biz.inspoFonts = inspoHints.fonts;
    if (inspoHints.borderRadius) biz.inspoBorderRadius = inspoHints.borderRadius;
    if (inspoHints.spacing) biz.inspoSpacing = inspoHints.spacing;
  }

  // ── 3c. Parse notes more carefully (USER INSTRUCTIONS = TOP PRIORITY) ──
  if (biz.notes) {
    const notes = biz.notes.toLowerCase();
    // Detect site type from notes
    if (/portfolio|showcase|gallery|my work/i.test(notes) && biz.siteType === 'service-business') {
      biz.siteType = 'portfolio';
    }
    if (/booking|appointment|schedule/i.test(notes) && biz.siteType === 'service-business') {
      biz.siteType = 'booking';
    }
    // Dark mode from notes
    if (/dark\s*mode|dark\s*theme|dark\s*background|black\s*background/i.test(notes)) {
      biz.style = 'bold-dark';
    }
    // Detect color requests from notes
    if (!biz.customAccent) {
      const colorMatch = notes.match(/#[0-9a-f]{3,6}\b/i);
      if (colorMatch) biz.customAccent = colorMatch[0];
    }
    // Named color requests from notes
    if (!biz.customAccent) {
      const namedColors = {
        'magenta': '#e91e8c', 'pink': '#e91e8c', 'hot pink': '#ff69b4', 'fuchsia': '#ff00ff',
        'gold': '#d4a017', 'yellow': '#e6b800', 'lime': '#32cd32', 'cyan': '#00bcd4',
        'coral': '#ff6f61', 'salmon': '#fa8072', 'lavender': '#9b59b6', 'indigo': '#4b0082',
        'mint': '#3eb489', 'peach': '#ffab91', 'turquoise': '#00bfa5', 'maroon': '#800000',
        'red': '#dc3545', 'blue': '#2563eb', 'green': '#16a34a', 'purple': '#7c3aed',
        'orange': '#ea580c', 'teal': '#0d9488', 'navy': '#1e3a5f',
      };
      for (const [name, hex] of Object.entries(namedColors)) {
        if (notes.includes(name)) { biz.customAccent = hex; break; }
      }
    }
  }

  // ── 4. Generate preview HTML ──────────────────────────────
  const previewHtml = generatePreview(biz);

  // ── 5. Store in KV ────────────────────────────────────────
  await kv.put(`preview:${previewId}`, previewHtml, { expirationTtl: 86400 * 90 });

  // Also update redesign record
  try {
    const existing = (await kv.get('redesign:' + email, { type: 'json' })) ?? {};
    Object.assign(existing, body, {
      preview_id: previewId,
      preview_url: `/preview/${previewId}`,
      preview_generated_at: new Date().toISOString(),
    });
    await kv.put('redesign:' + email, JSON.stringify(existing), { expirationTtl: 86400 * 90 });
  } catch { /* non-critical */ }

  // ── Create dashboard project record so preview appears in user's dashboard ──
  const projectId = previewId;
  try {
    const project = {
      id: projectId,
      user_email: email,
      website_url: websiteUrl || '',
      status: 'preview_ready',
      progress: 100,
      created_at: new Date().toISOString(),
      preview_url: `/preview/${projectId}`,
      preview_ready_at: new Date().toISOString(),
      business_info: {
        name: biz.name || '',
        phone: biz.phone || '',
        email: biz.email || email,
        address: biz.location || '',
        domain: biz.domain || '',
        niche: biz.niche || '',
      },
    };
    await kv.put(`project:${projectId}`, JSON.stringify(project), { expirationTtl: 86400 * 365 });

    // Add to user's project list (newest first, no duplicates)
    const list = (await kv.get(`user_projects:${email}`, { type: 'json' })) || [];
    if (!list.includes(projectId)) {
      list.unshift(projectId);
      await kv.put(`user_projects:${email}`, JSON.stringify(list), { expirationTtl: 86400 * 365 });
    }
  } catch { /* non-critical */ }

  return json({
    success: true,
    preview_id: previewId,
    preview_url: `/preview/${previewId}`,
    project_id: projectId,
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

  const result = userServices.map(name => {
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
    'ocean': {
      bg: '#f4fafa', bgAlt: '#e8f4f4', nav: '#ffffff', accent: '#0e7c7b', accentHover: '#0a6665',
      accentBg: 'rgba(14,124,123,0.06)', accentBgSolid: '#e4f3f3', trust: '#0a3030', text: '#122828', textSec: '#4a6868',
      muted: '#7a9a9a', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #e4f3f3 0%, #f4fafa 50%, #eef6f6 100%)',
      font: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'Inter:wght@400;500;600;700',
    },
    'ember': {
      bg: '#fdf6f4', bgAlt: '#f8ece8', nav: '#ffffff', accent: '#b03a2e', accentHover: '#922f25',
      accentBg: 'rgba(176,58,46,0.06)', accentBgSolid: '#f8e8e5', trust: '#3a1510', text: '#2e1a16', textSec: '#7a5a52',
      muted: '#a08880', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #f8e8e5 0%, #fdf6f4 50%, #faf0ed 100%)',
      font: "'DM Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
      fontHead: "'Georgia', 'Times New Roman', serif",
      gFont: 'DM+Sans:wght@400;500;600;700',
    },
  };
  return themes[style] || themes['modern-clean'];
}

function applyCustomAccent(theme, customAccent) {
  if (!customAccent) return theme;
  // Derive hover (slightly darker) and bg variants from custom accent
  const t = { ...theme };
  t.accent = customAccent;
  t.accentHover = customAccent;
  t.accentBg = customAccent.replace(/^#/, 'rgba(') ? `${customAccent}11` : t.accentBg;
  // Simple hex to rgba for background
  const hex = customAccent.replace('#', '');
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0,2), 16);
    const g = parseInt(hex.slice(2,4), 16);
    const b = parseInt(hex.slice(4,6), 16);
    t.accentBg = `rgba(${r},${g},${b},0.07)`;
    t.accentBgSolid = `rgba(${r},${g},${b},0.1)`;
    // Darker hover
    t.accentHover = '#' + [r,g,b].map(c => Math.max(0, c - 20).toString(16).padStart(2,'0')).join('');
  }
  return t;
}

function applyCustomPalette(theme, palette) {
  if (!palette || !Array.isArray(palette) || palette.length < 2) return theme;
  const t = { ...theme };
  t.accent = palette[0];
  const hex = palette[0].replace('#', '');
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0,2), 16), g = parseInt(hex.slice(2,4), 16), b = parseInt(hex.slice(4,6), 16);
    t.accentBg = `rgba(${r},${g},${b},0.07)`;
    t.accentBgSolid = `rgba(${r},${g},${b},0.1)`;
    t.accentHover = '#' + [r,g,b].map(c => Math.max(0, c - 20).toString(16).padStart(2,'0')).join('');
  }
  if (palette[1]) {
    const h2 = palette[1].replace('#','');
    if (h2.length === 6) {
      const r2 = parseInt(h2.slice(0,2),16), g2 = parseInt(h2.slice(2,4),16), b2 = parseInt(h2.slice(4,6),16);
      const brightness = (r2 * 299 + g2 * 587 + b2 * 114) / 1000;
      if (brightness > 200) { t.bg = palette[1]; t.bgAlt = palette[1]; t.nav = palette[1]; t.card = '#ffffff'; }
    }
  }
  if (palette[2]) {
    const h3 = palette[2].replace('#','');
    if (h3.length === 6) {
      const r3 = parseInt(h3.slice(0,2),16), g3 = parseInt(h3.slice(2,4),16), b3 = parseInt(h3.slice(4,6),16);
      const brightness = (r3 * 299 + g3 * 587 + b3 * 114) / 1000;
      if (brightness < 80) { t.trust = palette[2]; t.text = palette[2]; }
    }
  }
  return t;
}

function parseNotesForFont(notes) {
  if (!notes) return null;
  const lower = notes.toLowerCase();
  const fontPatterns = [
    { pattern: /\b(montserrat|poppins|inter|roboto|lato|open\s*sans|nunito|raleway|playfair|merriweather|oswald|libre\s*baskerville|space\s*grotesk|dm\s*sans|cormorant|jost|sora|work\s*sans|barlow|manrope|outfit|plus\s*jakarta|figtree|geist|archivo)\b/i, extract: true },
    { pattern: /\bserif\b/, font: "'Georgia','Times New Roman',serif", fontHead: "'Playfair Display',Georgia,serif", gFont: 'Playfair+Display:ital,wght@0,400;0,600;0,700;1,400' },
    { pattern: /\bmonospace|mono|code\b/, font: "'JetBrains Mono',monospace", fontHead: "'JetBrains Mono',monospace", gFont: 'JetBrains+Mono:wght@400;500;600;700' },
    { pattern: /\belegant|luxury|classy\b/, fontHead: "'Cormorant Garamond',Georgia,serif", gFont: 'Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400' },
    { pattern: /\bbold|strong|heavy|impactful\b/, fontHead: "'Sora',sans-serif", gFont: 'Sora:wght@400;500;600;700;800' },
    { pattern: /\bminimal|clean|simple\b/, font: "'Inter',sans-serif", fontHead: "'Inter',sans-serif", gFont: 'Inter:wght@300;400;500;600;700' },
  ];
  for (const p of fontPatterns) {
    const match = lower.match(p.pattern);
    if (match) {
      if (p.extract) {
        const fontName = match[1].replace(/\b\w/g, c => c.toUpperCase()).replace(/\s+/g, ' ');
        const gName = fontName.replace(/\s/g, '+');
        return { font: `'${fontName}',sans-serif`, fontHead: `'${fontName}',sans-serif`, gFont: `${gName}:wght@300;400;500;600;700` };
      }
      return { font: p.font, fontHead: p.fontHead, gFont: p.gFont };
    }
  }
  return null;
}

// ── Inspiration URL analysis ─────────────────────────────────

function extractInspoHints(html) {
  const hints = {};

  // Extract ALL meaningful colors from CSS (not just one)
  const colorMatches = html.match(/(?:background-color|background|color|border-color|border)\s*:\s*(#[0-9a-fA-F]{3,8})/gi) || [];
  const colorCounts = {};
  const skipColors = new Set(['#fff','#ffffff','#000','#000000','#ccc','#cccccc','#ddd','#dddddd','#eee','#eeeeee','#f5f5f5','#333','#333333','#666','#666666','#999','#999999','#aaa','#aaaaaa','#bbb','#e5e5e5','#f0f0f0','#fafafa','#f8f8f8','#e0e0e0','#d0d0d0','#c0c0c0','#808080','#transparent']);
  colorMatches.forEach(m => {
    let c = (m.match(/#[0-9a-fA-F]{3,8}/) || [''])[0].toLowerCase();
    if (!c || c.length < 4) return;
    // Normalize 3-char hex to 6-char
    if (c.length === 4) c = '#' + c[1]+c[1] + c[2]+c[2] + c[3]+c[3];
    if (c.length > 7) c = c.slice(0, 7); // strip alpha
    if (skipColors.has(c)) return;
    colorCounts[c] = (colorCounts[c] || 0) + 1;
  });
  const sortedColors = Object.entries(colorCounts).sort((a, b) => b[1] - a[1]);
  if (sortedColors.length > 0) {
    hints.accentColor = sortedColors[0][0];
    hints.palette = sortedColors.slice(0, 5).map(e => e[0]);
  }

  // Extract font families
  const fontMatches = html.match(/font-family\s*:\s*([^;}]+)/gi) || [];
  const fontCounts = {};
  fontMatches.forEach(m => {
    const fam = m.replace(/font-family\s*:\s*/i, '').replace(/['"]/g, '').split(',')[0].trim().toLowerCase();
    if (fam && fam !== 'inherit' && fam !== 'initial' && fam !== 'sans-serif' && fam !== 'serif' && fam !== 'monospace' && fam.length > 2) {
      fontCounts[fam] = (fontCounts[fam] || 0) + 1;
    }
  });
  const sortedFonts = Object.entries(fontCounts).sort((a, b) => b[1] - a[1]);
  if (sortedFonts.length > 0) {
    hints.fonts = sortedFonts.slice(0, 3).map(e => e[0]);
  }

  // Detect border radius style
  const radiusMatches = html.match(/border-radius\s*:\s*(\d+)/gi) || [];
  if (radiusMatches.length > 0) {
    const radii = radiusMatches.map(m => parseInt(m.match(/\d+/)[0]));
    const avgRadius = radii.reduce((a, b) => a + b, 0) / radii.length;
    hints.borderRadius = avgRadius > 16 ? 'rounded' : avgRadius > 6 ? 'medium' : 'sharp';
  }

  // Detect dark mode from body background
  const bodyBg = html.match(/body\s*\{[^}]*background[^:]*:\s*(#[0-9a-fA-F]{3,6})/);
  if (bodyBg) {
    let hex = bodyBg[1].replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if (hex.length === 6) {
      const brightness = (parseInt(hex.slice(0,2),16) + parseInt(hex.slice(2,4),16) + parseInt(hex.slice(4,6),16)) / 3;
      hints.isDark = brightness < 80;
    }
  }

  // Detect hero video
  if (/<video[^>]*class[^>]*hero/i.test(html) || /hero[^"]*video/i.test(html)) {
    hints.hasHeroVideo = true;
  }

  // Detect layout patterns
  if (/grid.*template.*columns.*repeat\(3/i.test(html)) hints.layoutHint = '3-col';
  else if (/grid.*template.*columns.*repeat\(4/i.test(html)) hints.layoutHint = '4-col';
  if (/text-align\s*:\s*center[^}]*font-size\s*:\s*(?:3|4|5|6)\d*px/i.test(html)) hints.layoutAlign = 'centered';

  // Detect spacing patterns
  const paddingMatches = html.match(/padding\s*:\s*(\d+)/gi) || [];
  if (paddingMatches.length > 3) {
    const pads = paddingMatches.map(m => parseInt(m.match(/\d+/)[0]));
    const avgPad = pads.reduce((a, b) => a + b, 0) / pads.length;
    hints.spacing = avgPad > 40 ? 'airy' : avgPad > 20 ? 'balanced' : 'tight';
  }

  return hints;
}

// ── Archetype detection ──────────────────────────────────────

function detectArchetype(biz) {
  const n = ((biz.niche || '') + ' ' + (biz.notes || '') + ' ' + (biz.name || '')).toLowerCase();
  if (/photograph|video|music|artist|design|graphic|film|dj|band|producer|creative|tattoo|illustrat/.test(n)) return 'creative';
  if (/restaurant|cafe|bakery|catering|bar\b|food|chef|bistro|pizza|brewery|coffee/.test(n)) return 'food';
  if (/dental|chiro|fitness|training|salon|barber|spa|massage|yoga|therapy|medical|clinic|vet|wellness|skincare/.test(n)) return 'wellness';
  if (/law|legal|account|bookkeep|consult|insurance|real.?estate|realtor|financial|marketing|agency|tech|software|it.?service/.test(n)) return 'professional';
  if (/ecommerce|shop|store|retail|boutique|fashion|jewelry/.test(n)) return 'ecommerce';
  if (/nonprofit|charity|foundation/.test(n)) return 'nonprofit';
  return 'local-service';
}

// ═══════════════════════════════════════════════════════════════
// LAYOUT-SPECIFIC PREVIEW GENERATOR
// Each archetype gets a structurally different page layout
// ═══════════════════════════════════════════════════════════════

/*
 * PREMIUM WEBSITE BLUEPRINT (embedded design intelligence)
 *
 * 1. Hero must pass 50ms test — instant quality impression
 * 2. Generous whitespace around every element (silence between words)
 * 3. Strict grid alignment — invisible lines create subconscious balance
 * 4. 3-5 subtle micro-interactions (hover, scroll fade, button shine)
 * 5. Color palette limited to 3 cohesive colors max
 * 6. Typography hierarchy: massive headlines vs small body (90% of design)
 * 7. Subtle restrained animations — never bouncing/spinning/wacky
 * 8. CTAs feel like next logical step, not desperate buttons
 * 9. No density/clutter — breathing room on all elements
 * 10. Gradients + shadows for depth (not flat lifeless boxes)
 */
function generatePreview(biz) {
  let t = getTheme(biz.style);
  // ── USER CUSTOM INSTRUCTIONS = TOP PRIORITY ──
  // Custom palette overrides style defaults
  if (biz.customPalette && Array.isArray(biz.customPalette) && biz.customPalette.length >= 2) {
    t = applyCustomPalette(t, biz.customPalette);
  }
  // Custom accent overrides everything
  t = applyCustomAccent(t, biz.customAccent);
  // Font requests from notes override defaults
  const fontOverride = parseNotesForFont(biz.notes);
  if (fontOverride) {
    if (fontOverride.font) t.font = fontOverride.font;
    if (fontOverride.fontHead) t.fontHead = fontOverride.fontHead;
    if (fontOverride.gFont) t.gFont = fontOverride.gFont;
  }
  // Apply inspo-extracted fonts if no user font preference
  if (!fontOverride && biz.inspoFonts && biz.inspoFonts.length > 0) {
    const inspoFont = biz.inspoFonts[0].replace(/\b\w/g, c => c.toUpperCase());
    const gName = inspoFont.replace(/\s/g, '+');
    t.font = `'${inspoFont}',sans-serif`;
    t.fontHead = `'${inspoFont}',sans-serif`;
    t.gFont = `${gName}:wght@300;400;500;600;700`;
  }
  // Apply inspo border radius
  if (biz.inspoBorderRadius) {
    const radiusMap = { rounded: '20px', medium: '10px', sharp: '2px' };
    t.cardRadius = radiusMap[biz.inspoBorderRadius] || t.cardRadius;
  }
  // Dark mode from notes
  if (biz.notes && /dark\s*mode|dark\s*theme|dark\s*background|black\s*background/i.test(biz.notes)) {
    const darkOverride = getTheme('bold-dark');
    t.bg = darkOverride.bg; t.bgAlt = darkOverride.bgAlt; t.nav = darkOverride.nav;
    t.text = darkOverride.text; t.textSec = darkOverride.textSec; t.muted = darkOverride.muted;
    t.card = darkOverride.card; t.border = darkOverride.border; t.heroGrad = darkOverride.heroGrad;
    t.trust = darkOverride.trust;
  }
  const nc = getNicheContent(biz.niche, biz);
  const services = enhanceServices(biz.services, nc);
  const archetype = detectArchetype(biz);
  const name = esc(biz.name);
  const phone = esc(biz.phone || '');
  const phoneHref = (biz.phone || '').replace(/[^0-9+]/g, '');
  const loc = esc(biz.location || 'Your Area');
  const years = esc(biz.years || '10+');
  const contactEmail = esc(biz.email || '');
  const year = new Date().getFullYear();
  const isDark = biz.style === 'bold-dark';
  const heroHeadline = esc(nc.heroHeadline);
  const heroSub = esc(nc.heroSub);
  const aboutText = esc(nc.aboutText).replace(/\\n/g, '</p><p>');

  // Select layout type based on archetype
  const layoutMap = {
    'local-service': 'trade',      // split hero + numbered service rows
    'food':          'editorial',   // centered hero + menu-style services
    'wellness':      'editorial',   // centered hero + card grid
    'creative':      'statement',   // giant headline + minimal list
    'ecommerce':     'statement',   // bold hero + cards
    'professional':  'corporate',   // formal hero with form + feature list
    'nonprofit':     'editorial',   // centered hero + features
  };
  const layout = layoutMap[archetype] || 'trade';

  const phoneSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';

  // ── Build layout-specific sections ──

  let heroHtml, trustHtml, servicesHtml, aboutHtml, reviewsHtml, ctaHtml;

  if (layout === 'trade') {
    // TRADE: Split hero (text left, stat card right) + numbered service rows
    heroHtml = `
<section class="hero hero--trade">
  <div class="hero-inner">
    <div class="an an0">
      <div class="hero-badge">${phoneSvg} Licensed &amp; Insured &bull; ${loc}</div>
      <h1>${heroHeadline}</h1>
      <p class="hero-sub">${heroSub}</p>
      <div class="hero-btns">
        ${phone ? `<a href="tel:${phoneHref}" class="btn-p">${phoneSvg} Call ${phone}</a>` : `<a href="#contact" class="btn-p">Get Your Free Quote</a>`}
        <a href="#services" class="btn-o">Our Services</a>
      </div>
    </div>
    <div class="an an1">
      <div class="hero-stats-card">
        <div class="hsc-top">
          <div class="hsc-big">${years}</div>
          <div class="hsc-label">Years serving<br>${loc}</div>
        </div>
        <div class="hsc-row">
          <div class="hsc-item"><strong>4.9</strong><span>Rating</span></div>
          <div class="hsc-item"><strong>500+</strong><span>Projects</span></div>
          <div class="hsc-item"><strong>100%</strong><span>Licensed</span></div>
        </div>
      </div>
    </div>
  </div>
</section>`;
    trustHtml = `
<div class="trust-bar">
  <div class="trust-inner">
    <div class="tb-item"><strong>${years}</strong><span>Years</span></div>
    <div class="tb-item"><strong>4.9 &#9733;</strong><span>Rating</span></div>
    <div class="tb-item"><strong>500+</strong><span>Jobs Done</span></div>
    <div class="tb-item"><strong>A+</strong><span>BBB</span></div>
    <div class="tb-item"><strong>100%</strong><span>Insured</span></div>
  </div>
</div>`;
    servicesHtml = `
<section class="svc-section" id="services">
  <div class="wrap">
    <div class="sec-label">What We Do</div>
    <h2 class="sec-heading">Our Services</h2>
    <p class="sec-intro">Every project gets our full attention. Here's how we help homeowners and businesses in ${loc}.</p>
    <div class="svc-rows">
${services.map((s, i) => `      <div class="svc-row an an${Math.min(i, 3)}">
        <div class="svc-num">0${i + 1}</div>
        <div class="svc-body"><h3>${esc(s.name)}</h3><p>${esc(s.desc)}</p></div>
        <a href="#contact" class="svc-arrow">&rarr;</a>
      </div>`).join('\n')}
    </div>
  </div>
</section>`;
  } else if (layout === 'editorial') {
    // EDITORIAL: Centered elegant hero + 2-column service cards
    heroHtml = `
<section class="hero hero--editorial">
  <div class="hero-center an an0">
    <div class="hero-badge-subtle">${esc(biz.niche || 'Professional Services')} &bull; ${loc}</div>
    <h1>${heroHeadline}</h1>
    <p class="hero-sub">${heroSub}</p>
    <div class="hero-btns hero-btns--center">
      ${phone ? `<a href="tel:${phoneHref}" class="btn-p">${phoneSvg} ${phone}</a>` : `<a href="#contact" class="btn-p">Get Started</a>`}
      <a href="#services" class="btn-o">Learn More</a>
    </div>
  </div>
</section>`;
    trustHtml = `
<div class="trust-subtle">
  <div class="wrap">
    <div class="ts-row">
      <div class="ts-item"><span class="ts-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span> 4.9/5 from 200+ reviews</div>
      <div class="ts-divider"></div>
      <div class="ts-item">${years} years in ${loc}</div>
      <div class="ts-divider"></div>
      <div class="ts-item">Licensed &amp; Insured</div>
    </div>
  </div>
</div>`;
    servicesHtml = `
<section class="svc-section svc-section--editorial" id="services">
  <div class="wrap">
    <div class="sec-label">What We Offer</div>
    <h2 class="sec-heading">Services</h2>
    <div class="svc-grid-2">
${services.map((s, i) => `      <div class="svc-card-2 an an${Math.min(i, 3)}">
        <div class="svc-card-2-num">${String(i + 1).padStart(2, '0')}</div>
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.desc)}</p>
      </div>`).join('\n')}
    </div>
  </div>
</section>`;
  } else if (layout === 'statement') {
    // STATEMENT: Giant headline, minimal, bold
    heroHtml = `
<section class="hero hero--statement">
  <div class="wrap">
    <div class="hero-statement-inner an an0">
      <h1>${heroHeadline}</h1>
      <div class="hero-statement-side">
        <p class="hero-sub">${heroSub}</p>
        ${phone ? `<a href="tel:${phoneHref}" class="btn-p">${phoneSvg} ${phone}</a>` : `<a href="#contact" class="btn-p">Get in Touch</a>`}
      </div>
    </div>
  </div>
</section>`;
    trustHtml = '';
    servicesHtml = `
<section class="svc-section svc-section--list" id="services">
  <div class="wrap">
    <div class="svc-list-header">
      <div class="sec-label">Services</div>
      <h2 class="sec-heading">What we do.</h2>
    </div>
    <div class="svc-list">
${services.map((s, i) => `      <div class="svc-list-item an an${Math.min(i, 3)}">
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.desc)}</p>
      </div>`).join('\n')}
    </div>
  </div>
</section>`;
  } else {
    // CORPORATE: Formal split hero with inquiry form
    heroHtml = `
<section class="hero hero--corporate">
  <div class="hero-inner">
    <div class="an an0">
      <div class="hero-badge-subtle">${esc(biz.niche || 'Professional Services')}</div>
      <h1>${heroHeadline}</h1>
      <p class="hero-sub">${heroSub}</p>
      <div class="hero-credentials">
        <div class="hc-item"><strong>${years}</strong> years in business</div>
        <div class="hc-item"><strong>500+</strong> clients served</div>
      </div>
    </div>
    <div class="an an1">
      <div class="hero-form-card">
        <h3>Request a Consultation</h3>
        <p>Tell us about your needs. We'll respond within one business day.</p>
        <div class="hf-field"><input type="text" placeholder="Your name"></div>
        <div class="hf-field"><input type="email" placeholder="Email address"></div>
        <div class="hf-field"><input type="tel" placeholder="Phone number"></div>
        <a href="#contact" class="btn-p btn-full">Send Request</a>
        <div class="hf-fine">No spam. No obligation. Just a conversation.</div>
      </div>
    </div>
  </div>
</section>`;
    trustHtml = `
<div class="trust-bar trust-bar--corp">
  <div class="trust-inner">
    <div class="tb-item"><strong>${years}+</strong><span>Years Experience</span></div>
    <div class="tb-item"><strong>500+</strong><span>Clients</span></div>
    <div class="tb-item"><strong>4.9/5</strong><span>Client Rating</span></div>
    <div class="tb-item"><strong>24hr</strong><span>Response Time</span></div>
  </div>
</div>`;
    servicesHtml = `
<section class="svc-section" id="services">
  <div class="wrap">
    <div class="sec-label">Our Expertise</div>
    <h2 class="sec-heading">How We Help</h2>
    <p class="sec-intro">We bring clarity, precision, and results to every engagement.</p>
    <div class="svc-feat-grid">
${services.map((s, i) => `      <div class="svc-feat an an${Math.min(i, 3)}">
        <div class="svc-feat-bar"></div>
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.desc)}</p>
      </div>`).join('\n')}
    </div>
  </div>
</section>`;
  }

  // ── About section (varies by layout) ──
  if (layout === 'statement') {
    aboutHtml = `
<section class="about-section about-section--minimal" id="about">
  <div class="wrap">
    <div class="about-minimal">
      <div class="sec-label">About ${name}</div>
      <div class="about-text-col"><p>${aboutText}</p></div>
    </div>
  </div>
</section>`;
  } else if (layout === 'editorial') {
    aboutHtml = `
<section class="about-section about-section--story" id="about">
  <div class="wrap">
    <div class="about-story-layout">
      <div class="sec-label">About ${name}</div>
      <h2 class="sec-heading">Our Story</h2>
      <div class="about-story-text"><p>${aboutText}</p></div>
      <div class="about-stats-row">
        <div class="as-item"><strong>${years}</strong><span>Years</span></div>
        <div class="as-item"><strong>500+</strong><span>Projects</span></div>
        <div class="as-item"><strong>4.9</strong><span>Rating</span></div>
        <div class="as-item"><strong>100%</strong><span>Insured</span></div>
      </div>
    </div>
  </div>
</section>`;
  } else {
    aboutHtml = `
<section class="about-section" id="about">
  <div class="wrap">
    <div class="about-split">
      <div class="about-img-area">
        <div class="about-img-placeholder"></div>
        <div class="about-img-accent"></div>
      </div>
      <div class="about-content">
        <div class="sec-label">About ${name}</div>
        <h2 class="sec-heading">Real people. Real work.</h2>
        <p>${aboutText}</p>
        <div class="about-stats-row">
          <div class="as-item"><strong>${years}</strong><span>Years</span></div>
          <div class="as-item"><strong>500+</strong><span>Projects</span></div>
          <div class="as-item"><strong>4.9</strong><span>Rating</span></div>
        </div>
      </div>
    </div>
  </div>
</section>`;
  }

  // ── Reviews section (varies by layout) ──
  if (layout === 'trade' || layout === 'corporate') {
    // Featured review layout: one big + two small
    const t0 = nc.testimonials[0] || {};
    const rest = nc.testimonials.slice(1);
    reviewsHtml = `
<section class="reviews-section" id="reviews">
  <div class="wrap">
    <div class="sec-label">Reviews</div>
    <h2 class="sec-heading">What our customers say</h2>
    <div class="reviews-featured">
      <div class="review-big an an0">
        <div class="review-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
        <blockquote>&ldquo;${esc(t0.text || '')}&rdquo;</blockquote>
        <cite><strong>${esc(t0.author || '')}</strong><span>${esc(t0.role || '')}</span></cite>
      </div>
      <div class="reviews-side">
${rest.map((rv, i) => `        <div class="review-sm an an${i + 1}">
          <div class="review-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
          <blockquote>${esc(rv.text)}</blockquote>
          <cite><strong>${esc(rv.author)}</strong><span>${esc(rv.role)}</span></cite>
        </div>`).join('\n')}
      </div>
    </div>
  </div>
</section>`;
  } else if (layout === 'statement') {
    // Minimal quotes
    reviewsHtml = `
<section class="reviews-section reviews-section--quotes" id="reviews">
  <div class="wrap">
    <div class="sec-label">Testimonials</div>
    <div class="reviews-quotes">
${nc.testimonials.map((rv, i) => `      <div class="review-quote an an${i}">
        <blockquote>&ldquo;${esc(rv.text)}&rdquo;</blockquote>
        <cite>${esc(rv.author)} &mdash; ${esc(rv.role)}</cite>
      </div>`).join('\n')}
    </div>
  </div>
</section>`;
  } else {
    // Standard grid
    reviewsHtml = `
<section class="reviews-section" id="reviews">
  <div class="wrap">
    <div class="sec-label">Reviews</div>
    <h2 class="sec-heading">What people are saying</h2>
    <div class="reviews-grid">
${nc.testimonials.map((rv, i) => `      <div class="review-card an an${i}">
        <div class="review-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>
        <blockquote>${esc(rv.text)}</blockquote>
        <cite><strong>${esc(rv.author)}</strong><span>${esc(rv.role)}</span></cite>
      </div>`).join('\n')}
    </div>
  </div>
</section>`;
  }

  // ── CTA ──
  ctaHtml = `
<section class="cta-section" id="contact">
  <div class="wrap">
    <div class="cta-inner">
      <h2>Let's talk about your project.</h2>
      <p>No pressure, no obligation. ${phone ? `Call us or send an email` : 'Reach out'} and we'll get back to you within 24 hours.</p>
      <div class="cta-btns">
        ${phone ? `<a href="tel:${phoneHref}" class="btn-p">${phoneSvg} Call ${phone}</a>` : ''}
        ${contactEmail ? `<a href="mailto:${contactEmail}" class="btn-o">Email Us</a>` : `<a href="#" class="btn-o">Contact Us</a>`}
      </div>
    </div>
  </div>
</section>`;

  // ── Assemble page ──

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
${generateCSS(t, isDark, layout)}
</style>
</head>
<body>

<div class="velocity-watermark"><div class="velocity-watermark-inner">${Array(120).fill('<span>VELOCITY PREVIEW</span>').join('')}</div></div>

<nav class="nav">
  <div class="nav-inner">
    <a href="#" class="logo">${name}<span class="logo-dot">.</span></a>
    <div class="nav-links" id="navLinks">
      <a href="#services">Services</a>
      <a href="#about">About</a>
      <a href="#reviews">Reviews</a>
      ${phone ? `<a href="tel:${phoneHref}" class="nav-cta">${phoneSvg} ${phone}</a>` : `<a href="#contact" class="nav-cta">Contact</a>`}
    </div>
    <button class="nav-toggle" aria-label="Menu" onclick="document.getElementById('navLinks').classList.toggle('nav-open');this.classList.toggle('is-open')"><span></span><span></span><span></span></button>
  </div>
</nav>

${heroHtml}
${trustHtml}
${servicesHtml}
${aboutHtml}
${reviewsHtml}
${ctaHtml}

<footer class="footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <a href="#" class="logo">${name}<span class="logo-dot">.</span></a>
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
        <li><a href="#contact">Contact</a></li>
      </ul>
    </div>
    <div class="footer-col">
      <h4>Contact</h4>
      <ul>
        ${phone ? `<li><a href="tel:${phoneHref}">${phone}</a></li>` : ''}
        ${contactEmail ? `<li><a href="mailto:${contactEmail}">${contactEmail}</a></li>` : ''}
        <li>${loc}</li>
      </ul>
    </div>
  </div>
  <div class="footer-bottom">
    <span>&copy; ${year} ${name}. All rights reserved.</span>
    <span class="footer-credit"><a href="https://velocity.delivery" class="velocity-badge"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;opacity:.5"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Velocity</a></span>
  </div>
<div class="preview-disclaimer" style="background:${isDark ? '#1a1815' : '#f5f3ef'};border-top:1px solid ${isDark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.06)'};padding:20px;text-align:center;">
  <p style="font-size:12px;color:${isDark ? '#6d6560' : '#8a8580'};line-height:1.6;max-width:500px;margin:0 auto;">This is a <strong>preview only</strong>. Custom text, products, photos, and advanced features will be added after you select a plan. Many sections are placeholders that will be personalized in the final build.</p>
</div>
</footer>

<!-- Floating mobile CTA -->
${phone ? `<a href="tel:${phoneHref}" class="float-cta"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3"/></svg>Call Now</a>` : `<a href="#contact" class="float-cta">Get Quote</a>`}

<!-- Social proof ticker -->
<div class="social-proof-ticker">
  <div class="ticker-track">
    <span class="ticker-item"><strong>★ 4.9</strong> Average Rating</span>
    <span class="ticker-item"><strong>${years}+</strong> Years Experience</span>
    <span class="ticker-item"><strong>500+</strong> Happy Clients</span>
    <span class="ticker-item">Licensed &amp; Insured</span>
    <span class="ticker-item"><strong>100%</strong> Satisfaction Guaranteed</span>
    <span class="ticker-item">Free Estimates Available</span>
    <span class="ticker-item"><strong>★ 4.9</strong> Average Rating</span>
    <span class="ticker-item"><strong>${years}+</strong> Years Experience</span>
    <span class="ticker-item"><strong>500+</strong> Happy Clients</span>
    <span class="ticker-item">Licensed &amp; Insured</span>
    <span class="ticker-item"><strong>100%</strong> Satisfaction Guaranteed</span>
    <span class="ticker-item">Free Estimates Available</span>
  </div>
</div>

<script>
// Scroll-triggered reveals
(function(){var els=document.querySelectorAll('.svc-row,.svc-card-2,.svc-feat,.svc-list-item,.review-card,.review-sm,.review-big,.review-quote,.about-split,.about-minimal,.about-story-layout,.cta-inner');els.forEach(function(el,i){el.classList.add('reveal');if(i%4===1)el.classList.add('reveal-delay-1');if(i%4===2)el.classList.add('reveal-delay-2');if(i%4===3)el.classList.add('reveal-delay-3');});if('IntersectionObserver' in window){var obs=new IntersectionObserver(function(entries){entries.forEach(function(e){if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target);}});},{threshold:0.1,rootMargin:'0px 0px -40px 0px'});els.forEach(function(el){obs.observe(el);});}else{els.forEach(function(el){el.classList.add('visible');});}})();
// Smooth nav shadow on scroll
(function(){var nav=document.querySelector('.nav');if(!nav)return;window.addEventListener('scroll',function(){nav.style.boxShadow=window.scrollY>20?'0 4px 30px rgba(0,0,0,.08)':'none';},{passive:true});})();
// Page section in-view animations
(function(){var secs=document.querySelectorAll('section');secs.forEach(function(s){s.classList.add('page-section');});if('IntersectionObserver' in window){var io=new IntersectionObserver(function(entries){entries.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in-view');io.unobserve(e.target);}});},{threshold:0.08});secs.forEach(function(s){io.observe(s);});}else{secs.forEach(function(s){s.classList.add('in-view');});}})();
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
// CSS GENERATOR — layout-aware stylesheet
// ═══════════════════════════════════════════════════════════════

function generateCSS(t, isDark, layout) {
  const shadow = isDark ? 'rgba(0,0,0,.4)' : 'rgba(0,0,0,.08)';
  const shadowHover = isDark ? 'rgba(0,0,0,.25)' : 'rgba(0,0,0,.06)';

  // ── Shared base CSS ──
  let css = `*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:${t.bg};--bg-alt:${t.bgAlt};--nav:${t.nav};--accent:${t.accent};--accent-hover:${t.accentHover};--accent-bg:${t.accentBg};--accent-bg-solid:${t.accentBgSolid};--trust:${t.trust};--text:${t.text};--text-sec:${t.textSec};--muted:${t.muted};--card:${t.card};--border:${t.border};--font:${t.font};--font-head:${t.fontHead};--r:8px;--rl:14px}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.7;overflow-x:hidden;font-size:15px}
a{color:inherit;text-decoration:none}img{max-width:100%;display:block}
.wrap{max-width:1100px;margin:0 auto;padding:0 24px}

/* Nav */
.nav{position:sticky;top:0;z-index:100;background:var(--nav);border-bottom:1px solid var(--border);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.nav-inner{max-width:1100px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;height:64px}
.logo{font-family:var(--font-head);font-size:20px;font-weight:400;color:var(--text);letter-spacing:-.02em}.logo-dot{color:var(--accent)}
.nav-links{display:flex;align-items:center;gap:28px;font-size:14px;color:var(--text-sec)}.nav-links a{transition:color .2s}.nav-links a:hover{color:var(--text)}
.nav-cta{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#fff!important;padding:9px 20px;border-radius:var(--r);font-weight:600;font-size:13px;transition:all .2s}.nav-cta:hover{background:var(--accent-hover);transform:translateY(-1px)}
.nav-toggle{display:none;flex-direction:column;gap:5px;background:none;border:none;cursor:pointer;padding:6px}.nav-toggle span{display:block;width:20px;height:2px;background:var(--text);transition:all .3s}
.nav-toggle.is-open span:first-child{transform:rotate(45deg) translate(3px,5px)}.nav-toggle.is-open span:nth-child(2){opacity:0}.nav-toggle.is-open span:last-child{transform:rotate(-45deg) translate(3px,-5px)}

/* Buttons */
.btn-p{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#fff;padding:14px 28px;border-radius:var(--r);font-weight:600;font-size:15px;transition:all .25s;border:none;cursor:pointer}
.btn-p:hover{background:var(--accent-hover);transform:translateY(-2px);box-shadow:0 8px 24px ${isDark ? 'rgba(200,149,106,.2)' : 'rgba(0,0,0,.12)'}}
.btn-o{display:inline-flex;align-items:center;gap:8px;background:transparent;color:var(--text-sec);padding:14px 28px;border-radius:var(--r);font-weight:500;font-size:15px;border:1px solid var(--border);transition:all .25s;cursor:pointer}
.btn-o:hover{border-color:var(--accent);color:var(--accent)}.btn-full{width:100%;justify-content:center}

/* Section headings */
.sec-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);margin-bottom:8px}
.sec-heading{font-family:var(--font-head);font-size:clamp(22px,3.5vw,34px);font-weight:400;margin-bottom:12px;color:var(--text)}
.sec-intro{font-size:15px;color:var(--text-sec);line-height:1.7;margin-bottom:40px;max-width:540px}

/* Reviews shared */
.review-stars{color:#f5b731;font-size:14px;letter-spacing:2px;margin-bottom:12px}

/* CTA */
.cta-section{padding:80px 24px;background:var(--bg-alt);text-align:center}
.cta-inner{max-width:600px;margin:0 auto}
.cta-inner h2{font-family:var(--font-head);font-size:clamp(22px,3.5vw,34px);font-weight:400;margin-bottom:16px}
.cta-inner p{font-size:15px;color:var(--text-sec);line-height:1.7;margin-bottom:28px}
.cta-btns{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}

/* Footer */
.footer{padding:48px 24px 32px;border-top:1px solid var(--border);background:var(--bg)}
.footer-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:40px}
.footer-brand .logo{margin-bottom:12px;display:inline-block}.footer-brand p{font-size:13px;color:var(--muted);line-height:1.6;max-width:240px}
.footer-col h4{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:12px}
.footer-col ul{list-style:none}.footer-col li{margin-bottom:6px}.footer-col a{font-size:13px;color:var(--text-sec);transition:color .2s}.footer-col a:hover{color:var(--accent)}
.footer-bottom{max-width:1100px;margin:32px auto 0;padding-top:24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}
.footer-credit{font-size:11px;display:inline-flex;align-items:center;gap:3px;background:#12100e;color:#6d6560;padding:4px 10px;border-radius:4px}.velocity-badge{color:#6d6560;text-decoration:none;transition:color .2s;letter-spacing:.01em}.velocity-badge:hover{color:#c8956a}

/* Watermark */
.velocity-watermark{position:fixed;inset:0;z-index:9998;pointer-events:none;overflow:hidden;opacity:.045}
.velocity-watermark-inner{position:absolute;top:-50%;left:-50%;width:200%;height:200%;transform:rotate(-30deg);display:flex;flex-wrap:wrap;gap:80px 60px;align-content:flex-start;justify-content:center}
.velocity-watermark-inner span{font-family:sans-serif;font-size:14px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:#c8956a;white-space:nowrap}

/* Enhancement 1: Micro-interaction hover effects */
.svc-row,.svc-card-2,.svc-feat,.svc-list-item,.review-card,.review-sm{transition:all .35s cubic-bezier(.16,1,.3,1)}
.review-card:hover,.review-sm:hover{transform:translateY(-4px);box-shadow:0 12px 40px ${shadow}}
.btn-p{position:relative;overflow:hidden}.btn-p::after{content:'';position:absolute;inset:0;background:linear-gradient(120deg,transparent 30%,rgba(255,255,255,.12) 50%,transparent 70%);transform:translateX(-100%);transition:transform .5s}.btn-p:hover::after{transform:translateX(100%)}

/* Enhancement 2: Scroll-triggered reveals */
.reveal{opacity:0;transform:translateY(24px);transition:opacity .7s cubic-bezier(.16,1,.3,1),transform .7s cubic-bezier(.16,1,.3,1)}.reveal.visible{opacity:1;transform:translateY(0)}
.reveal-delay-1{transition-delay:.1s}.reveal-delay-2{transition-delay:.2s}.reveal-delay-3{transition-delay:.3s}.reveal-delay-4{transition-delay:.4s}

/* Enhancement 3: Glassmorphism nav */
.nav{background:${isDark ? 'rgba(14,12,10,.75)' : 'rgba(255,255,255,.75)'};backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%)}

/* Enhancement 4: Animated hero gradient */
@keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}

/* Enhancement 5: Typography refinement */
h1,h2,h3{text-wrap:balance}
.hero h1,.hero--trade h1,.hero--editorial h1,.hero--statement h1,.hero--corporate h1{letter-spacing:-.03em}
.sec-heading{letter-spacing:-.02em}

/* Smooth scroll indicator */
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}

/* NEW Feature 1: Floating mobile CTA */
.float-cta{display:none;position:fixed;bottom:20px;right:20px;z-index:9990;background:var(--accent);color:#fff;padding:14px 22px;border-radius:100px;font-weight:600;font-size:14px;box-shadow:0 8px 32px rgba(0,0,0,.2);text-decoration:none;transition:all .3s;border:none;cursor:pointer}
.float-cta:hover{transform:translateY(-3px);box-shadow:0 12px 40px rgba(0,0,0,.25)}
.float-cta svg{vertical-align:middle;margin-right:6px}
@media(max-width:768px){.float-cta{display:inline-flex;align-items:center}}

/* NEW Feature 2: Animated social proof ticker */
.social-proof-ticker{overflow:hidden;background:var(--accent-bg-solid);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:10px 0}
.ticker-track{display:flex;animation:ticker 25s linear infinite;white-space:nowrap;gap:48px}
.ticker-item{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-sec);flex-shrink:0}
.ticker-item strong{color:var(--accent)}
@keyframes ticker{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}

/* NEW Feature 3: Animated stats counters */
.stat-counter{display:inline-block;font-variant-numeric:tabular-nums}
@keyframes countPulse{0%{transform:scale(1)}50%{transform:scale(1.05)}100%{transform:scale(1)}}
.stat-pulse{animation:countPulse 2s ease infinite}

/* NEW Feature 4: Gradient text headings */
.grad-text{background:linear-gradient(135deg,var(--accent),var(--text));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}

/* NEW Feature 5: Smooth page transitions */
.page-section{opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .6s ease}
.page-section.in-view{opacity:1;transform:translateY(0)}

/* Animations */
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.an{animation:fadeUp .7s ease both}.an0{animation-delay:.05s}.an1{animation-delay:.15s}.an2{animation-delay:.25s}.an3{animation-delay:.35s}

/* Responsive */
@media(max-width:900px){
.hero-inner{grid-template-columns:1fr!important;gap:32px}
.hero-stats-card,.hero-form-card{display:none}
.hero--statement .hero-statement-inner{flex-direction:column;gap:24px}
.reviews-featured{grid-template-columns:1fr}
.svc-grid-2,.svc-feat-grid,.reviews-grid{grid-template-columns:1fr 1fr}
.about-split{grid-template-columns:1fr}.about-img-area{display:none}
.footer-inner{grid-template-columns:1fr 1fr;gap:24px}.footer-brand{grid-column:1/-1}
}
@media(max-width:600px){
.nav-links{display:none;position:fixed;top:64px;left:0;right:0;bottom:0;background:var(--bg);flex-direction:column;align-items:center;justify-content:center;gap:24px;font-size:18px;z-index:99}
.nav-links.nav-open{display:flex!important}
.nav-toggle{display:flex}
.hero{padding:60px 20px 48px!important}
.hero--statement h1{font-size:32px!important}
.svc-grid-2,.reviews-grid,.svc-feat-grid{grid-template-columns:1fr}
.svc-row{flex-direction:column;gap:8px}.svc-num{font-size:20px}
.trust-inner,.ts-row{flex-direction:column;gap:12px;text-align:center}
.about-stats-row{flex-wrap:wrap;gap:16px}
.footer-inner{grid-template-columns:1fr}.footer-bottom{flex-direction:column;gap:8px;text-align:center}
}`;

  // ── Layout-specific CSS ──

  if (layout === 'trade') {
    css += `
/* TRADE layout */
.hero--trade{padding:80px 24px 64px;background:${t.heroGrad};background-size:200% 200%;animation:gradientShift 12s ease infinite;position:relative;overflow:hidden}
.hero--trade::after{content:'';position:absolute;top:-30%;right:-15%;width:500px;height:500px;border-radius:50%;background:var(--accent-bg);filter:blur(80px);pointer-events:none;opacity:.7}
.hero--trade .hero-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1.15fr .85fr;gap:48px;align-items:center;position:relative;z-index:1}
.hero-badge{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);margin-bottom:16px;padding:6px 14px;background:var(--accent-bg-solid);border-radius:100px;border:1px solid var(--accent-bg)}
.hero--trade h1{font-family:var(--font-head);font-size:clamp(28px,4.5vw,46px);font-weight:400;line-height:1.12;letter-spacing:-.02em;margin-bottom:20px}
.hero-sub{font-size:16px;color:var(--text-sec);line-height:1.75;margin-bottom:32px;max-width:500px}
.hero-btns{display:flex;gap:12px;flex-wrap:wrap}
.hero-stats-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:32px;box-shadow:0 24px 64px ${shadow}}
.hsc-top{display:flex;align-items:baseline;gap:16px;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid var(--border)}
.hsc-big{font-family:var(--font-head);font-size:56px;color:var(--accent);line-height:1}
.hsc-label{font-size:14px;color:var(--text-sec);line-height:1.4}
.hsc-row{display:flex;gap:12px}.hsc-item{flex:1;text-align:center;padding:14px 8px;background:var(--accent-bg-solid);border-radius:var(--r);border:1px solid var(--accent-bg)}
.hsc-item strong{display:block;font-family:var(--font-head);font-size:22px;color:var(--accent)}.hsc-item span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.trust-bar{background:var(--trust);padding:20px 24px}
.trust-inner{max-width:1100px;margin:0 auto;display:flex;justify-content:center;gap:48px;flex-wrap:wrap}
.tb-item{display:flex;flex-direction:column;align-items:center;gap:2px}.tb-item strong{font-family:var(--font-head);font-size:20px;color:#fff;font-weight:400}.tb-item span{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.4)}
.svc-rows{display:flex;flex-direction:column;gap:1px;background:var(--border);border-radius:var(--rl);overflow:hidden}
.svc-row{display:flex;align-items:center;gap:24px;padding:28px 32px;background:var(--card);transition:all .3s}
.svc-row:hover{background:var(--accent-bg-solid)}
.svc-num{font-family:var(--font-head);font-size:28px;color:var(--accent);opacity:.4;flex-shrink:0;width:40px}
.svc-row:hover .svc-num{opacity:1}
.svc-body{flex:1}.svc-body h3{font-size:16px;font-weight:600;margin-bottom:4px}.svc-body p{font-size:13px;color:var(--text-sec);line-height:1.6}
.svc-arrow{font-size:20px;color:var(--muted);transition:color .2s;flex-shrink:0}.svc-row:hover .svc-arrow{color:var(--accent)}`;
  } else if (layout === 'editorial') {
    css += `
/* EDITORIAL layout */
.hero--editorial{padding:100px 24px 80px;background:${t.heroGrad};background-size:200% 200%;animation:gradientShift 12s ease infinite;text-align:center;position:relative;overflow:hidden}
.hero--editorial::after{content:'';position:absolute;bottom:-20%;left:50%;transform:translateX(-50%);width:700px;height:500px;border-radius:50%;background:var(--accent-bg);filter:blur(100px);pointer-events:none;opacity:.5}
.hero-center{max-width:680px;margin:0 auto;position:relative;z-index:1}
.hero-badge-subtle{font-size:13px;color:var(--text-sec);margin-bottom:20px;letter-spacing:.02em}
.hero--editorial h1{font-family:var(--font-head);font-size:clamp(30px,5vw,52px);font-weight:400;line-height:1.1;letter-spacing:-.02em;margin-bottom:24px}
.hero--editorial .hero-sub{font-size:16px;color:var(--text-sec);line-height:1.75;margin-bottom:36px;max-width:520px;margin-left:auto;margin-right:auto}
.hero-btns--center{justify-content:center}
.trust-subtle{padding:20px 24px;border-bottom:1px solid var(--border)}
.ts-row{display:flex;align-items:center;justify-content:center;gap:24px;font-size:13px;color:var(--text-sec)}
.ts-stars{color:#f5b731;letter-spacing:1px;margin-right:4px}
.ts-divider{width:1px;height:16px;background:var(--border)}
.svc-section--editorial{padding:80px 24px;background:var(--bg-alt)}
.svc-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.svc-card-2{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:32px;transition:all .3s;position:relative}
.svc-card-2:hover{border-color:var(--accent);transform:translateY(-2px);box-shadow:0 12px 32px ${shadowHover}}
.svc-card-2-num{font-family:var(--font-head);font-size:36px;color:var(--accent);opacity:.15;position:absolute;top:16px;right:20px;line-height:1}
.svc-card-2 h3{font-size:17px;font-weight:600;margin-bottom:8px}.svc-card-2 p{font-size:13px;color:var(--text-sec);line-height:1.65}`;
  } else if (layout === 'statement') {
    css += `
/* STATEMENT layout */
.hero--statement{padding:100px 24px 80px;background:var(--bg);position:relative}
.hero--statement::before{content:'';position:absolute;top:0;left:0;right:0;bottom:0;background:${t.heroGrad};opacity:.5}
.hero-statement-inner{display:flex;gap:64px;align-items:flex-end;position:relative;z-index:1}
.hero--statement h1{font-family:var(--font-head);font-size:clamp(36px,7vw,72px);font-weight:400;line-height:1.02;letter-spacing:-.03em;flex:1.5}
.hero-statement-side{flex:1;padding-bottom:8px}
.hero--statement .hero-sub{font-size:15px;color:var(--text-sec);line-height:1.75;margin-bottom:28px}
.svc-section--list{padding:80px 24px;border-top:1px solid var(--border)}
.svc-list-header{margin-bottom:40px}
.svc-list{border-top:1px solid var(--border)}
.svc-list-item{padding:28px 0;border-bottom:1px solid var(--border);display:grid;grid-template-columns:1fr 2fr;gap:32px;align-items:start}
.svc-list-item h3{font-family:var(--font-head);font-size:18px;font-weight:400}
.svc-list-item p{font-size:14px;color:var(--text-sec);line-height:1.7}`;
  } else {
    css += `
/* CORPORATE layout */
.hero--corporate{padding:80px 24px 64px;background:${t.heroGrad};background-size:200% 200%;animation:gradientShift 12s ease infinite;position:relative;overflow:hidden}
.hero--corporate .hero-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1.2fr .8fr;gap:56px;align-items:center;position:relative;z-index:1}
.hero-badge-subtle{font-size:13px;color:var(--accent);font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin-bottom:16px}
.hero--corporate h1{font-family:var(--font-head);font-size:clamp(26px,4vw,42px);font-weight:400;line-height:1.15;letter-spacing:-.02em;margin-bottom:20px}
.hero--corporate .hero-sub{font-size:15px;color:var(--text-sec);line-height:1.75;margin-bottom:24px}
.hero-credentials{display:flex;gap:24px;font-size:14px;color:var(--text-sec)}.hero-credentials strong{color:var(--accent)}
.hero-form-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:32px;box-shadow:0 24px 64px ${shadow}}
.hero-form-card h3{font-family:var(--font-head);font-size:20px;margin-bottom:8px}.hero-form-card>p{font-size:13px;color:var(--text-sec);margin-bottom:20px}
.hf-field{margin-bottom:12px}.hf-field input{width:100%;padding:12px 16px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;transition:border-color .2s}
.hf-field input:focus{outline:none;border-color:var(--accent)}.hf-field input::placeholder{color:var(--muted)}
.hf-fine{font-size:11px;color:var(--muted);text-align:center;margin-top:12px}
.trust-bar--corp{background:var(--bg-alt);border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.trust-bar--corp .tb-item strong{color:var(--accent)}.trust-bar--corp .tb-item span{color:var(--muted)}
.svc-feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.svc-feat{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:28px;transition:all .3s;position:relative;overflow:hidden}
.svc-feat:hover{border-color:var(--accent);transform:translateY(-2px)}
.svc-feat-bar{width:40px;height:3px;background:var(--accent);border-radius:2px;margin-bottom:16px;transition:width .3s}.svc-feat:hover .svc-feat-bar{width:60px}
.svc-feat h3{font-size:15px;font-weight:600;margin-bottom:8px}.svc-feat p{font-size:13px;color:var(--text-sec);line-height:1.65}`;
  }

  // ── About CSS (shared across layouts) ──
  css += `
/* About */
.about-section{padding:80px 24px;background:var(--bg-alt)}
.about-split{display:grid;grid-template-columns:.9fr 1.1fr;gap:56px;align-items:center;max-width:1100px;margin:0 auto}
.about-img-area{position:relative}
.about-img-placeholder{width:100%;aspect-ratio:4/3;background:var(--accent-bg-solid);border-radius:var(--rl);border:1px solid var(--accent-bg)}
.about-img-accent{position:absolute;top:12px;left:12px;right:-12px;bottom:-12px;border:2px solid var(--accent);border-radius:var(--rl);opacity:.15;z-index:-1}
.about-content h2{margin-bottom:16px}.about-content p{font-size:15px;color:var(--text-sec);line-height:1.8;margin-bottom:16px}
.about-stats-row{display:flex;gap:32px;margin-top:28px;padding-top:24px;border-top:1px solid var(--border)}
.as-item{text-align:center}.as-item strong{display:block;font-family:var(--font-head);font-size:28px;color:var(--accent)}.as-item span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.about-section--minimal{background:var(--bg)}
.about-minimal{max-width:700px}
.about-text-col p{font-size:16px;color:var(--text-sec);line-height:1.85;margin-bottom:16px}
.about-section--story{background:var(--bg-alt)}
.about-story-layout{max-width:700px;margin:0 auto;text-align:center}
.about-story-text{text-align:left;margin-top:24px}.about-story-text p{font-size:15px;color:var(--text-sec);line-height:1.8;margin-bottom:16px}
.about-story-layout .about-stats-row{justify-content:center;margin-top:32px}`;

  // ── Reviews CSS ──
  css += `
/* Reviews */
.reviews-section{padding:80px 24px}
.reviews-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:32px}
.review-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:28px;display:flex;flex-direction:column}
.review-card blockquote{font-size:14px;color:var(--text-sec);line-height:1.7;flex:1;padding-bottom:16px}
.review-card cite{font-style:normal;font-size:13px;display:block;padding-top:16px;border-top:1px solid var(--border)}.review-card cite strong{display:block;color:var(--text)}.review-card cite span{font-size:12px;color:var(--muted)}
.reviews-featured{display:grid;grid-template-columns:1.3fr .7fr;gap:20px;margin-top:32px}
.review-big{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:40px;display:flex;flex-direction:column;justify-content:center}
.review-big blockquote{font-family:var(--font-head);font-size:20px;line-height:1.5;color:var(--text);margin-bottom:20px;font-weight:400}
.review-big cite{font-style:normal;font-size:14px}.review-big cite strong{display:block;color:var(--text)}.review-big cite span{font-size:12px;color:var(--muted)}
.reviews-side{display:flex;flex-direction:column;gap:16px}
.review-sm{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:24px;flex:1}
.review-sm blockquote{font-size:13px;color:var(--text-sec);line-height:1.65;margin-bottom:12px}
.review-sm cite{font-style:normal;font-size:12px}.review-sm cite strong{color:var(--text)}.review-sm cite span{color:var(--muted);margin-left:4px}
.reviews-section--quotes{border-top:1px solid var(--border)}
.reviews-quotes{max-width:700px;margin-top:32px}
.review-quote{padding:32px 0;border-bottom:1px solid var(--border)}
.review-quote blockquote{font-family:var(--font-head);font-size:18px;line-height:1.5;color:var(--text);margin-bottom:12px;font-weight:400}
.review-quote cite{font-size:13px;color:var(--muted);font-style:normal}`;

  // ── Services section padding ──
  css += `
.svc-section{padding:80px 24px}`;

  return css;
}
