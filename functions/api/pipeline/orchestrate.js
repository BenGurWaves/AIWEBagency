/**
 * POST /api/pipeline/orchestrate
 *
 * Pipeline Orchestrator
 * ─────────────────────
 * Coordinates all agents in sequence to build a complete website:
 *
 *   Step 1: SCRAPE  — Deep-scrape the existing website (scrape.js)
 *   Step 2: CONTENT — Generate unique, human-quality copy (content.js)
 *   Step 3: BUILD   — Construct multi-page production site (build.js)
 *   Step 4: QA      — Validate quality, catch AI slop (qa.js)
 *   Step 5: STORE   — Persist everything and update user records
 *
 * This is the single endpoint the dashboard calls.
 * Progress is stored in KV so the frontend can poll for updates.
 *
 * Body: {
 *   email: string,
 *   website_url?: string,
 *   business_name: string,
 *   niche?: string,
 *   services?: string,
 *   location?: string,
 *   years?: string,
 *   phone?: string,
 *   style?: string,
 *   site_type?: string,
 *   contact_email?: string,
 *   notes?: string,
 *   plan?: string,
 * }
 *
 * Returns: { preview_id, preview_url, pages, qa_score }
 *
 * Progress can be polled at: GET /api/pipeline/progress?email=...
 */
import { json, err, corsPreflightResponse, getKV, generateId, esc } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);
  if (!kv) return err('Storage not configured', 500);

  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON'); }

  const email = (body.email || '').trim().toLowerCase();
  if (!email) return err('email is required');
  if (!body.business_name) return err('business_name is required');

  const pipelineId = generateId();

  // Initialize progress
  await updateProgress(kv, email, {
    pipeline_id: pipelineId,
    status: 'running',
    step: 'scrape',
    step_number: 1,
    total_steps: 5,
    percent: 5,
    message: 'Scanning your website...',
    started_at: new Date().toISOString(),
  });

  try {
    // ═══════════════════════════════════════════════════════════
    // STEP 1: SCRAPE — Analyze the existing website
    // ═══════════════════════════════════════════════════════════

    let siteDna = null;
    if (body.website_url) {
      await updateProgress(kv, email, {
        step: 'scrape', step_number: 1, percent: 10,
        message: 'Scanning your current website...',
        detail: 'Extracting content, colors, images, and structure',
      });

      // Inline scraping (calls same logic as scrape.js)
      siteDna = await scrapeSite(body.website_url);

      await kv.put('site_dna:' + email, JSON.stringify(siteDna), { expirationTtl: 86400 * 90 });
    }

    await updateProgress(kv, email, {
      step: 'scrape', step_number: 1, percent: 20,
      message: 'Website analysis complete',
      detail: siteDna ? `Found: ${siteDna.business_name || 'business info'}, ${siteDna.images?.length || 0} images, ${siteDna.services_found?.length || 0} services` : 'No existing site to scan — using questionnaire data',
    });

    // ═══════════════════════════════════════════════════════════
    // STEP 2: CONTENT — Generate human-quality copy
    // ═══════════════════════════════════════════════════════════

    await updateProgress(kv, email, {
      step: 'content', step_number: 2, percent: 30,
      message: 'Writing your website copy...',
      detail: 'Generating hero headlines, service descriptions, and testimonials',
    });

    const contentInput = {
      name: body.business_name,
      niche: body.niche || '',
      services: body.services || '',
      location: body.location || '',
      years: body.years || '',
      phone: body.phone || '',
      style: body.style || 'modern-clean',
      notes: body.notes || '',
      tagline: siteDna?.tagline || '',
      existing_headings: siteDna?.page_headings || [],
      existing_paragraphs: siteDna?.paragraphs || [],
      existing_services: siteDna?.services_found || [],
      existing_ctas: siteDna?.cta_texts || [],
      hero_headline: siteDna?.hero_headline || '',
      rating: siteDna?.rating || null,
      review_count: siteDna?.review_count || null,
    };

    const content = generateContentFromInput(contentInput);

    await kv.put('content:' + email, JSON.stringify(content), { expirationTtl: 86400 * 90 });

    await updateProgress(kv, email, {
      step: 'content', step_number: 2, percent: 45,
      message: 'Content written',
      detail: `Generated ${content.services?.length || 0} service descriptions, ${content.testimonials?.length || 0} testimonials`,
    });

    // ═══════════════════════════════════════════════════════════
    // STEP 2.5: DISCOVER — Load design inspiration from curated sites
    // ═══════════════════════════════════════════════════════════

    let designIntel = null;
    if (body.niche) {
      await updateProgress(kv, email, {
        step: 'discover', step_number: 2, percent: 48,
        message: 'Researching top designs in your industry...',
        detail: 'Analyzing high-quality websites for design inspiration',
      });

      // Check if we already have discovery data for this niche
      try {
        designIntel = await kv.get('discover:' + (body.niche || '').trim().toLowerCase(), { type: 'json' });
      } catch {}

      if (designIntel) {
        await updateProgress(kv, email, {
          step: 'discover', step_number: 2, percent: 52,
          message: 'Design research loaded',
          detail: `${designIntel.sites_analyzed || 0} top sites analyzed for design patterns`,
        });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 3: BUILD — Construct the website pages
    // ═══════════════════════════════════════════════════════════

    await updateProgress(kv, email, {
      step: 'build', step_number: 3, percent: 55,
      message: 'Building your website...',
      detail: 'Constructing pages with your brand colors and style',
    });

    // Build the preview (single-page for now, multi-page for paid plans)
    const biz = {
      name: body.business_name,
      niche: body.niche || '',
      services: body.services || '',
      location: body.location || siteDna?.address || '',
      years: body.years || '',
      phone: body.phone || siteDna?.phone || '',
      email: body.contact_email || siteDna?.email || email,
      style: body.style || 'modern-clean',
      siteType: body.site_type || 'service-business',
      domain: siteDna?.domain || '',
      tagline: siteDna?.tagline || '',
      notes: body.notes || '',
      designIntel: designIntel || null,
    };

    const previewId = generateId();
    const previewHtml = buildPreviewPage(biz, content);

    await kv.put(`preview:${previewId}`, previewHtml, { expirationTtl: 86400 * 90 });

    await updateProgress(kv, email, {
      step: 'build', step_number: 3, percent: 75,
      message: 'Website built',
      detail: 'Homepage constructed with hero, services, reviews, and contact sections',
    });

    // ═══════════════════════════════════════════════════════════
    // STEP 4: QA — Validate quality
    // ═══════════════════════════════════════════════════════════

    await updateProgress(kv, email, {
      step: 'qa', step_number: 4, percent: 85,
      message: 'Running quality checks...',
      detail: 'Checking for AI slop, accessibility, SEO, and responsiveness',
    });

    const qaResult = runQA(previewHtml, body.business_name);

    await kv.put(`qa:${previewId}`, JSON.stringify(qaResult), { expirationTtl: 86400 * 30 });

    await updateProgress(kv, email, {
      step: 'qa', step_number: 4, percent: 92,
      message: `Quality score: ${qaResult.score}/100`,
      detail: qaResult.passed ? 'All checks passed' : `${qaResult.total_issues} issue(s) found`,
    });

    // ═══════════════════════════════════════════════════════════
    // STEP 5: FINALIZE — Store everything
    // ═══════════════════════════════════════════════════════════

    await updateProgress(kv, email, {
      step: 'finalize', step_number: 5, percent: 95,
      message: 'Finalizing your preview...',
    });

    // Update redesign record
    try {
      const existing = await kv.get('redesign:' + email, { type: 'json' }) || {};
      Object.assign(existing, body, {
        preview_id: previewId,
        preview_url: `/preview/${previewId}`,
        preview_generated_at: new Date().toISOString(),
        qa_score: qaResult.score,
        qa_passed: qaResult.passed,
        pipeline_id: pipelineId,
      });
      await kv.put('redesign:' + email, JSON.stringify(existing), { expirationTtl: 86400 * 90 });
    } catch {}

    // Mark complete
    await updateProgress(kv, email, {
      pipeline_id: pipelineId,
      status: 'complete',
      step: 'done',
      step_number: 5,
      total_steps: 5,
      percent: 100,
      message: 'Your preview is ready!',
      preview_id: previewId,
      preview_url: `/preview/${previewId}`,
      qa_score: qaResult.score,
      completed_at: new Date().toISOString(),
    });

    return json({
      success: true,
      preview_id: previewId,
      preview_url: `/preview/${previewId}`,
      qa_score: qaResult.score,
      qa_passed: qaResult.passed,
    });

  } catch (e) {
    await updateProgress(kv, email, {
      status: 'error',
      percent: 0,
      message: 'Something went wrong: ' + (e.message || 'Unknown error'),
      error: e.message,
    });
    return err('Pipeline error: ' + e.message, 500);
  }
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}

// ── Progress tracking ─────────────────────────────────────────

async function updateProgress(kv, email, data) {
  try {
    const existing = await kv.get('progress:' + email, { type: 'json' }) || {};
    Object.assign(existing, data, { updated_at: new Date().toISOString() });
    await kv.put('progress:' + email, JSON.stringify(existing), { expirationTtl: 86400 });
  } catch {}
}

// ── Inline scraper (simplified from scrape.js for orchestrator use) ──

async function scrapeSite(baseUrl) {
  let url = baseUrl;
  if (!url.startsWith('http')) url = 'https://' + url;

  const dna = {
    url, domain: '', business_name: '', tagline: '', phone: '', email: '',
    address: '', colors: [], logo_url: '', images: [], social_links: {},
    page_headings: [], paragraphs: [], services_found: [], cta_texts: [],
    hero_headline: '', tech_signals: [], has_ssl: false,
    rating: null, review_count: null, reachable: false,
  };

  try { dna.domain = new URL(url).hostname.replace('www.', ''); } catch {}

  let html = '';
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    html = await resp.text();
    dna.reachable = true;
    dna.has_ssl = resp.url.startsWith('https');
  } catch {
    return dna;
  }

  // Business info
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (titleMatch) {
    let t = titleMatch[1].replace(/\s*[-|–—:].*/g, '').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/<[^>]+>/g, '').trim();
    if (t.length > 2 && t.length < 60) dna.business_name = t;
  }
  const siteNameMatch = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["'](.*?)["']/i);
  if (siteNameMatch) dna.business_name = siteNameMatch[1].replace(/&amp;/g, '&');

  const phoneMatch = html.match(/href=["']tel:([^"']+)["']/i) || html.match(/(\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/);
  if (phoneMatch) dna.phone = phoneMatch[1].replace(/[^\d()-.\s+]/g, '').trim();

  const emailMatch = html.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch && !emailMatch[1].includes('example.') && !emailMatch[1].includes('wix')) dna.email = emailMatch[1];

  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/i);
  if (descMatch && descMatch[1].length > 10) dna.tagline = descMatch[1].replace(/&amp;/g, '&');

  const addrMatch = html.match(/\d{2,5}\s+[\w\s.]+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct|Pl)[.,]?\s*(?:Suite|Ste|#|Apt)?\s*\d*[.,]?\s*[\w\s]+[.,]?\s*[A-Z]{2}\s+\d{5}/i);
  if (addrMatch) dna.address = addrMatch[0].trim();

  // Content
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (h1Match) dna.hero_headline = h1Match[1].replace(/<[^>]+>/g, '').trim();

  const headingMatches = html.matchAll(/<h[1-4][^>]*>(.*?)<\/h[1-4]>/gi);
  for (const m of headingMatches) {
    const t = m[1].replace(/<[^>]+>/g, '').trim();
    if (t.length > 3 && t.length < 200) dna.page_headings.push(t);
  }
  dna.page_headings = [...new Set(dna.page_headings)].slice(0, 15);

  const pMatches = html.match(/<p[^>]*>(.*?)<\/p>/gi) || [];
  for (const p of pMatches) {
    const text = p.replace(/<[^>]+>/g, '').trim();
    if (text.length > 30 && text.length < 1000) dna.paragraphs.push(text);
  }
  dna.paragraphs = [...new Set(dna.paragraphs)].slice(0, 10);

  // Services
  const afterServices = html.split(/services/i).slice(1).join('');
  if (afterServices) {
    const svcHeadings = afterServices.match(/<h[2-4][^>]*>(.*?)<\/h[2-4]>/gi) || [];
    for (const h of svcHeadings.slice(0, 6)) {
      const t = h.replace(/<[^>]+>/g, '').trim();
      if (t.length > 3 && t.length < 80) dna.services_found.push(t);
    }
  }
  dna.services_found = [...new Set(dna.services_found)].slice(0, 8);

  // Ratings
  const ratingMatch = html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)"?/);
  if (ratingMatch) dna.rating = parseFloat(ratingMatch[1]);
  const countMatch = html.match(/"reviewCount"\s*:\s*"?(\d+)"?/);
  if (countMatch) dna.review_count = parseInt(countMatch[1]);

  return dna;
}

// ── Content generation (simplified from content.js for orchestrator use) ──

function generateContentFromInput(biz) {
  const nicheData = getNicheContent(biz.niche || '', biz);
  const name = biz.name;
  const loc = biz.location || 'your area';
  const years = biz.years || '10+';
  const archetype = detectArchetype(biz);
  const config = getArchetypeConfig(archetype);

  // Hero — archetype-aware
  const hero = {
    headline: nicheData.heroHeadline,
    subtext: nicheData.heroSub,
    tag: config.heroTag || (archetype === 'local-service' ? `Licensed & Insured • ${loc}` : null),
    cta_primary: config.labels.cta,
    cta_secondary: config.labels.services,
  };

  // Services
  const services = enhanceServices(biz.services, nicheData);

  // Testimonials
  const testimonials = nicheData.testimonials.map(t => ({
    text: t.text,
    author: t.author,
    role: t.role,
    rating: 5,
  }));

  // About
  const aboutText = nicheData.aboutText;
  const about = {
    heading: 'Real people. Real work. No shortcuts.',
    paragraphs: aboutText.split('\\n').filter(Boolean).map(p => p.trim()),
    values: [
      { title: 'Honest Pricing', desc: 'The price we quote is the price you pay. Period.' },
      { title: 'Licensed & Insured', desc: 'Full coverage. Full compliance. Zero worry.' },
      { title: 'Quality Guarantee', desc: 'We stand behind every job we do.' },
      { title: 'Clean & Professional', desc: 'We treat your property with respect.' },
    ],
  };

  // CTA
  const cta = {
    heading: 'Let\'s talk about your project.',
    subtext: 'No pressure, no obligation. Call us or send an email and we\'ll get back to you within 24 hours.',
    button_text: 'Get Your Free Quote',
  };

  // Meta
  const meta = {
    title: `${name} — ${capitalizeWords(biz.niche || 'Professional Services')} in ${loc}`,
    description: `${name} provides trusted ${biz.niche || 'professional'} services in ${loc}. ${years} years of experience. Call for a free estimate.`,
  };

  // Stats
  const stats = [
    { number: years, label: 'Years Experience' },
    { number: '4.9', label: 'Star Rating' },
    { number: '500+', label: 'Projects Done' },
    { number: 'A+', label: 'BBB Rated' },
    { number: '100%', label: 'Licensed & Insured' },
  ];

  return { hero, services, testimonials, about, cta, meta, stats, generated_at: new Date().toISOString() };
}

// ── Niche content (same as generate.js) ───────────────────────

function getNicheContent(niche, biz) {
  const name = biz.name;
  const loc = biz.location || 'your area';
  const years = biz.years || '10+';

  const niches = {
    'roofing': {
      heroHeadline: 'The roof over your family deserves better.',
      heroSub: `${name} has protected homes across ${loc} for ${years} years. When it's time for a roof that lasts, you call the team that stands behind every shingle.`,
      services: [
        { name: 'Roof Replacement', desc: 'Complete tear-off and install with manufacturer-backed warranties. We handle permits, disposal, everything.' },
        { name: 'Storm Damage Repair', desc: 'Hail, wind, fallen branches — we respond fast and work directly with your insurance company.' },
        { name: 'Roof Inspections', desc: 'Catch small problems before they become expensive ones. Detailed reports with photos and recommendations.' },
        { name: 'Leak Detection & Repair', desc: 'Persistent leak? We track it to the source and fix it right the first time.' },
        { name: 'Gutter Systems', desc: 'Seamless aluminum gutters installed and integrated with your roofing system for complete water management.' },
        { name: 'Commercial Roofing', desc: 'Flat roofs, TPO, EPDM, metal — we handle commercial properties of every size.' },
      ],
      aboutText: `${name} started with a simple belief: every homeowner deserves honest answers about their roof.\\nWe're fully licensed, insured, and every job comes with our written satisfaction guarantee.`,
      testimonials: [
        { text: 'They replaced our entire roof in a day and a half. Showed up when they said, kept the yard clean, and the price was exactly what they quoted.', author: 'Mike R.', role: `Homeowner, ${loc}` },
        { text: `After the storm, five roofers knocked on our door. ${name} was the only one who didn't try to upsell us.`, author: 'Sarah T.', role: `Homeowner, ${loc}` },
        { text: 'Used them for our warehouse roof. Professional crew, on schedule, and the foreman kept us updated every step.', author: 'David L.', role: 'Business Owner' },
      ],
    },
    'plumbing': {
      heroHeadline: 'When water goes where it shouldn\'t, you need someone who answers the phone.',
      heroSub: `${name} has been the first call for ${loc} homeowners for ${years} years. Fast response. Fair pricing. Plumbing that actually works when we leave.`,
      services: [
        { name: 'Emergency Plumbing', desc: 'Burst pipe at 2am? We answer 24/7 and typically arrive within the hour.' },
        { name: 'Drain Cleaning', desc: 'Slow drains, backups, root intrusion — we clear the blockage and camera-inspect the line.' },
        { name: 'Water Heater Service', desc: 'Repair or replacement for tank and tankless systems. Same-day install available.' },
        { name: 'Leak Detection', desc: 'Electronic leak detection finds hidden leaks behind walls and under slabs.' },
        { name: 'Repiping', desc: 'Whole-house repiping with copper or PEX. Planned around your schedule.' },
        { name: 'Fixture Installation', desc: 'Faucets, toilets, garbage disposals — installed correctly and warranted.' },
      ],
      aboutText: `${name} was built on the idea that plumbing shouldn't be a mystery.\\nEvery plumber on our team is licensed, background-checked, and trained to treat your home like their own.`,
      testimonials: [
        { text: 'Basement flooding on a Sunday night. They were at our door in 40 minutes. Fixed the issue, cleaned up, even left boot covers at the door.', author: 'Jennifer K.', role: `Homeowner, ${loc}` },
        { text: `Got three quotes for repiping. ${name} wasn't the cheapest, but they were the only ones who explained what they were doing and why.`, author: 'Robert M.', role: `Homeowner, ${loc}` },
        { text: 'We use them for all six of our rental properties. Reliable, communicative, exactly what a landlord needs.', author: 'Lisa P.', role: 'Property Manager' },
      ],
    },
    'hvac': {
      heroHeadline: 'Comfortable home. Controlled costs. No excuses.',
      heroSub: `${name} keeps ${loc} homes at the right temperature year-round. ${years} years of installs, repairs, and maintenance.`,
      services: [
        { name: 'AC Repair & Service', desc: 'Fast diagnosis and repair for all makes. Most repairs completed same-day.' },
        { name: 'Furnace & Heating', desc: 'Tune-ups, repairs, and full system replacements for gas, electric, and heat pump.' },
        { name: 'New System Installation', desc: 'Right-sized equipment, proper ductwork, and manufacturer rebates.' },
        { name: 'Preventive Maintenance', desc: 'Bi-annual tune-ups that extend equipment life and catch problems early.' },
        { name: 'Duct Cleaning & Sealing', desc: 'Improve airflow, reduce dust, and lower energy bills.' },
        { name: 'Indoor Air Quality', desc: 'Air purifiers, humidifiers, UV filtration for healthier breathing.' },
      ],
      aboutText: `${name} has been keeping ${loc} comfortable since day one.\\nOur technicians are NATE-certified and arrive in marked vehicles. ${years} years of doing this right.`,
      testimonials: [
        { text: 'AC died in July. They had a new system in by the next morning. The tech showed me the smart thermostat before he left.', author: 'Tom A.', role: `Homeowner, ${loc}` },
        { text: 'Three years on their maintenance plan. Haven\'t had a single breakdown.', author: 'Nancy W.', role: `Homeowner, ${loc}` },
        { text: 'Replaced our restaurant\'s entire HVAC system without closing us for a single day.', author: 'Carlos M.', role: 'Restaurant Owner' },
      ],
    },
    'electrical': {
      heroHeadline: 'Safe wiring. Smart upgrades. No shortcuts.',
      heroSub: `${name} delivers licensed, code-compliant electrical work across ${loc}. ${years} years of experience.`,
      services: [
        { name: 'Panel Upgrades', desc: 'Upgrade from 100-amp to 200-amp service for modern appliances and EV chargers.' },
        { name: 'Wiring & Rewiring', desc: 'Knob-and-tube replacement, whole-house rewiring, new construction wiring.' },
        { name: 'Lighting Design', desc: 'Recessed, under-cabinet, landscape lighting designed to look great and function perfectly.' },
        { name: 'Generator Installation', desc: 'Whole-home standby generators with automatic transfer switches.' },
        { name: 'EV Charger Installation', desc: 'Level 2 charger installation for all EV models. Proper permitting included.' },
        { name: 'Troubleshooting', desc: 'Flickering lights, tripped breakers, dead outlets — we find the fault and fix it safely.' },
      ],
      aboutText: `${name} was founded on one principle: electrical work is either done safely or it's done wrong.\\nEvery electrician on our team is a licensed journeyman or master electrician.`,
      testimonials: [
        { text: 'They rewired our 1960s home without destroying the plaster walls. Meticulous about patching and cleanup.', author: 'Amanda R.', role: `Homeowner, ${loc}` },
        { text: 'Installed a Tesla charger and upgraded our panel on the same visit. Professional and on budget.', author: 'Brian K.', role: `Homeowner, ${loc}` },
        { text: `We've used ${name} for three commercial buildouts. Work passes inspection the first time, every time.`, author: 'Mark S.', role: 'General Contractor' },
      ],
    },
    // ── Creative / Artist / Music archetypes ──
    'photography': {
      heroHeadline: 'Moments worth remembering.',
      heroSub: `${name} captures the stories that matter most. From intimate portraits to full-scale events, every frame is intentional.`,
      services: [
        { name: 'Portrait Sessions', desc: 'Studio and outdoor portraits that feel natural, not posed.' },
        { name: 'Event Photography', desc: 'Weddings, corporate events, celebrations — captured as they unfold.' },
        { name: 'Commercial Work', desc: 'Product shots, headshots, brand photography that tells your story.' },
        { name: 'Photo Editing', desc: 'Professional retouching and color grading that matches your vision.' },
      ],
      aboutText: `${name} has been behind the lens for ${years} years. Every shoot starts with listening — understanding what you want to remember, and then making it happen.`,
      testimonials: [
        { text: 'The photos from our wedding still make me cry. In the best way.', author: 'Rachel & Mike', role: 'Wedding Clients' },
        { text: `${name} made our whole team look like we actually enjoy our jobs. Which we do, but you know.`, author: 'Sarah L.', role: 'Marketing Director' },
        { text: 'Finally, headshots I don\'t hate. Natural, professional, and I actually look like myself.', author: 'James K.', role: 'Client' },
      ],
    },
    'musician': {
      heroHeadline: 'Feel the music.',
      heroSub: `${name} brings unforgettable live performance and original sound to every venue and event.`,
      services: [
        { name: 'Live Performance', desc: 'Solo, duo, or full band — tailored to your event and venue.' },
        { name: 'Original Music', desc: 'Original compositions and arrangements for any occasion.' },
        { name: 'Session Work', desc: 'Studio recording, session playing, and collaboration.' },
        { name: 'Music Lessons', desc: 'Private and group lessons for all skill levels.' },
      ],
      aboutText: `${name} has been making music for ${years} years. From dive bars to concert halls, the goal is always the same — make people feel something real.`,
      testimonials: [
        { text: 'They played our wedding and every single guest was on the dance floor. Absolute magic.', author: 'Amy & Chris', role: 'Wedding' },
        { text: 'Booked them for our corporate event. Professional, engaging, and the perfect vibe.', author: 'Mark T.', role: 'Event Planner' },
        { text: 'Incredible talent and genuinely great people to work with.', author: 'Nina R.', role: 'Venue Manager' },
      ],
    },
    // ── Food / Restaurant archetypes ──
    'restaurant': {
      heroHeadline: 'Come hungry. Leave happy.',
      heroSub: `${name} has been a neighborhood favorite in ${loc} for ${years} years. Fresh ingredients, made-from-scratch recipes, and a table that feels like home.`,
      services: [
        { name: 'Dinner Service', desc: 'Seasonal menu featuring locally sourced ingredients and bold flavors.' },
        { name: 'Weekend Brunch', desc: 'Handmade pastries, farm-fresh eggs, bottomless coffee, and no rush.' },
        { name: 'Private Events', desc: 'Birthdays, anniversaries, corporate dinners — our space, your celebration.' },
        { name: 'Catering', desc: 'Full-service catering with the same quality you get at our table.' },
        { name: 'Takeout & Delivery', desc: 'Your favorites, packaged with care and ready when you are.' },
      ],
      aboutText: `${name} started with a simple idea: good food shouldn't be complicated.\\nEvery dish on our menu is made with care, from scratch, using ingredients we believe in.`,
      testimonials: [
        { text: 'This is our go-to spot. The pasta alone is worth the drive. Staff remembers your name after one visit.', author: 'Laura M.', role: `Regular, ${loc}` },
        { text: 'Hosted my wife\'s birthday here. They went above and beyond — custom menu, perfect setup. She loved it.', author: 'David P.', role: 'Guest' },
        { text: 'Best brunch in the area. The sourdough pancakes are unreal.', author: 'Kim S.', role: `Local, ${loc}` },
      ],
    },
    // ── Health / Wellness archetypes ──
    'dental': {
      heroHeadline: 'A smile you actually feel good about.',
      heroSub: `${name} provides gentle, judgment-free dental care for the whole family. ${years} years of building healthy smiles in ${loc}.`,
      services: [
        { name: 'Cleanings & Exams', desc: 'Thorough cleanings, digital x-rays, and personalized care plans.' },
        { name: 'Cosmetic Dentistry', desc: 'Whitening, veneers, and smile makeovers that look natural.' },
        { name: 'Restorative Care', desc: 'Crowns, bridges, implants — designed to last and feel like your own teeth.' },
        { name: 'Emergency Care', desc: 'Same-day emergency appointments for pain, trauma, or broken teeth.' },
      ],
      aboutText: `${name} was built on the belief that everyone deserves a dentist they're not afraid of.\\nWe use the latest technology to make every visit as comfortable and efficient as possible.`,
      testimonials: [
        { text: 'I hadn\'t been to a dentist in 8 years. They made me feel zero judgment and got me back on track.', author: 'Ryan M.', role: `Patient, ${loc}` },
        { text: 'My kids actually look forward to their appointments. That says everything.', author: 'Jessica T.', role: `Parent, ${loc}` },
        { text: 'Got veneers done here. The result looks completely natural. Best decision I\'ve made.', author: 'Amanda R.', role: 'Patient' },
      ],
    },
    'salon': {
      heroHeadline: 'Your look. Your rules. Our expertise.',
      heroSub: `${name} is where great style meets genuine care. Walk in feeling fine. Walk out feeling incredible. Serving ${loc} for ${years} years.`,
      services: [
        { name: 'Haircuts & Styling', desc: 'Precision cuts and styles tailored to your face shape, lifestyle, and personality.' },
        { name: 'Color & Highlights', desc: 'From subtle balayage to bold transformations — always healthy, always beautiful.' },
        { name: 'Treatments', desc: 'Deep conditioning, keratin smoothing, scalp treatments for healthier hair.' },
        { name: 'Special Occasions', desc: 'Wedding updos, event styling, blowouts — look your best when it matters most.' },
      ],
      aboutText: `${name} was founded on the idea that a great salon experience is about more than just the cut.\\nOur stylists listen first, then create something that works for your real life.`,
      testimonials: [
        { text: 'Best color I\'ve ever had. She actually listened to what I wanted instead of doing her own thing.', author: 'Megan L.', role: `Client, ${loc}` },
        { text: 'Been coming here for 3 years. Wouldn\'t trust my hair with anyone else.', author: 'Taylor K.', role: 'Regular Client' },
        { text: 'Got my wedding updo done here. It lasted all night and I felt incredible.', author: 'Sophie R.', role: 'Bride' },
      ],
    },
    // ── Professional archetypes ──
    'law': {
      heroHeadline: 'Experienced counsel when you need it most.',
      heroSub: `${name} has represented clients across ${loc} for ${years} years. Straightforward advice. Strong advocacy. Results that matter.`,
      services: [
        { name: 'Personal Injury', desc: 'Accidents, slip-and-falls, wrongful death — we fight for fair compensation.' },
        { name: 'Family Law', desc: 'Divorce, custody, adoption — compassionate guidance through difficult transitions.' },
        { name: 'Business Law', desc: 'Contracts, disputes, formations — protecting your business interests.' },
        { name: 'Estate Planning', desc: 'Wills, trusts, powers of attorney — securing your family\'s future.' },
      ],
      aboutText: `${name} was founded on the principle that good legal representation shouldn't be reserved for corporations.\\nWe give every client the same thorough, aggressive advocacy — regardless of the size of the case.`,
      testimonials: [
        { text: 'After my accident, they handled everything while I focused on recovery. Settlement exceeded my expectations.', author: 'Michael R.', role: 'Client' },
        { text: 'Guided us through a complex custody situation with compassion and clarity. Can\'t thank them enough.', author: 'Jennifer H.', role: `Client, ${loc}` },
        { text: 'Sharp, responsive, and they actually return your calls. Novel concept for a law firm.', author: 'David K.', role: 'Business Client' },
      ],
    },
    'real-estate': {
      heroHeadline: `Your next chapter in ${loc} starts here.`,
      heroSub: `${name} helps buyers find their dream home and sellers get top dollar. ${years} years of local market expertise and honest guidance.`,
      services: [
        { name: 'Home Buying', desc: 'Full-service representation from search to closing. We negotiate hard so you don\'t have to.' },
        { name: 'Home Selling', desc: 'Professional staging, marketing, and pricing strategy to sell fast and for more.' },
        { name: 'Market Analysis', desc: 'Data-driven pricing based on comparable sales and current market conditions.' },
        { name: 'Investment Property', desc: 'Multi-family, rentals, flips — we help investors identify and close on the right opportunities.' },
      ],
      aboutText: `${name} has been helping families in ${loc} find their perfect home for ${years} years.\\nWe're not about the hard sell. We're about the right fit.`,
      testimonials: [
        { text: 'Found us our dream home in a competitive market. Their negotiation skills saved us $30K.', author: 'The Martinez Family', role: `Buyers, ${loc}` },
        { text: 'Sold our house in 5 days, $15K over asking. Their marketing strategy was incredible.', author: 'Robert & Carol T.', role: `Sellers, ${loc}` },
        { text: 'Best realtor experience we\'ve ever had. Responsive, knowledgeable, and genuinely cares.', author: 'James W.', role: 'First-Time Buyer' },
      ],
    },
  };

  const n = niche.toLowerCase();
  if (niches[n]) return niches[n];
  // Check partial matches for custom niche names
  for (const [key, val] of Object.entries(niches)) {
    if (n.includes(key) || key.includes(n)) return val;
  }

  // Generic — detect archetype for better fallback
  const arch = detectArchetype(biz);
  if (arch === 'creative') {
    return {
      heroHeadline: `${niche ? capitalizeWords(niche) + '. ' : ''}Done differently.`,
      heroSub: `${name} brings a fresh perspective to every project. ${years} years of creative work that speaks for itself.`,
      services: [
        { name: 'Creative Direction', desc: 'Vision, concept, and execution from start to finish.' },
        { name: 'Custom Projects', desc: 'Tailored work that fits your specific vision and goals.' },
        { name: 'Collaboration', desc: 'Working together to bring ideas to life with purpose.' },
        { name: 'Consultation', desc: 'Let\'s talk about your project over coffee.' },
      ],
      aboutText: `${name} has been creating for ${years} years.\\nEvery project is a chance to make something meaningful.`,
      testimonials: [
        { text: 'Genuinely talented and a pleasure to work with. The final result blew everyone away.', author: 'Alex P.', role: 'Client' },
        { text: `${name} brought a vision we didn't know we had. Exceeded every expectation.`, author: 'Jordan M.', role: 'Collaborator' },
        { text: 'Professional, creative, and delivers on time. What more could you want?', author: 'Sam K.', role: 'Client' },
      ],
    };
  }
  if (arch === 'food') {
    return {
      heroHeadline: 'Good food. Great people. No pretense.',
      heroSub: `${name} has been feeding ${loc} for ${years} years. Every plate is made with care, from scratch, with the best ingredients we can find.`,
      services: [
        { name: 'Dine In', desc: 'A warm, welcoming space with food that makes you want to come back.' },
        { name: 'Takeout', desc: 'Your favorites, packaged with care and ready when you are.' },
        { name: 'Catering', desc: 'Full-service catering for events of any size.' },
        { name: 'Private Events', desc: 'Our space, your celebration. Custom menus available.' },
      ],
      aboutText: `${name} started with a simple belief: food should be honest, satisfying, and made with love.\\nWe've been a ${loc} favorite for ${years} years.`,
      testimonials: [
        { text: 'Our favorite spot. Everything on the menu is incredible and the staff remembers you.', author: 'Laura K.', role: `Regular, ${loc}` },
        { text: 'Catered our company event — everyone raved about the food for weeks.', author: 'Tom R.', role: 'Client' },
        { text: 'This place feels like home. If home had better food and someone else did the dishes.', author: 'Nina S.', role: 'Regular' },
      ],
    };
  }
  return {
    heroHeadline: `The kind of ${niche || 'service'} you'll actually recommend to friends.`,
    heroSub: `${name} has served ${loc} for ${years} years. One job at a time — showing up on time, doing honest work, standing behind every project.`,
    services: [
      { name: 'Core Service', desc: 'Our primary offering, delivered with quality and attention to detail.' },
      { name: 'Consultation', desc: 'Free assessment. Honest estimate. No obligations.' },
      { name: 'Emergency Work', desc: 'When things can\'t wait, neither do we. Rapid response.' },
      { name: 'Maintenance', desc: 'Preventive maintenance keeps small issues from becoming big problems.' },
      { name: 'Custom Solutions', desc: 'Every project is different. We tailor our approach to fit your situation.' },
      { name: 'Full Support', desc: 'From planning to execution to follow-up. Complete peace of mind.' },
    ],
    aboutText: `${name} was built on a simple idea: do great work, charge a fair price, and treat every customer right.\\nWe've been serving ${loc} for ${years} years.`,
    testimonials: [
      { text: 'Professional from start to finish. Showed up on time, did what they said, price matched the quote.', author: 'Sarah M.', role: `Customer, ${loc}` },
      { text: `We've used ${name} twice now. Both times they went above and beyond.`, author: 'David R.', role: 'Homeowner' },
      { text: 'Honest, reliable, skilled. No gimmicks, no pressure. Just solid work.', author: 'Karen L.', role: `Customer, ${loc}` },
    ],
  };
}

function enhanceServices(rawServices, nicheContent) {
  if (!rawServices) return nicheContent.services;
  const userServices = rawServices.split(',').map(s => s.trim()).filter(Boolean);
  const result = userServices.map(name => {
    const match = nicheContent.services.find(ns =>
      ns.name.toLowerCase().includes(name.toLowerCase()) ||
      name.toLowerCase().includes(ns.name.toLowerCase().split(' ')[0].toLowerCase())
    );
    return { name: capitalizeWords(name), desc: match ? match.desc : `Expert ${name.toLowerCase()} service backed by our quality guarantee.` };
  });
  let i = 0;
  while (result.length < 4 && i < nicheContent.services.length) {
    const fallback = nicheContent.services[i];
    if (!result.find(r => r.name.toLowerCase() === fallback.name.toLowerCase())) result.push(fallback);
    i++;
  }
  return result.slice(0, 6);
}

function capitalizeWords(str) { return (str || '').replace(/\b\w/g, c => c.toUpperCase()); }

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  if (h.length < 6) return '0,0,0';
  return `${parseInt(h.substring(0, 2), 16)},${parseInt(h.substring(2, 4), 16)},${parseInt(h.substring(4, 6), 16)}`;
}

function darkenHex(hex, percent) {
  const h = hex.replace('#', '');
  if (h.length < 6) return hex;
  const r = Math.max(0, parseInt(h.substring(0, 2), 16) - Math.round(255 * percent / 100));
  const g = Math.max(0, parseInt(h.substring(2, 4), 16) - Math.round(255 * percent / 100));
  const b = Math.max(0, parseInt(h.substring(4, 6), 16) - Math.round(255 * percent / 100));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ── Industry Archetype System ──────────────────────────────────
//
// Instead of one layout for all businesses, we classify into archetypes
// and select different components, visual variables, and content framing.

function detectArchetype(biz) {
  const niche = (biz.niche || '').toLowerCase();
  const siteType = (biz.siteType || '').toLowerCase();
  const notes = (biz.notes || '').toLowerCase();
  const name = (biz.name || '').toLowerCase();

  // Creative / Artist / Musician
  const creativeNiches = ['photography', 'videography', 'music', 'musician', 'artist', 'design', 'graphic', 'filmmaker', 'dj', 'band', 'producer', 'creative', 'art', 'illustration', 'tattoo'];
  if (creativeNiches.some(n => niche.includes(n) || notes.includes(n) || name.includes(n)) || siteType === 'portfolio') {
    return 'creative';
  }

  // Restaurant / Food / Hospitality
  const foodNiches = ['restaurant', 'cafe', 'bakery', 'catering', 'bar', 'food', 'chef', 'bistro', 'pizzeria', 'brewery', 'coffee'];
  if (foodNiches.some(n => niche.includes(n) || notes.includes(n))) {
    return 'food';
  }

  // Health / Wellness / Beauty
  const healthNiches = ['dental', 'chiropractic', 'fitness', 'personal training', 'salon', 'barbershop', 'spa', 'massage', 'yoga', 'therapy', 'medical', 'clinic', 'vet', 'wellness', 'skincare'];
  if (healthNiches.some(n => niche.includes(n) || notes.includes(n))) {
    return 'wellness';
  }

  // Professional / B2B / Corporate
  const proNiches = ['law', 'legal', 'accounting', 'bookkeeping', 'consulting', 'insurance', 'real-estate', 'realtor', 'financial', 'marketing', 'agency', 'tech', 'software', 'it-services'];
  if (proNiches.some(n => niche.includes(n) || notes.includes(n))) {
    return 'professional';
  }

  // E-commerce / Retail
  const retailNiches = ['ecommerce', 'shop', 'store', 'retail', 'boutique', 'fashion', 'jewelry'];
  if (retailNiches.some(n => niche.includes(n) || notes.includes(n)) || siteType === 'ecommerce') {
    return 'ecommerce';
  }

  // Nonprofit
  if (niche.includes('nonprofit') || niche.includes('charity') || niche.includes('foundation')) {
    return 'nonprofit';
  }

  // Default: Local Service (trades, home services, auto, etc.)
  return 'local-service';
}

// Each archetype defines: component order, hero style, visual vars, section labels
function getArchetypeConfig(archetype) {
  const configs = {
    'creative': {
      heroStyle: 'fullscreen',    // full-bleed visual hero
      sections: ['hero', 'portfolio-grid', 'about-story', 'testimonials', 'contact-simple'],
      labels: { services: 'Work', about: 'The Story', reviews: 'Kind Words', cta: 'Let\'s Create' },
      visual: { align: 'center', btnRadius: '100px', headingWeight: '300', spacing: 'airy', navStyle: 'minimal' },
      heroTag: null, // no badge for creatives
      showStats: false,
      showTrustBar: false,
    },
    'food': {
      heroStyle: 'split-image',   // image-forward with atmosphere
      sections: ['hero', 'featured-items', 'about-story', 'gallery', 'testimonials', 'hours-location', 'cta'],
      labels: { services: 'Menu Highlights', about: 'Our Story', reviews: 'What Guests Say', cta: 'Reserve a Table' },
      visual: { align: 'center', btnRadius: '4px', headingWeight: '400', spacing: 'cozy', navStyle: 'classic' },
      heroTag: null,
      showStats: false,
      showTrustBar: false,
    },
    'wellness': {
      heroStyle: 'calm',          // soft, inviting, warm
      sections: ['hero', 'services', 'how-it-works', 'about', 'testimonials', 'booking-cta'],
      labels: { services: 'Services', about: 'About Us', reviews: 'Patient Reviews', cta: 'Book Your Appointment' },
      visual: { align: 'left', btnRadius: '8px', headingWeight: '400', spacing: 'balanced', navStyle: 'classic' },
      heroTag: 'Welcoming New Patients',
      showStats: true,
      showTrustBar: false,
    },
    'professional': {
      heroStyle: 'corporate',     // clean, authoritative
      sections: ['hero', 'services', 'process-steps', 'about', 'testimonials', 'cta'],
      labels: { services: 'Practice Areas', about: 'About the Firm', reviews: 'Client Testimonials', cta: 'Schedule a Consultation' },
      visual: { align: 'left', btnRadius: '6px', headingWeight: '600', spacing: 'tight', navStyle: 'corporate' },
      heroTag: 'Trusted Advisors',
      showStats: true,
      showTrustBar: true,
    },
    'ecommerce': {
      heroStyle: 'product-showcase',
      sections: ['hero', 'featured-products', 'features', 'testimonials', 'cta'],
      labels: { services: 'Featured', about: 'Our Brand', reviews: 'Customer Reviews', cta: 'Shop Now' },
      visual: { align: 'center', btnRadius: '8px', headingWeight: '500', spacing: 'balanced', navStyle: 'classic' },
      heroTag: 'Free Shipping on Orders $50+',
      showStats: false,
      showTrustBar: false,
    },
    'nonprofit': {
      heroStyle: 'mission',
      sections: ['hero', 'impact-stats', 'about-story', 'how-to-help', 'testimonials', 'cta'],
      labels: { services: 'How We Help', about: 'Our Mission', reviews: 'Impact Stories', cta: 'Get Involved' },
      visual: { align: 'center', btnRadius: '8px', headingWeight: '400', spacing: 'airy', navStyle: 'classic' },
      heroTag: null,
      showStats: true,
      showTrustBar: false,
    },
    'local-service': {
      heroStyle: 'trust',         // stats card, trust badges
      sections: ['hero', 'trust-bar', 'services', 'about', 'testimonials', 'cta'],
      labels: { services: 'Our Services', about: 'About Us', reviews: 'Reviews', cta: 'Get a Free Quote' },
      visual: { align: 'left', btnRadius: '8px', headingWeight: '400', spacing: 'balanced', navStyle: 'classic' },
      heroTag: null,// set dynamically
      showStats: true,
      showTrustBar: true,
    },
  };
  return configs[archetype] || configs['local-service'];
}

function buildPreviewPage(biz, content) {
  const archetype = detectArchetype(biz);
  const config = getArchetypeConfig(archetype);
  const t = getTheme(biz.style, archetype);

  // Apply discovery intelligence if available — override fonts/colors from real-world sites
  if (biz.designIntel?.aggregate) {
    const agg = biz.designIntel.aggregate;
    // Use discovered font pairings if available
    if (agg.popular_fonts?.length >= 2) {
      const discoveredHead = agg.popular_fonts[0];
      const discoveredBody = agg.popular_fonts[1];
      // Only override if they are Google Fonts (have proper names)
      if (discoveredHead && discoveredHead.length > 2 && !/system|inherit|sans-serif|serif|mono/i.test(discoveredHead)) {
        t.fontHead = `'${discoveredHead}', ${t.fontHead}`;
        t.font = `'${discoveredBody || discoveredHead}', ${t.font}`;
        const gFontHead = discoveredHead.replace(/\s/g, '+');
        const gFontBody = (discoveredBody || '').replace(/\s/g, '+');
        if (gFontBody && gFontBody !== gFontHead) {
          t.gFont = `${gFontHead}:wght@400;500;600;700&family=${gFontBody}:wght@300;400;500;600`;
        } else {
          t.gFont = `${gFontHead}:wght@300;400;500;600;700`;
        }
      }
    }
    // Use discovered accent color if available and different from archetype default
    if (agg.dominant_colors?.length >= 1) {
      const discovered = agg.dominant_colors[0];
      if (discovered && discovered.startsWith('#') && discovered !== t.accent) {
        t.accent = discovered;
        t.accentHover = darkenHex(discovered, 15);
        t.accentBg = discovered.replace('#', 'rgba(') ? `rgba(${hexToRgb(discovered)},0.06)` : t.accentBg;
      }
    }
  }

  const name = esc(biz.name);
  const phone = esc(biz.phone || '');
  const phoneHref = (biz.phone || '').replace(/[^0-9+]/g, '');
  const loc = esc(biz.location || 'Your Area');
  const years = esc(biz.years || '10+');
  const contactEmail = esc(biz.email || '');
  const year = new Date().getFullYear();
  const isDark = biz.style === 'bold-dark';
  const v = config.visual;
  const labels = config.labels;
  const hero = content.hero || {};
  const services = content.services || [];
  const testimonials = content.testimonials || [];
  const stats = content.stats || [];
  const ctaContent = content.cta || {};
  const about = content.about || {};
  const aboutParas = (about.paragraphs || []).join('<br><br>');

  // Archetype-aware nav links
  const navLinks = archetype === 'creative'
    ? `<a href="#work">${labels.services}</a><a href="#about">${labels.about}</a><a href="#contact">Contact</a>`
    : archetype === 'food'
    ? `<a href="#menu">${labels.services}</a><a href="#about">${labels.about}</a><a href="#visit">Visit</a>`
    : `<a href="#services">${labels.services}</a><a href="#about">${labels.about}</a><a href="#reviews">${labels.reviews}</a>`;

  // Nav CTA varies by archetype
  const navCta = archetype === 'creative'
    ? `<a href="#contact" class="nav-cta">Get in Touch</a>`
    : archetype === 'food'
    ? (phone ? `<a href="tel:${phoneHref}" class="nav-cta">Reserve</a>` : `<a href="#visit" class="nav-cta">Visit Us</a>`)
    : archetype === 'wellness'
    ? `<a href="#contact" class="nav-cta">Book Now</a>`
    : phone ? `<a href="tel:${phoneHref}" class="nav-cta">${phone}</a>` : '';

  // Build sections based on archetype config
  const sectionHtml = config.sections.map(section => {
    switch(section) {
      case 'hero': return buildHeroSection(archetype, config, { name, phone, phoneHref, loc, years, isDark, hero, stats, t, v, labels });
      case 'trust-bar': return config.showTrustBar ? buildTrustBar(stats, t) : '';
      case 'services': return buildServicesSection(services, { loc, isDark, v, labels, t });
      case 'portfolio-grid': return buildPortfolioSection(services, { name, v, labels });
      case 'featured-items': return buildFeaturedItems(services, { v, labels, isDark, t });
      case 'how-it-works': return buildHowItWorks(biz, { v, labels });
      case 'process-steps': return buildProcessSteps(biz, { v, labels });
      case 'about': case 'about-story': return buildAboutSection(about, { name, years, loc, aboutParas, v, labels, config, isDark, t });
      case 'testimonials': return buildTestimonialsSection(testimonials, { v, labels, isDark, t });
      case 'gallery': return buildGallerySection({ name, v });
      case 'hours-location': return buildHoursLocation({ name, phone, phoneHref, loc, contactEmail });
      case 'booking-cta': return buildBookingCta({ name, phone, phoneHref, contactEmail, labels });
      case 'contact-simple': return buildContactSimple({ name, phone, phoneHref, contactEmail, loc });
      case 'impact-stats': return config.showStats ? buildTrustBar(stats, t) : '';
      case 'how-to-help': return buildHowItWorks(biz, { v, labels });
      case 'featured-products': return buildFeaturedItems(services, { v, labels, isDark, t });
      case 'features': return buildHowItWorks(biz, { v, labels });
      case 'cta': return buildCtaSection(ctaContent, { name, phone, phoneHref, contactEmail, v, labels, isDark, t });
      default: return '';
    }
  }).join('\n');

  // Archetype-specific CSS overrides for truly different layouts
  const svcCols = t.svcCols || 3;
  const cardR = t.cardRadius || '14px';
  const headingWeight = archetype === 'creative' ? '300' : archetype === 'food' ? '400' : archetype === 'professional' ? '400' : '700';
  const headingSize = archetype === 'creative' ? '56px' : archetype === 'food' ? '48px' : '44px';
  const heroH1Style = archetype === 'creative'
    ? 'font-weight:300;letter-spacing:-.03em;text-transform:none'
    : archetype === 'food'
    ? 'font-weight:400;font-style:italic;letter-spacing:-.01em'
    : archetype === 'wellness'
    ? 'font-weight:400;letter-spacing:-.015em'
    : archetype === 'professional'
    ? 'font-weight:700;letter-spacing:-.02em'
    : 'font-weight:800;letter-spacing:-.02em;text-transform:none';
  const svcCardStyle = archetype === 'food'
    ? 'border:none;border-bottom:1px solid var(--border);border-radius:0;padding:24px 0;background:transparent'
    : archetype === 'creative'
    ? 'border:none;border-radius:0;padding:32px 0;background:transparent;border-bottom:1px solid var(--border)'
    : archetype === 'wellness'
    ? `border-radius:${cardR};border:1px solid var(--border);padding:32px;background:var(--card)`
    : `border-radius:${cardR};border:1px solid var(--border);padding:28px;background:var(--card)`;
  const navHeight = archetype === 'creative' ? '72px' : archetype === 'food' ? '56px' : '64px';
  const logoSize = archetype === 'creative' ? '24px' : archetype === 'food' ? '22px' : '20px';
  const logoWeight = archetype === 'creative' ? '600' : archetype === 'food' ? '400' : '400';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name} — ${esc(capitalizeWords(biz.niche || 'Professional Services'))}${loc !== 'Your Area' ? ' in ' + loc : ''}</title>
<meta name="description" content="${esc((content.meta || {}).description || '')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${t.gFont}&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:${t.bg};--bg-alt:${t.bgAlt};--nav:${t.nav};--accent:${t.accent};--accent-hover:${t.accentHover};--accent-bg:${t.accentBg};--accent-bg-solid:${t.accentBgSolid};--trust:${t.trust};--text:${t.text};--text-sec:${t.textSec};--muted:${t.muted};--card:${t.card};--border:${t.border};--font:${t.font};--font-head:${t.fontHead};--r:${v.btnRadius};--rl:${cardR};--heading-weight:${headingWeight}}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased}body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.65;overflow-x:hidden}a{color:inherit;text-decoration:none}img{max-width:100%;display:block}.wrap{max-width:1100px;margin:0 auto;padding:0 24px}
.nav{position:sticky;top:0;z-index:100;background:var(--nav);border-bottom:1px solid var(--border);backdrop-filter:blur(12px)}.nav-inner{max-width:1100px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;height:${navHeight}}.logo{font-family:var(--font-head);font-size:${logoSize};font-weight:${logoWeight};letter-spacing:${archetype === 'creative' ? '0.02em' : '-.02em'}${archetype === 'creative' ? ';text-transform:uppercase' : ''}}.logo span{color:var(--accent)}.nav-links{display:flex;align-items:center;gap:${archetype === 'creative' ? '36px' : '28px'};font-size:${archetype === 'food' ? '13px' : '14px'};color:var(--text-sec)${archetype === 'food' ? ';text-transform:uppercase;letter-spacing:.08em;font-weight:400' : archetype === 'creative' ? ';letter-spacing:.04em' : ''}}.nav-links a{transition:color .2s}.nav-links a:hover{color:var(--text)}.nav-cta{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#fff;padding:${archetype === 'food' ? '8px 18px' : '9px 20px'};border-radius:${archetype === 'food' ? '0' : archetype === 'creative' ? '0' : 'var(--r)'};font-weight:600;font-size:13px;transition:all .2s${archetype === 'food' ? ';border:1px solid var(--accent);background:transparent;color:var(--accent)' : ''}}.nav-cta:hover{background:var(--accent-hover);color:#fff;transform:translateY(-1px)}.nav-toggle{display:none;background:none;border:none;cursor:pointer;padding:6px}.nav-toggle span{display:block;width:20px;height:2px;background:var(--text);margin:4px 0}
.sec-tag{font-size:${archetype === 'food' ? '11px' : '12px'};font-weight:${archetype === 'food' ? '400' : '700'};text-transform:uppercase;letter-spacing:${archetype === 'food' ? '.2em' : '.12em'};color:var(--accent);margin-bottom:${archetype === 'food' ? '12px' : '8px'}${archetype === 'food' ? ';font-family:var(--font)' : ''}}.sec-title{font-family:var(--font-head);font-size:clamp(22px,3.5vw,34px);font-weight:var(--heading-weight);margin-bottom:12px${archetype === 'food' ? ';font-style:italic' : ''}}.sec-desc{font-size:15px;color:var(--text-sec);line-height:1.7;margin-bottom:40px;max-width:540px}
.btn-p{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#fff;padding:${archetype === 'food' ? '16px 36px' : archetype === 'creative' ? '14px 32px' : '14px 28px'};border-radius:${archetype === 'food' ? '0' : archetype === 'creative' ? '0' : 'var(--r)'};font-weight:${archetype === 'food' ? '400' : '600'};font-size:${archetype === 'food' ? '14px' : '15px'};transition:all .25s;border:none;cursor:pointer${archetype === 'food' ? ';letter-spacing:.06em;text-transform:uppercase' : archetype === 'creative' ? ';letter-spacing:.02em' : ''}}.btn-p:hover{background:var(--accent-hover);transform:translateY(-2px);box-shadow:0 8px 24px ${isDark ? 'rgba(200,149,106,.2)' : 'rgba(0,0,0,.12)'}}.btn-o{display:inline-flex;align-items:center;gap:8px;background:transparent;color:var(--text-sec);padding:${archetype === 'food' ? '16px 36px' : '14px 28px'};border-radius:${archetype === 'food' ? '0' : archetype === 'creative' ? '0' : 'var(--r)'};font-weight:500;font-size:15px;border:1px solid var(--border);transition:all .25s;cursor:pointer${archetype === 'food' ? ';letter-spacing:.06em;text-transform:uppercase;font-size:14px' : ''}}.btn-o:hover{border-color:var(--accent);color:var(--accent)}
.hero{padding:${archetype === 'creative' ? '140px 24px 100px' : archetype === 'food' ? '120px 24px 80px' : v.spacing === 'airy' ? '100px 24px 80px' : '80px 24px 64px'};background:${t.heroGrad};position:relative;overflow:hidden;text-align:${v.align}}.hero::after{content:'';position:absolute;top:-30%;right:-15%;width:500px;height:500px;border-radius:50%;background:var(--accent-bg);filter:blur(80px);pointer-events:none;opacity:.7}.hero-inner{max-width:1100px;margin:0 auto;position:relative;z-index:1}.hero-split{display:grid;grid-template-columns:${archetype === 'food' || archetype === 'creative' ? '1fr' : '1.15fr .85fr'};gap:48px;align-items:center;text-align:${archetype === 'food' || archetype === 'creative' ? 'center' : 'left'}}.hero-tag{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:${archetype === 'food' ? '400' : '700'};text-transform:uppercase;letter-spacing:${archetype === 'food' ? '.2em' : '.1em'};color:var(--accent);margin-bottom:16px;padding:${archetype === 'food' ? '0' : '6px 14px'};background:${archetype === 'food' ? 'transparent' : 'var(--accent-bg-solid)'};border-radius:100px;border:${archetype === 'food' ? 'none' : '1px solid var(--accent-bg)'}}.hero h1{font-family:var(--font-head);font-size:clamp(28px,4.5vw,${headingSize});${heroH1Style};line-height:1.12;margin-bottom:20px}.hero-sub{font-size:${archetype === 'food' ? '17px' : '16px'};color:var(--text-sec);line-height:1.75;margin-bottom:32px;max-width:${v.align === 'center' || archetype === 'food' || archetype === 'creative' ? '600px;margin-left:auto;margin-right:auto' : '500px'}}.hero-btns{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:36px;${v.align === 'center' || archetype === 'food' || archetype === 'creative' ? 'justify-content:center' : ''}}.hero-proof{display:flex;align-items:center;gap:14px;${v.align === 'center' || archetype === 'food' || archetype === 'creative' ? 'justify-content:center' : ''}}.hero-stars{color:#f5b731;font-size:15px;letter-spacing:2px}.hero-proof-text{font-size:13px;color:var(--text-sec)}.hero-proof-text strong{color:var(--text)}
.hero-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:32px;box-shadow:0 24px 64px ${isDark ? 'rgba(0,0,0,.4)' : 'rgba(0,0,0,.08)'};position:relative}.hero-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--accent);border-radius:var(--rl) var(--rl) 0 0}.hero-card-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);margin-bottom:20px}.hero-card-stat{font-family:var(--font-head);font-size:52px;line-height:1;margin-bottom:4px}.hero-card-desc{font-size:14px;color:var(--text-sec);margin-bottom:24px}.hero-card-row{display:flex;gap:12px}.hero-card-mini{flex:1;text-align:center;padding:14px 8px;background:var(--accent-bg-solid);border-radius:var(--r);border:1px solid var(--accent-bg)}.hero-card-mini strong{display:block;font-family:var(--font-head);font-size:22px;color:var(--accent)}.hero-card-mini span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.trust{background:var(--trust);padding:${archetype === 'food' ? '16px 24px' : '24px'}}.trust-inner{max-width:1100px;margin:0 auto;display:flex;justify-content:center;gap:${archetype === 'food' ? '60px' : '48px'};flex-wrap:wrap}.trust-item{display:flex;flex-direction:column;align-items:center;gap:2px}.trust-num{font-family:var(--font-head);font-size:${archetype === 'food' ? '20px' : '24px'};color:#fff;font-weight:400}.trust-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.45)}
.sect{padding:${v.spacing === 'airy' ? '100px' : v.spacing === 'tight' ? '60px' : '80px'} 24px}.sect-alt{background:var(--bg-alt)}
.services-grid{display:grid;grid-template-columns:repeat(${svcCols},1fr);gap:${archetype === 'food' ? '0' : '16px'}}.svc-card{${svcCardStyle};transition:all .3s}.svc-card:hover{${archetype === 'food' || archetype === 'creative' ? 'transform:none;border-color:var(--accent)' : 'border-color:var(--accent);transform:translateY(-3px);box-shadow:0 12px 32px ' + (isDark ? 'rgba(0,0,0,.25)' : 'rgba(0,0,0,.06)')}}.svc-icon{width:44px;height:44px;border-radius:${archetype === 'wellness' ? '50%' : 'var(--r)'};background:var(--accent-bg-solid);display:flex;align-items:center;justify-content:center;margin-bottom:16px;color:var(--accent);border:1px solid var(--accent-bg)${archetype === 'food' ? ';display:none' : ''}}.svc-card h3{font-size:${archetype === 'food' ? '18px' : '16px'};font-weight:${archetype === 'food' ? '400' : '600'};margin-bottom:8px${archetype === 'food' ? ';font-family:var(--font-head);font-style:italic' : ''}}.svc-card p{font-size:13px;color:var(--text-sec);line-height:1.65}
.portfolio-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:${archetype === 'creative' ? '4px' : '12px'}}.port-item{aspect-ratio:${archetype === 'creative' ? '3/4' : '1'};background:var(--accent-bg-solid);border-radius:${archetype === 'creative' ? '0' : 'var(--rl)'};border:${archetype === 'creative' ? 'none' : '1px solid var(--accent-bg)'};display:flex;align-items:center;justify-content:center;transition:all .3s;overflow:hidden;position:relative}.port-item:hover{transform:scale(1.02);box-shadow:0 12px 40px ${isDark ? 'rgba(0,0,0,.3)' : 'rgba(0,0,0,.08)'}}.port-item:nth-child(1){grid-column:${archetype === 'creative' ? 'span 1' : 'span 2'};grid-row:${archetype === 'creative' ? 'span 2' : 'span 2'};aspect-ratio:auto}.port-overlay{position:absolute;bottom:0;left:0;right:0;padding:16px;background:linear-gradient(transparent,rgba(0,0,0,.6));color:#fff;${archetype === 'creative' ? 'opacity:0;transition:opacity .3s' : ''}}.port-item:hover .port-overlay{opacity:1}.port-overlay h3{font-size:14px;font-weight:${archetype === 'creative' ? '300' : '600'}}.port-overlay p{font-size:11px;opacity:.8}
.menu-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.menu-item{display:flex;justify-content:space-between;align-items:flex-start;padding:16px 0;border-bottom:1px solid var(--border)}.menu-item h3{font-size:15px;font-weight:600;margin-bottom:4px}.menu-item p{font-size:13px;color:var(--text-sec)}.menu-price{font-family:var(--font-head);font-size:16px;color:var(--accent);white-space:nowrap;margin-left:16px}
.steps-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;counter-reset:steps}.step-card{text-align:center;padding:32px 24px;position:relative}.step-num{width:48px;height:48px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-family:var(--font-head);font-size:20px;font-weight:700;margin:0 auto 16px}.step-card h3{font-size:16px;font-weight:600;margin-bottom:8px}.step-card p{font-size:13px;color:var(--text-sec);line-height:1.65}
.about-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:${archetype === 'food' || archetype === 'creative' ? '1fr' : '1fr 1fr'};gap:56px;align-items:center${archetype === 'food' ? ';text-align:center;max-width:700px' : ''}}.about-img{width:100%;aspect-ratio:4/3;background:var(--accent-bg-solid);border-radius:var(--rl);display:flex;align-items:center;justify-content:center;border:1px solid var(--accent-bg)${archetype === 'food' ? ';display:none' : archetype === 'creative' ? ';display:none' : ''}}.about-img svg{width:100%;height:auto;display:block}.about-text h2{font-family:var(--font-head);font-size:${archetype === 'food' ? '32px' : '28px'};font-weight:var(--heading-weight);margin-bottom:20px${archetype === 'food' ? ';font-style:italic' : ''}}.about-text p{font-size:15px;color:var(--text-sec);line-height:1.8;margin-bottom:16px}.about-stats{display:flex;gap:32px;margin-top:28px;padding-top:24px;border-top:1px solid var(--border)${archetype === 'food' ? ';justify-content:center' : ''}}.about-stat{text-align:center}.about-stat strong{display:block;font-family:var(--font-head);font-size:32px;color:var(--accent)}.about-stat span{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.gallery-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.gallery-item{aspect-ratio:1;background:var(--accent-bg-solid);border-radius:var(--r);border:1px solid var(--accent-bg);display:flex;align-items:center;justify-content:center}.gallery-item svg{width:100%;height:100%;display:block}
.reviews-grid{display:grid;grid-template-columns:repeat(${testimonials.length > 2 ? 3 : testimonials.length},1fr);gap:${archetype === 'food' ? '0' : '16px'}}.review-card{background:${archetype === 'food' ? 'transparent' : 'var(--card)'};border:${archetype === 'food' ? 'none;border-bottom:1px solid var(--border)' : '1px solid var(--border)'};border-radius:${archetype === 'food' ? '0' : 'var(--rl)'};padding:${archetype === 'food' ? '32px 0' : '28px'};display:flex;flex-direction:column${archetype === 'food' ? ';text-align:center' : ''}}.review-stars{color:#f5b731;font-size:14px;letter-spacing:2px;margin-bottom:16px}.review-card blockquote{font-size:${archetype === 'food' ? '16px' : '14px'};color:var(--text-sec);line-height:1.7;margin-bottom:auto;padding-bottom:20px;flex:1;font-style:${archetype === 'creative' || archetype === 'food' ? 'italic' : 'normal'}${archetype === 'food' ? ';font-family:var(--font-head)' : ''}}.review-card cite{font-style:normal;font-size:13px;font-weight:600;display:block;padding-top:16px;border-top:${archetype === 'food' ? 'none' : '1px solid var(--border)'}${archetype === 'food' ? ';text-transform:uppercase;letter-spacing:.1em;font-size:11px;font-weight:400' : ''}}.review-card cite span{font-weight:400;color:var(--muted);font-size:12px;display:block;margin-top:2px}
.hours-box{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:32px;max-width:500px;margin:0 auto}.hours-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:14px}.hours-row:last-child{border:none}
.cta-sect{padding:${archetype === 'food' ? '100px' : '80px'} 24px;background:${archetype === 'food' ? 'var(--trust)' : archetype === 'creative' ? 'var(--text)' : 'var(--bg-alt)'};text-align:center${archetype === 'food' || archetype === 'creative' ? ';color:#fff' : ''}}.cta-inner{max-width:600px;margin:0 auto}.cta-inner h2{font-family:var(--font-head);font-size:clamp(22px,3.5vw,34px);font-weight:var(--heading-weight);margin-bottom:16px${archetype === 'food' ? ';font-style:italic;color:#fff' : archetype === 'creative' ? ';color:#fff;font-weight:300' : ''}}.cta-inner p{font-size:15px;color:${archetype === 'food' || archetype === 'creative' ? 'rgba(255,255,255,.7)' : 'var(--text-sec)'};line-height:1.7;margin-bottom:28px}.cta-btns{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}.cta-sect .btn-p{${archetype === 'food' ? 'background:#fff;color:var(--accent)' : archetype === 'creative' ? 'background:#fff;color:var(--text);border-radius:0' : ''}}.cta-sect .btn-o{${archetype === 'food' || archetype === 'creative' ? 'border-color:rgba(255,255,255,.3);color:rgba(255,255,255,.8)' : ''}}
.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;max-width:800px;margin:0 auto}.contact-info{display:flex;flex-direction:column;gap:16px}.contact-item{display:flex;align-items:flex-start;gap:12px}.contact-item svg{flex-shrink:0;color:var(--accent);margin-top:2px}.contact-item p{font-size:14px;color:var(--text-sec);line-height:1.6}.contact-item a{color:var(--accent)}
footer{padding:48px 24px 32px;border-top:1px solid var(--border)}.footer-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:40px}.footer-brand .logo{margin-bottom:12px;display:inline-block}.footer-brand p{font-size:13px;color:var(--muted);line-height:1.6;max-width:240px}.footer-col h4{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:12px}.footer-col ul{list-style:none}.footer-col li{margin-bottom:6px}.footer-col a{font-size:13px;color:var(--text-sec);transition:color .2s}.footer-col a:hover{color:var(--accent)}.footer-bottom{max-width:1100px;margin:32px auto 0;padding-top:24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}.footer-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--accent);background:var(--accent-bg-solid);padding:4px 10px;border-radius:4px;font-weight:600;border:1px solid var(--accent-bg)}
@media(max-width:900px){.hero-split{grid-template-columns:1fr}.hero-card{display:none}.services-grid,.reviews-grid,.steps-grid{grid-template-columns:1fr 1fr}.portfolio-grid{grid-template-columns:1fr 1fr}.port-item:nth-child(1){grid-column:span 1;grid-row:span 1}.about-inner{grid-template-columns:1fr}.about-img{display:none}.footer-inner{grid-template-columns:1fr 1fr}.footer-brand{grid-column:1/-1}.menu-grid,.contact-grid{grid-template-columns:1fr}.gallery-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:600px){.services-grid,.reviews-grid,.steps-grid,.portfolio-grid{grid-template-columns:1fr}.trust-inner{gap:24px}.nav-links{display:none}.nav-toggle{display:block}.hero{padding:60px 20px 40px}.footer-inner{grid-template-columns:1fr}.footer-bottom{flex-direction:column;gap:8px;text-align:center}.gallery-grid{grid-template-columns:repeat(2,1fr)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}.fu{animation:fadeUp .6s ease both}.fu1{animation-delay:.1s}.fu2{animation-delay:.2s}.fu3{animation-delay:.3s}
</style>
</head>
<body>
<nav class="nav"><div class="nav-inner"><a href="#" class="logo">${name}<span>.</span></a><div class="nav-links">${navLinks}${navCta}</div><button class="nav-toggle"><span></span><span></span><span></span></button></div></nav>
${sectionHtml}
<footer><div class="footer-inner"><div class="footer-brand"><a href="#" class="logo">${name}<span>.</span></a><p>${archetype === 'creative' ? esc(biz.tagline || biz.niche || 'Creative professional') + '.' : `Serving ${loc} ${biz.years ? 'for ' + years + ' years' : 'and surrounding areas'}.`}</p></div><div class="footer-col"><h4>${labels.services}</h4><ul>${services.slice(0, 4).map(s => `<li><a href="#services">${esc(s.name)}</a></li>`).join('')}</ul></div><div class="footer-col"><h4>Company</h4><ul><li><a href="#about">${labels.about}</a></li><li><a href="#reviews">${labels.reviews}</a></li></ul></div><div class="footer-col"><h4>Contact</h4><ul>${phone ? `<li><a href="tel:${phoneHref}">${phone}</a></li>` : ''}${contactEmail ? `<li><a href="mailto:${contactEmail}">${contactEmail}</a></li>` : ''}<li>${loc}</li></ul></div></div><div class="footer-bottom"><span>&copy; ${year} ${name}. All rights reserved.</span><span class="footer-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>Redesigned by <a href="https://velocity.delivery" style="color:inherit;text-decoration:underline;">Velocity</a> &middot; by <a href="https://calyvent.com" target="_blank" style="color:inherit;text-decoration:underline;">Calyvent</a></span></div></footer>
</body></html>`;
}

// ── Section Builders ──────────────────────────────────────────

function buildHeroSection(archetype, config, d) {
  const tag = config.heroTag || (archetype === 'local-service' ? `Licensed &amp; Insured &#x2022; ${d.loc}` : null);
  const tagHtml = tag ? `<div class="hero-tag">${tag}</div>` : '';

  if (archetype === 'creative') {
    // Fullscreen centered hero — no stats card, no trust badges
    return `<section class="hero"><div class="hero-inner"><div class="fu">${tagHtml}<h1>${esc(d.hero.headline || '')}</h1><p class="hero-sub">${esc(d.hero.subtext || '')}</p><div class="hero-btns"><a href="#work" class="btn-p">View My Work</a><a href="#contact" class="btn-o">Get in Touch</a></div></div></div></section>`;
  }

  if (archetype === 'food') {
    return `<section class="hero"><div class="hero-inner"><div class="fu">${tagHtml}<h1>${esc(d.hero.headline || '')}</h1><p class="hero-sub">${esc(d.hero.subtext || '')}</p><div class="hero-btns">${d.phone ? `<a href="tel:${d.phoneHref}" class="btn-p">Make a Reservation</a>` : ''}<a href="#menu" class="btn-o">See Our Menu</a></div></div></div></section>`;
  }

  if (archetype === 'wellness') {
    return `<section class="hero"><div class="hero-inner"><div class="hero-split"><div class="fu">${tagHtml}<h1>${esc(d.hero.headline || '')}</h1><p class="hero-sub">${esc(d.hero.subtext || '')}</p><div class="hero-btns"><a href="#contact" class="btn-p">Book Appointment</a><a href="#services" class="btn-o">Our Services</a></div></div><div class="fu fu1"><div class="hero-card"><div class="hero-card-label">Why choose ${d.name}?</div><div class="hero-card-row"><div class="hero-card-mini"><strong>${d.years}</strong><span>Years</span></div><div class="hero-card-mini"><strong>4.9</strong><span>Rating</span></div><div class="hero-card-mini"><strong>5000+</strong><span>Patients</span></div></div></div></div></div></div></section>`;
  }

  if (archetype === 'professional') {
    return `<section class="hero"><div class="hero-inner"><div class="hero-split"><div class="fu">${tagHtml}<h1>${esc(d.hero.headline || '')}</h1><p class="hero-sub">${esc(d.hero.subtext || '')}</p><div class="hero-btns">${d.phone ? `<a href="tel:${d.phoneHref}" class="btn-p">Schedule Consultation</a>` : ''}<a href="#services" class="btn-o">Our Expertise</a></div></div><div class="fu fu1"><div class="hero-card"><div class="hero-card-label">${d.name}</div><div class="hero-card-stat">${d.years}</div><div class="hero-card-desc">Years of trusted expertise</div><div class="hero-card-row"><div class="hero-card-mini"><strong>4.9</strong><span>Rating</span></div><div class="hero-card-mini"><strong>500+</strong><span>Clients</span></div></div></div></div></div></div></section>`;
  }

  // Default: local-service — split hero with stats card + trust proof
  return `<section class="hero"><div class="hero-inner"><div class="hero-split"><div class="fu"><div class="hero-tag"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Licensed &amp; Insured &#x2022; ${d.loc}</div><h1>${esc(d.hero.headline || '')}</h1><p class="hero-sub">${esc(d.hero.subtext || '')}</p><div class="hero-btns">${d.phone ? `<a href="tel:${d.phoneHref}" class="btn-p">Get Your Free Quote</a>` : ''}<a href="#services" class="btn-o">See Our Work</a></div><div class="hero-proof"><span class="hero-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span><span class="hero-proof-text"><strong>4.9/5</strong> from 200+ reviews in ${d.loc}</span></div></div><div class="fu fu1"><div class="hero-card"><div class="hero-card-label">Why ${d.name}?</div><div class="hero-card-stat">${d.years}</div><div class="hero-card-desc">Years serving ${d.loc}</div><div class="hero-card-row"><div class="hero-card-mini"><strong>4.9</strong><span>Rating</span></div><div class="hero-card-mini"><strong>500+</strong><span>Projects</span></div><div class="hero-card-mini"><strong>100%</strong><span>Licensed</span></div></div></div></div></div></div></section>`;
}

function buildTrustBar(stats, t) {
  if (!stats.length) return '';
  return `<div class="trust"><div class="trust-inner">${stats.map(s => `<div class="trust-item"><div class="trust-num">${esc(String(s.number))}</div><div class="trust-label">${esc(s.label)}</div></div>`).join('')}</div></div>`;
}

function buildServicesSection(services, d) {
  return `<section class="sect" id="services"><div class="wrap"><div class="sec-tag">${esc(d.labels.services)}</div><div class="sec-title">${esc(d.labels.services)}</div><div class="sec-desc">Every project gets our full attention. Here's how we help in ${d.loc}.</div><div class="services-grid">${services.map((s, i) => `<div class="svc-card fu fu${Math.min(i, 3)}"><div class="svc-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div><h3>${esc(s.name)}</h3><p>${esc(s.desc || s.description || '')}</p></div>`).join('')}</div></div></section>`;
}

function buildPortfolioSection(services, d) {
  // Niche-specific project tile SVGs that look like real work
  const nicheScenes = [
    // Scene 1: Camera/photo scene
    `<rect width="300" height="300" fill="var(--accent-bg-solid)"/><rect x="60" y="50" width="180" height="130" rx="8" fill="var(--card)" stroke="var(--border)"/><circle cx="150" cy="100" r="30" fill="var(--accent)" opacity=".3"/><circle cx="150" cy="100" r="18" fill="var(--accent)" opacity=".5"/><circle cx="150" cy="100" r="6" fill="var(--accent)"/><rect x="80" y="200" width="140" height="6" rx="3" fill="var(--muted)" opacity=".25"/><rect x="100" y="215" width="100" height="4" rx="2" fill="var(--muted)" opacity=".15"/>`,
    // Scene 2: Browser/website mockup
    `<rect width="300" height="300" fill="var(--accent-bg-solid)"/><rect x="30" y="40" width="240" height="180" rx="8" fill="var(--card)" stroke="var(--border)"/><rect x="30" y="40" width="240" height="24" rx="8" fill="var(--accent)" opacity=".15"/><circle cx="48" cy="52" r="4" fill="var(--accent)" opacity=".4"/><circle cx="62" cy="52" r="4" fill="var(--accent)" opacity=".3"/><circle cx="76" cy="52" r="4" fill="var(--accent)" opacity=".2"/><rect x="50" y="80" width="100" height="8" rx="3" fill="var(--accent)" opacity=".3"/><rect x="50" y="100" width="200" height="4" rx="2" fill="var(--muted)" opacity=".2"/><rect x="50" y="112" width="180" height="4" rx="2" fill="var(--muted)" opacity=".15"/><rect x="50" y="124" width="160" height="4" rx="2" fill="var(--muted)" opacity=".12"/><rect x="50" y="150" width="80" height="28" rx="6" fill="var(--accent)" opacity=".25"/><rect x="80" y="240" width="140" height="5" rx="2" fill="var(--muted)" opacity=".15"/>`,
    // Scene 3: Phone/mobile mockup
    `<rect width="300" height="300" fill="var(--accent-bg-solid)"/><rect x="100" y="30" width="100" height="200" rx="14" fill="var(--card)" stroke="var(--border)" stroke-width="2"/><rect x="110" y="55" width="80" height="10" rx="3" fill="var(--accent)" opacity=".25"/><rect x="110" y="75" width="80" height="4" rx="2" fill="var(--muted)" opacity=".2"/><rect x="110" y="85" width="60" height="4" rx="2" fill="var(--muted)" opacity=".15"/><rect x="110" y="105" width="80" height="40" rx="6" fill="var(--accent)" opacity=".1"/><rect x="110" y="160" width="80" height="24" rx="6" fill="var(--accent)" opacity=".2"/><rect x="135" y="248" width="30" height="3" rx="2" fill="var(--muted)" opacity=".3"/>`,
    // Scene 4: Layers/design comp
    `<rect width="300" height="300" fill="var(--accent-bg-solid)"/><rect x="40" y="60" width="160" height="120" rx="8" fill="var(--accent)" opacity=".12" transform="rotate(-3 120 120)"/><rect x="55" y="50" width="160" height="120" rx="8" fill="var(--accent)" opacity=".18" transform="rotate(2 135 110)"/><rect x="70" y="40" width="160" height="120" rx="8" fill="var(--card)" stroke="var(--border)"/><rect x="85" y="60" width="80" height="6" rx="3" fill="var(--accent)" opacity=".35"/><rect x="85" y="76" width="130" height="4" rx="2" fill="var(--muted)" opacity=".2"/><rect x="85" y="86" width="110" height="4" rx="2" fill="var(--muted)" opacity=".15"/><rect x="85" y="110" width="60" height="22" rx="5" fill="var(--accent)" opacity=".25"/><rect x="80" y="240" width="140" height="5" rx="2" fill="var(--muted)" opacity=".15"/>`,
  ];
  const items = services.map((s, i) => {
    const scene = nicheScenes[i % nicheScenes.length];
    return `<div class="port-item fu fu${Math.min(i, 3)}"><svg viewBox="0 0 300 300" preserveAspectRatio="xMidYMid slice" style="width:100%;height:100%;position:absolute;top:0;left:0">${scene}</svg><div class="port-overlay"><h3>${esc(s.name)}</h3><p>${esc((s.desc || '').substring(0, 60))}</p></div></div>`;
  });
  return `<section class="sect" id="work"><div class="wrap"><div class="sec-tag">${esc(d.labels.services)}</div><div class="sec-title">Selected Work</div><div class="sec-desc">A glimpse of recent projects and creative work.</div><div class="portfolio-grid">${items.join('')}</div></div></section>`;
}

function buildFeaturedItems(services, d) {
  // Food / ecommerce: items with price-style layout
  return `<section class="sect" id="menu"><div class="wrap"><div class="sec-tag">${esc(d.labels.services)}</div><div class="sec-title">${esc(d.labels.services)}</div><div class="menu-grid">${services.map(s => `<div class="menu-item"><div><h3>${esc(s.name)}</h3><p>${esc(s.desc || s.description || '')}</p></div></div>`).join('')}</div></div></section>`;
}

function buildHowItWorks(biz, d) {
  const steps = [
    { num: '1', title: 'Get in Touch', desc: 'Reach out for a free consultation. We listen to your needs and answer your questions.' },
    { num: '2', title: 'Custom Plan', desc: 'We create a tailored plan based on your specific situation, timeline, and budget.' },
    { num: '3', title: 'Deliver Results', desc: 'We execute with precision and keep you informed every step of the way.' },
  ];
  return `<section class="sect sect-alt"><div class="wrap"><div class="sec-tag" style="text-align:center">How It Works</div><div class="sec-title" style="text-align:center">Simple. Transparent. Effective.</div><div class="steps-grid">${steps.map(s => `<div class="step-card fu"><div class="step-num">${s.num}</div><h3>${s.title}</h3><p>${s.desc}</p></div>`).join('')}</div></div></section>`;
}

function buildProcessSteps(biz, d) {
  const steps = [
    { num: '1', title: 'Consultation', desc: 'We discuss your needs, evaluate your situation, and outline your options.' },
    { num: '2', title: 'Strategy', desc: 'We develop a comprehensive strategy tailored to your specific goals.' },
    { num: '3', title: 'Execution', desc: 'Our team delivers results with regular updates and full transparency.' },
  ];
  return `<section class="sect sect-alt"><div class="wrap"><div class="sec-tag" style="text-align:center">Our Process</div><div class="sec-title" style="text-align:center">How We Work</div><div class="steps-grid">${steps.map(s => `<div class="step-card fu"><div class="step-num">${s.num}</div><h3>${s.title}</h3><p>${s.desc}</p></div>`).join('')}</div></div></section>`;
}

function buildAboutSection(about, d) {
  const statsHtml = d.config.showStats ? `<div class="about-stats"><div class="about-stat"><strong>${d.years}</strong><span>Years</span></div><div class="about-stat"><strong>500+</strong><span>Projects</span></div><div class="about-stat"><strong>4.9</strong><span>Rating</span></div></div>` : '';
  // Team scene illustration: 3 people figures with tools/workspace
  const aboutIllustration = `<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;border-radius:var(--rl)"><rect width="400" height="300" fill="var(--accent-bg-solid)"/><!-- Workspace background --><rect x="20" y="180" width="360" height="100" rx="10" fill="var(--card)" stroke="var(--border)"/><!-- Person 1 --><circle cx="100" cy="100" r="28" fill="var(--accent)" opacity=".15"/><circle cx="100" cy="90" r="14" fill="var(--accent)" opacity=".35"/><path d="M100 104c-16 0-26 12-26 20h52c0-8-10-20-26-20z" fill="var(--accent)" opacity=".25"/><!-- Person 2 (center, taller) --><circle cx="200" cy="85" r="32" fill="var(--accent)" opacity=".2"/><circle cx="200" cy="73" r="16" fill="var(--accent)" opacity=".4"/><path d="M200 89c-18 0-30 14-30 22h60c0-8-12-22-30-22z" fill="var(--accent)" opacity=".3"/><!-- Person 3 --><circle cx="300" cy="100" r="28" fill="var(--accent)" opacity=".15"/><circle cx="300" cy="90" r="14" fill="var(--accent)" opacity=".35"/><path d="M300 104c-16 0-26 12-26 20h52c0-8-10-20-26-20z" fill="var(--accent)" opacity=".25"/><!-- Stats boxes --><rect x="35" y="200" width="95" height="60" rx="8" fill="var(--accent-bg-solid)" stroke="var(--border)"/><text x="82" y="232" text-anchor="middle" font-size="22" font-weight="700" fill="var(--accent)" font-family="sans-serif">${d.years}</text><text x="82" y="248" text-anchor="middle" font-size="8" fill="var(--muted)" font-family="sans-serif">YEARS</text><rect x="152" y="200" width="95" height="60" rx="8" fill="var(--accent-bg-solid)" stroke="var(--border)"/><text x="200" y="232" text-anchor="middle" font-size="22" font-weight="700" fill="var(--accent)" font-family="sans-serif">4.9</text><text x="200" y="248" text-anchor="middle" font-size="8" fill="var(--muted)" font-family="sans-serif">RATING</text><rect x="270" y="200" width="95" height="60" rx="8" fill="var(--accent-bg-solid)" stroke="var(--border)"/><text x="317" y="232" text-anchor="middle" font-size="22" font-weight="700" fill="var(--accent)" font-family="sans-serif">500+</text><text x="317" y="248" text-anchor="middle" font-size="8" fill="var(--muted)" font-family="sans-serif">CLIENTS</text></svg>`;
  return `<section class="sect sect-alt" id="about"><div class="about-inner wrap"><div class="about-img" style="background:none;border:none">${aboutIllustration}</div><div class="about-text"><div class="sec-tag">${esc(d.labels.about)}</div><h2>${esc(about.heading || 'Real people. Real work. Real results.')}</h2><p>${d.aboutParas || ''}</p>${statsHtml}</div></div></section>`;
}

function buildTestimonialsSection(testimonials, d) {
  if (!testimonials.length) return '';
  return `<section class="sect" id="reviews"><div class="wrap"><div class="sec-tag">${esc(d.labels.reviews)}</div><div class="sec-title">What people are saying</div><div class="sec-desc">Real feedback from real people.</div><div class="reviews-grid">${testimonials.map((t, i) => `<div class="review-card fu fu${i}"><div class="review-stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div><blockquote>${esc(t.text)}</blockquote><cite>${esc(t.author)}<span>${esc(t.role)}</span></cite></div>`).join('')}</div></div></section>`;
}

function buildGallerySection(d) {
  // Realistic scene illustrations for gallery tiles — each depicts a different moment
  const scenes = [
    // Interior/room scene
    `<rect width="200" height="200" fill="var(--accent-bg-solid)"/><rect x="10" y="60" width="180" height="110" rx="4" fill="var(--card)" stroke="var(--border)"/><rect x="25" y="12" width="60" height="40" rx="4" fill="var(--accent)" opacity=".15"/><rect x="115" y="8" width="50" height="46" rx="4" fill="var(--accent)" opacity=".1"/><rect x="20" y="100" width="50" height="70" rx="3" fill="var(--accent)" opacity=".12"/><rect x="80" y="120" width="40" height="50" rx="3" fill="var(--accent)" opacity=".18"/><circle cx="155" cy="90" r="12" fill="var(--accent)" opacity=".2"/>`,
    // People/team scene
    `<rect width="200" height="200" fill="var(--accent-bg-solid)"/><circle cx="60" cy="70" r="22" fill="var(--accent)" opacity=".2"/><circle cx="60" cy="62" r="10" fill="var(--accent)" opacity=".35"/><path d="M60 82c-14 0-22 10-22 18h44c0-8-8-18-22-18z" fill="var(--accent)" opacity=".25"/><circle cx="140" cy="75" r="20" fill="var(--accent)" opacity=".15"/><circle cx="140" cy="68" r="9" fill="var(--accent)" opacity=".3"/><path d="M140 84c-12 0-20 9-20 16h40c0-7-8-16-20-16z" fill="var(--accent)" opacity=".2"/><rect x="30" y="130" width="140" height="5" rx="2" fill="var(--muted)" opacity=".15"/><rect x="50" y="145" width="100" height="4" rx="2" fill="var(--muted)" opacity=".1"/>`,
    // Workspace/desk scene
    `<rect width="200" height="200" fill="var(--accent-bg-solid)"/><rect x="15" y="70" width="170" height="90" rx="6" fill="var(--card)" stroke="var(--border)"/><rect x="40" y="85" width="120" height="60" rx="4" fill="var(--accent)" opacity=".08"/><rect x="50" y="95" width="60" height="5" rx="2" fill="var(--accent)" opacity=".3"/><rect x="50" y="107" width="100" height="3" rx="2" fill="var(--muted)" opacity=".2"/><rect x="50" y="116" width="80" height="3" rx="2" fill="var(--muted)" opacity=".15"/><circle cx="160" cy="50" r="15" fill="var(--accent)" opacity=".12"/><rect x="20" y="40" width="30" height="40" rx="3" fill="var(--accent)" opacity=".1"/>`,
    // Outdoor/landscape scene
    `<rect width="200" height="200" fill="var(--accent-bg-solid)"/><circle cx="155" cy="40" r="18" fill="var(--accent)" opacity=".2"/><path d="M0 120 Q50 70 100 100 Q150 130 200 90 L200 200 L0 200Z" fill="var(--accent)" opacity=".1"/><path d="M0 150 Q60 110 120 140 Q180 170 200 130 L200 200 L0 200Z" fill="var(--accent)" opacity=".15"/><polygon points="60,80 80,120 40,120" fill="var(--accent)" opacity=".18"/><polygon points="130,60 160,120 100,120" fill="var(--accent)" opacity=".12"/>`,
    // Food/plate scene
    `<rect width="200" height="200" fill="var(--accent-bg-solid)"/><circle cx="100" cy="100" r="65" fill="var(--card)" stroke="var(--border)"/><circle cx="100" cy="100" r="55" fill="var(--accent)" opacity=".06"/><circle cx="85" cy="90" r="15" fill="var(--accent)" opacity=".2"/><circle cx="115" cy="85" r="12" fill="var(--accent)" opacity=".15"/><ellipse cx="100" cy="110" rx="20" ry="12" fill="var(--accent)" opacity=".12"/><rect x="75" y="170" width="50" height="4" rx="2" fill="var(--muted)" opacity=".2"/>`,
    // Tools/craft scene
    `<rect width="200" height="200" fill="var(--accent-bg-solid)"/><rect x="30" y="50" width="140" height="100" rx="6" fill="var(--card)" stroke="var(--border)"/><rect x="50" y="70" width="20" height="60" rx="3" fill="var(--accent)" opacity=".25"/><rect x="80" y="80" width="20" height="50" rx="3" fill="var(--accent)" opacity=".18"/><rect x="110" y="65" width="20" height="65" rx="3" fill="var(--accent)" opacity=".3"/><rect x="140" y="90" width="20" height="40" rx="3" fill="var(--accent)" opacity=".15"/><rect x="50" y="165" width="100" height="4" rx="2" fill="var(--muted)" opacity=".15"/>`,
    // Certificate/achievement scene
    `<rect width="200" height="200" fill="var(--accent-bg-solid)"/><rect x="25" y="30" width="150" height="110" rx="6" fill="var(--card)" stroke="var(--border)"/><rect x="55" y="50" width="90" height="6" rx="3" fill="var(--accent)" opacity=".3"/><rect x="45" y="70" width="110" height="3" rx="2" fill="var(--muted)" opacity=".2"/><rect x="50" y="80" width="100" height="3" rx="2" fill="var(--muted)" opacity=".15"/><rect x="60" y="90" width="80" height="3" rx="2" fill="var(--muted)" opacity=".12"/><circle cx="100" cy="115" r="10" fill="var(--accent)" opacity=".2"/><path d="M95 125 L100 135 L105 125" fill="var(--accent)" opacity=".2"/><rect x="40" y="160" width="120" height="4" rx="2" fill="var(--muted)" opacity=".15"/>`,
    // Building/architecture scene
    `<rect width="200" height="200" fill="var(--accent-bg-solid)"/><rect x="25" y="50" width="60" height="120" rx="3" fill="var(--accent)" opacity=".15"/><rect x="35" y="60" width="15" height="15" rx="2" fill="var(--accent)" opacity=".25"/><rect x="60" y="60" width="15" height="15" rx="2" fill="var(--accent)" opacity=".25"/><rect x="35" y="85" width="15" height="15" rx="2" fill="var(--accent)" opacity=".25"/><rect x="60" y="85" width="15" height="15" rx="2" fill="var(--accent)" opacity=".25"/><rect x="100" y="30" width="75" height="140" rx="3" fill="var(--accent)" opacity=".12"/><rect x="110" y="45" width="18" height="18" rx="2" fill="var(--accent)" opacity=".2"/><rect x="140" y="45" width="18" height="18" rx="2" fill="var(--accent)" opacity=".2"/><rect x="110" y="75" width="18" height="18" rx="2" fill="var(--accent)" opacity=".2"/><rect x="140" y="75" width="18" height="18" rx="2" fill="var(--accent)" opacity=".2"/><rect x="120" y="120" width="25" height="50" rx="2" fill="var(--accent)" opacity=".3"/>`,
  ];
  const items = scenes.map(s => `<div class="gallery-item"><svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid slice">${s}</svg></div>`);
  return `<section class="sect sect-alt"><div class="wrap"><div class="sec-tag">Gallery</div><div class="sec-title">Moments &amp; Atmosphere</div><div class="gallery-grid">${items.join('')}</div></div></section>`;
}

function buildHoursLocation(d) {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const hours = days.map(day => `<div class="hours-row"><span>${day}</span><span>${day === 'Sunday' ? 'Closed' : '11:00 AM - 10:00 PM'}</span></div>`);
  return `<section class="sect sect-alt" id="visit"><div class="wrap" style="text-align:center"><div class="sec-tag">Visit Us</div><div class="sec-title">Hours &amp; Location</div><div class="hours-box">${hours.join('')}<div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)"><p style="font-size:14px;color:var(--text-sec)">${d.loc}</p>${d.phone ? `<p style="margin-top:8px"><a href="tel:${d.phoneHref}" style="color:var(--accent);font-weight:600">${d.phone}</a></p>` : ''}</div></div></div></section>`;
}

function buildBookingCta(d) {
  return `<section class="cta-sect" id="contact"><div class="cta-inner"><div class="sec-tag">Ready?</div><h2>${esc(d.labels.cta)}</h2><p>We're accepting new patients and would love to help you. Schedule your first visit today.</p><div class="cta-btns">${d.phone ? `<a href="tel:${d.phoneHref}" class="btn-p">Call to Book</a>` : ''}<a href="mailto:${d.contactEmail || '#'}" class="btn-o">Email Us</a></div></div></section>`;
}

function buildContactSimple(d) {
  return `<section class="sect sect-alt" id="contact"><div class="wrap" style="text-align:center"><div class="sec-tag">Contact</div><div class="sec-title">Let's work together</div><div class="contact-grid" style="text-align:left;margin-top:40px"><div class="contact-info">${d.phone ? `<div class="contact-item"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3"/></svg><p><a href="tel:${d.phoneHref}">${d.phone}</a></p></div>` : ''}${d.contactEmail ? `<div class="contact-item"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg><p><a href="mailto:${d.contactEmail}">${d.contactEmail}</a></p></div>` : ''}<div class="contact-item"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><p>${d.loc}</p></div></div><div style="background:var(--accent-bg-solid);border:1px solid var(--accent-bg);border-radius:var(--rl);padding:32px;text-align:center"><p style="font-size:15px;color:var(--text-sec);margin-bottom:16px">Ready to start a project?</p><a href="${d.contactEmail ? 'mailto:' + d.contactEmail : '#'}" class="btn-p" style="width:100%;justify-content:center">Get in Touch</a></div></div></div></section>`;
}

function buildCtaSection(ctaContent, d) {
  return `<section class="cta-sect"><div class="cta-inner"><div class="sec-tag">Ready?</div><h2>${esc(ctaContent.heading || d.labels.cta)}</h2><p>${esc(ctaContent.subtext || 'No pressure, no obligation.')}</p><div class="cta-btns">${d.phone ? `<a href="tel:${d.phoneHref}" class="btn-p">Call ${d.phone}</a>` : ''}${d.contactEmail ? `<a href="mailto:${d.contactEmail}" class="btn-o">Email Us</a>` : ''}</div></div></section>`;
}

function getTheme(style, archetype) {
  // Archetype-specific themes with truly different fonts, colors, and visual DNA
  const archetypeThemes = {
    'local-service': { bg:'#fafaf5',bgAlt:'#f0ede6',nav:'#ffffff',accent:'#1a5632',accentHover:'#13472a',accentBg:'rgba(26,86,50,0.06)',accentBgSolid:'#ecf4ef',trust:'#14301e',text:'#1a2e1c',textSec:'#4d5e4f',muted:'#7e8e80',card:'#ffffff',border:'rgba(0,0,0,0.07)',heroGrad:'linear-gradient(140deg,#e8f0ea 0%,#fafaf5 60%,#f5f3ed 100%)',font:"'Poppins',-apple-system,system-ui,sans-serif",fontHead:"'Poppins',sans-serif",gFont:'Poppins:wght@400;500;600;700;800',svcCols:2,cardRadius:'12px',headingStyle:'bold-sans' },
    'food': { bg:'#fdf8f3',bgAlt:'#f8f0e6',nav:'#fdf8f3',accent:'#8b2252',accentHover:'#751d45',accentBg:'rgba(139,34,82,0.05)',accentBgSolid:'#fdf0f4',trust:'#3a1522',text:'#2c1a18',textSec:'#6b524e',muted:'#9a827e',card:'#ffffff',border:'rgba(139,34,82,0.08)',heroGrad:'linear-gradient(160deg,#f8ece0 0%,#fdf8f3 40%,#fdf0f4 100%)',font:"'Lato',-apple-system,system-ui,sans-serif",fontHead:"'Playfair Display',Georgia,serif",gFont:'Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Lato:wght@300;400;700',svcCols:1,cardRadius:'0px',headingStyle:'elegant-serif' },
    'creative': { bg:'#ffffff',bgAlt:'#f6f6f6',nav:'#ffffff',accent:'#111111',accentHover:'#333333',accentBg:'rgba(0,0,0,0.03)',accentBgSolid:'#f0f0f0',trust:'#111111',text:'#111111',textSec:'#555555',muted:'#999999',card:'#fafafa',border:'rgba(0,0,0,0.08)',heroGrad:'linear-gradient(180deg,#ffffff 0%,#f8f8f8 100%)',font:"'Inter',-apple-system,system-ui,sans-serif",fontHead:"'Space Grotesk','Inter',sans-serif",gFont:'Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500',svcCols:3,cardRadius:'0px',headingStyle:'display-sans' },
    'wellness': { bg:'#f5faf6',bgAlt:'#edf5ef',nav:'#f5faf6',accent:'#4a7c59',accentHover:'#3d6a4b',accentBg:'rgba(74,124,89,0.06)',accentBgSolid:'#e8f2eb',trust:'#2a4a32',text:'#1e3228',textSec:'#5a7562',muted:'#8aaa92',card:'#ffffff',border:'rgba(74,124,89,0.1)',heroGrad:'linear-gradient(150deg,#e8f2eb 0%,#f5faf6 50%,#faf8f5 100%)',font:"'Jost',-apple-system,system-ui,sans-serif",fontHead:"'Cormorant Garamond',Georgia,serif",gFont:'Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Jost:wght@300;400;500;600',svcCols:3,cardRadius:'20px',headingStyle:'delicate-serif' },
    'professional': { bg:'#f4f5f7',bgAlt:'#ebeef2',nav:'#ffffff',accent:'#1e3a5f',accentHover:'#162d4a',accentBg:'rgba(30,58,95,0.05)',accentBgSolid:'#e8eef6',trust:'#0f1f33',text:'#1a2030',textSec:'#4a5568',muted:'#8292a2',card:'#ffffff',border:'rgba(0,0,0,0.06)',heroGrad:'linear-gradient(135deg,#e8eef6 0%,#f4f5f7 50%,#f0f2f6 100%)',font:"'Source Sans 3',-apple-system,system-ui,sans-serif",fontHead:"'Libre Baskerville',Georgia,serif",gFont:'Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Source+Sans+3:wght@300;400;500;600;700',svcCols:3,cardRadius:'8px',headingStyle:'classic-serif' },
    'ecommerce': { bg:'#fafafa',bgAlt:'#f0f0f0',nav:'#ffffff',accent:'#2563eb',accentHover:'#1d4fd8',accentBg:'rgba(37,99,235,0.05)',accentBgSolid:'#eff4ff',trust:'#111827',text:'#111827',textSec:'#4b5563',muted:'#9ca3af',card:'#ffffff',border:'rgba(0,0,0,0.06)',heroGrad:'linear-gradient(135deg,#eff4ff 0%,#fafafa 50%,#f5f5ff 100%)',font:"'Inter',-apple-system,system-ui,sans-serif",fontHead:"'Sora','Inter',sans-serif",gFont:'Sora:wght@300;400;500;600;700&family=Inter:wght@400;500',svcCols:4,cardRadius:'16px',headingStyle:'modern-sans' },
    'nonprofit': { bg:'#fafbf8',bgAlt:'#f0f2ed',nav:'#ffffff',accent:'#0d7377',accentHover:'#0a5e61',accentBg:'rgba(13,115,119,0.06)',accentBgSolid:'#e6f3f3',trust:'#0a4a4c',text:'#1a2e2e',textSec:'#4a6060',muted:'#7a9090',card:'#ffffff',border:'rgba(13,115,119,0.08)',heroGrad:'linear-gradient(140deg,#e6f3f3 0%,#fafbf8 50%,#f5f8f0 100%)',font:"'Open Sans',-apple-system,system-ui,sans-serif",fontHead:"'Merriweather',Georgia,serif",gFont:'Merriweather:ital,wght@0,400;0,700;1,400&family=Open+Sans:wght@400;500;600;700',svcCols:3,cardRadius:'12px',headingStyle:'serious-serif' },
  };

  // Style overrides (user preference) can modify the archetype base
  const styleOverrides = {
    'bold-dark': { bg:'#0e0c0a',bgAlt:'#161412',nav:'#121010',text:'#e8ddd3',textSec:'#a89f94',muted:'#6d6560',card:'#1a1815',border:'rgba(255,255,255,0.06)',heroGrad:'linear-gradient(135deg,#1a1410 0%,#0e0c0a 50%,#12100e 100%)' },
    'warm-friendly': { accent:'#c66b2e',accentHover:'#b55e24',accentBg:'rgba(198,107,46,0.07)',accentBgSolid:'#fdf3e8' },
    'rustic': { accent:'#7a6040',accentHover:'#6a5035',accentBg:'rgba(122,96,64,0.07)',accentBgSolid:'#f0ebe0',font:"'Lora',Georgia,serif",gFont:'Lora:wght@400;500;600;700' },
    'surprise': { accent:'#7c3aed',accentHover:'#6d28d9',accentBg:'rgba(124,58,237,0.06)',accentBgSolid:'#f0ecff' },
  };

  const base = archetypeThemes[archetype] || archetypeThemes['local-service'];
  const overrides = styleOverrides[style] || {};
  return { ...base, ...overrides };
}

// ── QA Engine (inline copy from qa.js for orchestrator) ───────

function runQA(html, bizName) {
  const issues = [];
  let deductions = 0;

  const slopPatterns = [
    { pattern: /lorem ipsum/i, msg: 'Contains placeholder text', points: 15 },
    { pattern: /\[(?:insert|your|business|company|name)\]/i, msg: 'Unfilled placeholder', points: 15 },
    { pattern: /synerg(?:y|ies|ize)/i, msg: 'AI slop: "synergy"', points: 5 },
    { pattern: /revolutioniz/i, msg: 'AI slop: "revolutionize"', points: 5 },
    { pattern: /paradigm shift/i, msg: 'AI slop: "paradigm shift"', points: 8 },
    { pattern: /elevat(?:e|ing) your (?:brand|business)/i, msg: 'AI slop: "elevate your X"', points: 5 },
    { pattern: /unlock(?:ing)? (?:the )?potential/i, msg: 'AI slop: "unlock potential"', points: 5 },
    { pattern: /delve(?:s)? (?:into|deeper)/i, msg: 'AI slop: uses "delve"', points: 5 },
    { pattern: /in today'?s fast.?paced/i, msg: 'AI slop: generic opener', points: 5 },
  ];
  for (const { pattern, msg, points } of slopPatterns) {
    if (pattern.test(html)) { issues.push({ type: 'slop', severity: points >= 8 ? 'high' : 'medium', message: msg }); deductions += points; }
  }
  if (!/<h1/i.test(html)) { issues.push({ type: 'content', severity: 'high', message: 'Missing H1' }); deductions += 10; }
  if (!/<nav/i.test(html)) { issues.push({ type: 'content', severity: 'medium', message: 'Missing nav' }); deductions += 5; }
  if (bizName && !html.includes(bizName)) { issues.push({ type: 'brand', severity: 'high', message: 'Business name missing' }); deductions += 10; }
  if (!/<a[^>]+href=["']tel:/i.test(html)) { issues.push({ type: 'brand', severity: 'medium', message: 'No tel: link' }); deductions += 5; }
  if (!/<meta[^>]*viewport/i.test(html)) { issues.push({ type: 'a11y', severity: 'high', message: 'Missing viewport' }); deductions += 10; }
  if (!/<html[^>]*lang=/i.test(html)) { issues.push({ type: 'a11y', severity: 'medium', message: 'Missing lang attr' }); deductions += 3; }
  if (!/<title[^>]*>.+<\/title>/i.test(html)) { issues.push({ type: 'seo', severity: 'high', message: 'Missing title' }); deductions += 8; }
  if (!/<meta[^>]*description/i.test(html)) { issues.push({ type: 'seo', severity: 'medium', message: 'Missing meta desc' }); deductions += 5; }
  if (!/@media/i.test(html)) { issues.push({ type: 'responsive', severity: 'medium', message: 'No media queries' }); deductions += 8; }

  const score = Math.max(0, 100 - deductions);
  return { score, passed: score >= 70, issues, total_issues: issues.length, checked_at: new Date().toISOString() };
}
