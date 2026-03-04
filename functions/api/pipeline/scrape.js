/**
 * POST /api/pipeline/scrape
 *
 * Deep Website Scraper Agent
 * ──────────────────────────
 * Goes far beyond basic HTML extraction. This agent:
 *   1. Fetches the target site + key subpages (about, services, contact)
 *   2. Extracts real business content (copy, headings, CTAs)
 *   3. Pulls brand colors from CSS/inline styles
 *   4. Finds all images and categorizes them (logo, hero, team, gallery)
 *   5. Maps site structure (nav links, page hierarchy)
 *   6. Extracts social media links
 *   7. Pulls Google Business/Yelp rating if embedded
 *   8. Detects CMS, tech stack, design era
 *   9. Returns a rich "site DNA" object for the builder agent
 *
 * Body: { website_url: string, email?: string }
 * Returns: { site_dna: { ... } }
 */
import { json, err, corsPreflightResponse, getKV, generateId } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);

  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON'); }

  const websiteUrl = (body.website_url || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  if (!websiteUrl) return err('website_url is required');

  const siteDna = await scrapeSite(websiteUrl);

  // Store in KV
  if (kv && email) {
    try {
      const key = 'site_dna:' + email;
      await kv.put(key, JSON.stringify(siteDna), { expirationTtl: 86400 * 90 });
    } catch { /* non-critical */ }
  }

  return json({ site_dna: siteDna });
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}

// ── Main scraper ──────────────────────────────────────────────

async function scrapeSite(baseUrl) {
  let url = baseUrl;
  if (!url.startsWith('http')) url = 'https://' + url;

  const dna = {
    url,
    domain: extractDomain(url),
    scraped_at: new Date().toISOString(),
    reachable: false,

    // Business info
    business_name: '',
    tagline: '',
    phone: '',
    email: '',
    address: '',
    hours: '',

    // Brand
    colors: [],
    logo_url: '',
    favicon_url: '',

    // Content
    hero_headline: '',
    hero_subtext: '',
    page_headings: [],
    cta_texts: [],
    paragraphs: [],

    // Structure
    nav_links: [],
    subpages: {},
    total_pages_found: 0,

    // Media
    images: [],
    social_links: {},

    // Tech
    cms: 'unknown',
    tech_signals: [],
    has_ssl: false,
    has_mobile_viewport: false,
    load_time_ms: 0,
    page_size_kb: 0,

    // Extracted services
    services_found: [],

    // Reviews / ratings
    rating: null,
    review_count: null,

    // Design patterns (NEW)
    design: {
      fonts: [],
      google_fonts_url: '',
      heading_font: '',
      body_font: '',
      layout_type: '',       // grid, flexbox, table, float
      max_width: '',
      section_count: 0,
      section_types: [],     // hero, services, about, testimonials, cta, etc.
      hero_style: '',        // fullscreen, split, centered, image-bg
      nav_style: '',         // sticky, fixed, static, transparent
      has_animations: false,
      has_parallax: false,
      has_dark_mode: false,
      button_style: '',      // rounded, pill, square
      spacing_density: '',   // airy, balanced, compact
      design_era: '',        // modern, dated, minimal, bold
    },
  };

  // ── Fetch homepage ──
  const startTime = Date.now();
  let html = '';
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    html = await resp.text();
    dna.reachable = true;
    dna.has_ssl = resp.url.startsWith('https');
    dna.load_time_ms = Date.now() - startTime;
    dna.page_size_kb = Math.round(html.length / 1024);
  } catch {
    return dna;
  }

  // ── Extract everything from homepage ──
  extractBusinessInfo(html, url, dna);
  extractBrandColors(html, dna);
  extractContent(html, dna);
  extractStructure(html, url, dna);
  extractImages(html, url, dna);
  extractSocial(html, dna);
  detectTech(html, dna);
  extractServicesFromContent(html, dna);
  extractRatings(html, dna);
  extractDesignPatterns(html, dna);

  // ── Scrape subpages (about, services, contact) ──
  const subpageUrls = findSubpageUrls(dna.nav_links, url);

  const subpagePromises = subpageUrls.map(async (sp) => {
    try {
      const resp = await fetch(sp.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelocityBot/2.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      const subHtml = await resp.text();
      const subData = { url: sp.url, type: sp.type, headings: [], paragraphs: [], images: [] };

      // Extract headings
      const headings = subHtml.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gi) || [];
      subData.headings = headings.map(h => stripTags(h)).filter(h => h.length > 2 && h.length < 200).slice(0, 10);

      // Extract paragraphs
      const paras = subHtml.match(/<p[^>]*>(.*?)<\/p>/gi) || [];
      subData.paragraphs = paras
        .map(p => stripTags(p).trim())
        .filter(p => p.length > 30 && p.length < 1000)
        .slice(0, 8);

      // Extract images
      const imgs = subHtml.match(/<img[^>]+src=["']([^"']+)["'][^>]*/gi) || [];
      subData.images = imgs.map(img => {
        const srcMatch = img.match(/src=["']([^"']+)["']/);
        const altMatch = img.match(/alt=["']([^"']+)["']/);
        return {
          src: srcMatch ? resolveUrl(srcMatch[1], sp.url) : '',
          alt: altMatch ? altMatch[1] : '',
        };
      }).filter(i => i.src && !i.src.includes('tracking') && !i.src.includes('pixel')).slice(0, 10);

      // Extract services from subpages
      if (sp.type === 'services') {
        extractServicesFromContent(subHtml, dna);
      }

      dna.subpages[sp.type] = subData;
    } catch { /* skip failed subpages */ }
  });

  await Promise.all(subpagePromises);
  dna.total_pages_found = 1 + Object.keys(dna.subpages).length;

  return dna;
}

// ── Business info ─────────────────────────────────────────────

function extractBusinessInfo(html, url, dna) {
  // Domain
  try { dna.domain = new URL(url).hostname.replace('www.', ''); } catch {}

  // Business name from title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (titleMatch) {
    let t = titleMatch[1]
      .replace(/\s*[-|–—:].*/g, '')
      .replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/<[^>]+>/g, '').trim();
    if (t.length > 2 && t.length < 60) dna.business_name = t;
  }

  // Also check og:site_name
  const siteNameMatch = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["'](.*?)["']/i);
  if (siteNameMatch && siteNameMatch[1].length > 2) {
    dna.business_name = siteNameMatch[1].replace(/&amp;/g, '&');
  }

  // Phone (multiple patterns)
  const phones = [];
  const phonePatterns = [
    /href=["']tel:([^"']+)["']/gi,
    /(\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/g,
    /(\d{3}[\s.-]\d{3}[\s.-]\d{4})/g,
  ];
  for (const pat of phonePatterns) {
    const matches = html.matchAll(pat);
    for (const m of matches) {
      const p = m[1].replace(/[^\d()-.\s+]/g, '').trim();
      if (p.replace(/\D/g, '').length >= 10) phones.push(p);
    }
  }
  if (phones.length) dna.phone = phones[0];

  // Email
  const emailMatches = html.matchAll(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g);
  for (const m of emailMatches) {
    const e = m[1];
    if (!e.includes('example.') && !e.includes('wix') && !e.includes('wordpress') &&
        !e.includes('sentry') && !e.includes('google') && !e.includes('.png') && !e.includes('.jpg')) {
      dna.email = e;
      break;
    }
  }

  // Meta description
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/i);
  if (descMatch && descMatch[1].length > 10) dna.tagline = descMatch[1].replace(/&amp;/g, '&');

  // Address
  const addrMatch = html.match(/\d{2,5}\s+[\w\s.]+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct|Pl|Street|Avenue|Boulevard|Road|Drive|Lane|Court|Place)[.,]?\s*(?:Suite|Ste|#|Apt|Unit)?\s*\d*[.,]?\s*[\w\s]+[.,]?\s*[A-Z]{2}\s+\d{5}/i);
  if (addrMatch) dna.address = addrMatch[0].trim();

  // Business hours
  const hoursMatch = html.match(/(?:hours|schedule|open)[^<]*?(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^<]{5,120}/i);
  if (hoursMatch) dna.hours = hoursMatch[0].trim().substring(0, 200);
}

// ── Brand colors ──────────────────────────────────────────────

function extractBrandColors(html, dna) {
  const colorMap = {};

  // From CSS custom properties
  const cssVarMatches = html.matchAll(/--[\w-]*color[\w-]*\s*:\s*(#[0-9a-fA-F]{3,8})/gi);
  for (const m of cssVarMatches) addColor(colorMap, m[1]);

  // From inline styles and CSS rules — hex colors
  const hexMatches = html.matchAll(/(?:color|background(?:-color)?)\s*:\s*(#[0-9a-fA-F]{3,8})/gi);
  for (const m of hexMatches) addColor(colorMap, m[1]);

  // Theme color meta
  const themeMatch = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["'](#[0-9a-fA-F]{3,8})["']/i);
  if (themeMatch) addColor(colorMap, themeMatch[1], 5);

  // Sort by frequency and filter out near-black/near-white
  dna.colors = Object.entries(colorMap)
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0])
    .filter(c => {
      const hex = c.replace('#', '').toLowerCase();
      if (hex.length === 3) return true;
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      return brightness > 20 && brightness < 235;
    })
    .slice(0, 8);
}

function addColor(map, color, weight) {
  const c = color.toLowerCase();
  if (c.length < 4) return;
  map[c] = (map[c] || 0) + (weight || 1);
}

// ── Content extraction ────────────────────────────────────────

function extractContent(html, dna) {
  // Hero headline (first h1)
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
  if (h1Match) {
    const h1 = stripTags(h1Match[1]).trim();
    if (h1.length > 3 && h1.length < 200) dna.hero_headline = h1;
  }

  // All headings
  const headingMatches = html.matchAll(/<h[1-4][^>]*>(.*?)<\/h[1-4]>/gi);
  for (const m of headingMatches) {
    const t = stripTags(m[1]).trim();
    if (t.length > 3 && t.length < 200) dna.page_headings.push(t);
  }
  dna.page_headings = [...new Set(dna.page_headings)].slice(0, 20);

  // Hero subtext (first large paragraph near h1)
  const pMatches = html.match(/<p[^>]*>(.*?)<\/p>/gi) || [];
  for (const p of pMatches.slice(0, 5)) {
    const text = stripTags(p).trim();
    if (text.length > 40 && text.length < 500) {
      dna.hero_subtext = text;
      break;
    }
  }

  // All meaningful paragraphs
  for (const p of pMatches) {
    const text = stripTags(p).trim();
    if (text.length > 30 && text.length < 1000) {
      dna.paragraphs.push(text);
    }
  }
  dna.paragraphs = [...new Set(dna.paragraphs)].slice(0, 15);

  // CTA buttons
  const ctaMatches = html.matchAll(/<(?:a|button)[^>]*class=["'][^"']*(?:btn|button|cta)[^"']*["'][^>]*>(.*?)<\/(?:a|button)>/gi);
  for (const m of ctaMatches) {
    const t = stripTags(m[1]).trim();
    if (t.length > 2 && t.length < 60) dna.cta_texts.push(t);
  }
  dna.cta_texts = [...new Set(dna.cta_texts)].slice(0, 8);
}

// ── Structure ─────────────────────────────────────────────────

function extractStructure(html, baseUrl, dna) {
  // Nav links
  const navMatch = html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i);
  const navHtml = navMatch ? navMatch[1] : '';
  const linkMatches = (navHtml || html.substring(0, 5000)).matchAll(/<a[^>]+href=["']([^"'#][^"']*)["'][^>]*>(.*?)<\/a>/gi);

  for (const m of linkMatches) {
    const href = m[1];
    const text = stripTags(m[2]).trim();
    if (text.length > 1 && text.length < 40 && !href.includes('javascript:')) {
      const resolved = resolveUrl(href, baseUrl);
      if (resolved && isSameDomain(resolved, baseUrl)) {
        dna.nav_links.push({ text, url: resolved });
      }
    }
  }
  dna.nav_links = dna.nav_links.slice(0, 12);
}

// ── Images ────────────────────────────────────────────────────

function extractImages(html, baseUrl, dna) {
  const imgMatches = html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*/gi);
  const seen = new Set();

  for (const m of imgMatches) {
    const fullTag = m[0];
    const src = resolveUrl(m[1], baseUrl);
    if (!src || seen.has(src)) continue;
    seen.add(src);

    // Skip tracking pixels and tiny images
    const widthMatch = fullTag.match(/width=["']?(\d+)/i);
    if (widthMatch && parseInt(widthMatch[1]) < 10) continue;
    if (src.includes('pixel') || src.includes('tracking') || src.includes('analytics') ||
        src.includes('facebook.com') || src.includes('google-analytics')) continue;

    const altMatch = fullTag.match(/alt=["']([^"']+)["']/i);
    const classMatch = fullTag.match(/class=["']([^"']+)["']/i);

    let type = 'general';
    const srcLow = src.toLowerCase();
    const altLow = (altMatch ? altMatch[1] : '').toLowerCase();
    const classLow = (classMatch ? classMatch[1] : '').toLowerCase();

    if (srcLow.includes('logo') || altLow.includes('logo') || classLow.includes('logo')) type = 'logo';
    else if (srcLow.includes('hero') || classLow.includes('hero') || classLow.includes('banner')) type = 'hero';
    else if (srcLow.includes('team') || altLow.includes('team') || altLow.includes('staff')) type = 'team';
    else if (srcLow.includes('gallery') || classLow.includes('gallery') || classLow.includes('portfolio')) type = 'gallery';
    else if (srcLow.includes('testimonial') || srcLow.includes('review')) type = 'testimonial';

    if (type === 'logo') dna.logo_url = src;

    dna.images.push({ src, alt: altMatch ? altMatch[1] : '', type });
  }

  dna.images = dna.images.slice(0, 25);

  // Favicon
  const favMatch = html.match(/<link[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*href=["']([^"']+)["']/i);
  if (favMatch) dna.favicon_url = resolveUrl(favMatch[1], baseUrl);
}

// ── Social links ──────────────────────────────────────────────

function extractSocial(html, dna) {
  const platforms = {
    facebook: /facebook\.com\/[\w.-]+/i,
    instagram: /instagram\.com\/[\w.-]+/i,
    twitter: /(?:twitter|x)\.com\/[\w.-]+/i,
    linkedin: /linkedin\.com\/(?:company|in)\/[\w.-]+/i,
    youtube: /youtube\.com\/(?:channel|c|@)\/[\w.-]+/i,
    yelp: /yelp\.com\/biz\/[\w.-]+/i,
    google: /google\.com\/maps\/place\/[^\s"'<]+/i,
    tiktok: /tiktok\.com\/@[\w.-]+/i,
  };

  for (const [name, pattern] of Object.entries(platforms)) {
    const match = html.match(pattern);
    if (match) dna.social_links[name] = match[0].startsWith('http') ? match[0] : 'https://' + match[0];
  }
}

// ── Tech detection ────────────────────────────────────────────

function detectTech(html, dna) {
  dna.has_mobile_viewport = /viewport/.test(html);

  const techChecks = [
    { signal: 'WordPress', test: /wp-content|wp-includes/i },
    { signal: 'Wix', test: /wix\.com|_wixCIDRequired/i },
    { signal: 'Squarespace', test: /squarespace\.com|sqsp/i },
    { signal: 'Shopify', test: /shopify\.com|Shopify\.theme/i },
    { signal: 'Weebly', test: /weebly\.com/i },
    { signal: 'GoDaddy Builder', test: /godaddy\.com|gdwBuilder/i },
    { signal: 'React', test: /react|__NEXT_DATA__/i },
    { signal: 'jQuery', test: /jquery[.-]?\d/i },
    { signal: 'Bootstrap', test: /bootstrap[.-]?\d/i },
    { signal: 'Tailwind CSS', test: /tailwindcss|tw-/i },
    { signal: 'Google Analytics', test: /google-analytics\.com|gtag|UA-\d+/i },
    { signal: 'Google Tag Manager', test: /googletagmanager\.com/i },
    { signal: 'Facebook Pixel', test: /connect\.facebook\.net|fbq\(/i },
    { signal: 'Cloudflare', test: /cloudflare/i },
  ];

  for (const check of techChecks) {
    if (check.test.test(html)) {
      dna.tech_signals.push(check.signal);
      if (['WordPress', 'Wix', 'Squarespace', 'Shopify', 'Weebly', 'GoDaddy Builder'].includes(check.signal)) {
        dna.cms = check.signal;
      }
    }
  }
}

// ── Services extraction ───────────────────────────────────────

function extractServicesFromContent(html, dna) {
  // Look for service-like sections
  const servicePatterns = [
    // h2/h3 inside service-like containers
    /<(?:div|section|article)[^>]*class=["'][^"']*(?:service|feature|offer|capability)[^"']*["'][^>]*>[\s\S]*?<h[2-4][^>]*>(.*?)<\/h[2-4]>/gi,
    // li items in service lists
    /<li[^>]*class=["'][^"']*(?:service|feature)[^"']*["'][^>]*>(.*?)<\/li>/gi,
  ];

  for (const pattern of servicePatterns) {
    const matches = html.matchAll(pattern);
    for (const m of matches) {
      const t = stripTags(m[1]).trim();
      if (t.length > 3 && t.length < 80) dna.services_found.push(t);
    }
  }

  // Also look for headings that mention common service terms after "services" section
  const afterServices = html.split(/services/i).slice(1).join('');
  if (afterServices) {
    const headings = afterServices.match(/<h[2-4][^>]*>(.*?)<\/h[2-4]>/gi) || [];
    for (const h of headings.slice(0, 8)) {
      const t = stripTags(h).trim();
      if (t.length > 3 && t.length < 80 && !t.toLowerCase().includes('contact') &&
          !t.toLowerCase().includes('testimonial') && !t.toLowerCase().includes('about')) {
        dna.services_found.push(t);
      }
    }
  }

  dna.services_found = [...new Set(dna.services_found)].slice(0, 12);
}

// ── Ratings ───────────────────────────────────────────────────

function extractRatings(html, dna) {
  // Schema.org rating
  const ratingMatch = html.match(/"ratingValue"\s*:\s*"?(\d+\.?\d*)"?/);
  if (ratingMatch) dna.rating = parseFloat(ratingMatch[1]);

  const countMatch = html.match(/"reviewCount"\s*:\s*"?(\d+)"?/);
  if (countMatch) dna.review_count = parseInt(countMatch[1]);

  // Fallback: visible star ratings
  if (!dna.rating) {
    const starMatch = html.match(/(\d+\.?\d*)\s*(?:\/\s*5|out of 5|stars?)\s*(?:\((\d+)\s*reviews?\))?/i);
    if (starMatch) {
      dna.rating = parseFloat(starMatch[1]);
      if (starMatch[2]) dna.review_count = parseInt(starMatch[2]);
    }
  }
}

// ── Design pattern extraction ─────────────────────────────────

function extractDesignPatterns(html, dna) {
  const d = dna.design;

  // ── Fonts ──
  // Google Fonts detection
  const gfMatch = html.match(/fonts\.googleapis\.com\/css2?\?family=([^"'&]+)/i);
  if (gfMatch) {
    d.google_fonts_url = gfMatch[0];
    const families = decodeURIComponent(gfMatch[1]).split('&family=');
    d.fonts = families.map(f => f.split(':')[0].replace(/\+/g, ' ').trim()).filter(Boolean);
    if (d.fonts.length >= 1) d.heading_font = d.fonts[0];
    if (d.fonts.length >= 2) d.body_font = d.fonts[1];
  }

  // CSS font-family fallback
  if (!d.heading_font) {
    const hFontMatch = html.match(/h[1-3][^{]*\{[^}]*font-family\s*:\s*["']?([^;}"']+)/i);
    if (hFontMatch) d.heading_font = hFontMatch[1].split(',')[0].trim().replace(/["']/g, '');
  }
  if (!d.body_font) {
    const bFontMatch = html.match(/body[^{]*\{[^}]*font-family\s*:\s*["']?([^;}"']+)/i);
    if (bFontMatch) d.body_font = bFontMatch[1].split(',')[0].trim().replace(/["']/g, '');
  }

  // ── Layout ──
  if (/display\s*:\s*grid/i.test(html)) d.layout_type = 'grid';
  else if (/display\s*:\s*flex/i.test(html)) d.layout_type = 'flexbox';
  else if (/<table/i.test(html) && !/<table[^>]*role/i.test(html)) d.layout_type = 'table';
  else d.layout_type = 'standard';

  const maxWMatch = html.match(/max-width\s*:\s*(\d+(?:px|rem|em))/i);
  if (maxWMatch) d.max_width = maxWMatch[1];

  // ── Section detection ──
  const sectionClasses = [];
  const sectionMatches = html.matchAll(/<(?:section|div)[^>]*(?:class|id)=["']([^"']+)["'][^>]*>/gi);
  for (const m of sectionMatches) {
    const cls = m[1].toLowerCase();
    if (/hero|banner|jumbotron|masthead|splash/i.test(cls)) sectionClasses.push('hero');
    else if (/service|feature|offering|what-we/i.test(cls)) sectionClasses.push('services');
    else if (/about|story|who-we|mission/i.test(cls)) sectionClasses.push('about');
    else if (/testimonial|review|feedback|quote/i.test(cls)) sectionClasses.push('testimonials');
    else if (/portfolio|gallery|work|project/i.test(cls)) sectionClasses.push('portfolio');
    else if (/contact|cta|call-to-action/i.test(cls)) sectionClasses.push('cta');
    else if (/pricing|plan|package/i.test(cls)) sectionClasses.push('pricing');
    else if (/team|staff|people/i.test(cls)) sectionClasses.push('team');
    else if (/faq|question/i.test(cls)) sectionClasses.push('faq');
    else if (/stat|number|counter/i.test(cls)) sectionClasses.push('stats');
  }
  d.section_types = [...new Set(sectionClasses)];
  d.section_count = d.section_types.length;

  // ── Hero style ──
  const heroHtml = (html.match(/<(?:section|div)[^>]*(?:hero|banner|jumbotron)[^>]*>([\s\S]*?)(?:<\/section|<\/div)/i) || [])[1] || '';
  if (heroHtml) {
    const hasVideo = /<video/i.test(heroHtml);
    const hasBgImage = /background[-_]?image/i.test(heroHtml);
    const isCentered = /text-(?:align|center)\s*:\s*center|text-center/i.test(heroHtml);
    const hasSplit = /grid.*1fr.*1fr|col-.*-6|split/i.test(heroHtml);
    if (hasVideo) d.hero_style = 'video-background';
    else if (hasBgImage && isCentered) d.hero_style = 'fullscreen';
    else if (hasSplit) d.hero_style = 'split';
    else if (isCentered) d.hero_style = 'centered';
    else d.hero_style = 'standard';
  }

  // ── Nav style ──
  const navHtml = (html.match(/<(?:nav|header)[^>]*>([\s\S]*?)(?:<\/nav|<\/header)/i) || [])[0] || '';
  if (/position\s*:\s*sticky/i.test(navHtml) || /position\s*:\s*sticky/i.test(html.substring(0, 5000))) d.nav_style = 'sticky';
  else if (/position\s*:\s*fixed/i.test(navHtml)) d.nav_style = 'fixed';
  else if (/transparent/i.test(navHtml)) d.nav_style = 'transparent';
  else d.nav_style = 'static';

  // ── Visual effects ──
  d.has_animations = /animation|@keyframes|transition.*transform/i.test(html);
  d.has_parallax = /parallax|data-speed|data-scroll/i.test(html);
  d.has_dark_mode = /prefers-color-scheme\s*:\s*dark|dark-mode|theme-dark/i.test(html);

  // ── Button style ──
  const btnRadiusMatch = html.match(/(?:\.btn|button)[^{]*\{[^}]*border-radius\s*:\s*(\d+)/i);
  if (btnRadiusMatch) {
    const r = parseInt(btnRadiusMatch[1]);
    d.button_style = r === 0 ? 'square' : r >= 50 ? 'pill' : r >= 12 ? 'rounded' : 'slightly-rounded';
  }

  // ── Spacing density ──
  const sectionPaddingMatch = html.match(/section[^{]*\{[^}]*padding\s*:\s*(\d+)/i);
  if (sectionPaddingMatch) {
    const p = parseInt(sectionPaddingMatch[1]);
    d.spacing_density = p >= 100 ? 'airy' : p >= 60 ? 'balanced' : 'compact';
  }

  // ── Design era ──
  const hasModernSignals = d.has_animations || d.layout_type === 'grid' || d.fonts.length > 0;
  const hasMinimalSignals = d.spacing_density === 'airy' && d.section_count <= 6;
  const hasBoldSignals = /font-weight\s*:\s*[89]00|text-transform\s*:\s*uppercase/i.test(html);
  const hasDatedSignals = d.layout_type === 'table' || /marquee|blink|Comic Sans|Papyrus/i.test(html);

  if (hasDatedSignals) d.design_era = 'dated';
  else if (hasMinimalSignals) d.design_era = 'minimal';
  else if (hasBoldSignals) d.design_era = 'bold';
  else if (hasModernSignals) d.design_era = 'modern';
  else d.design_era = 'standard';
}

// ── Utilities ─────────────────────────────────────────────────

function stripTags(html) {
  return (html || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

function resolveUrl(href, baseUrl) {
  if (!href) return '';
  if (href.startsWith('data:') || href.startsWith('javascript:')) return '';
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return '';
  }
}

function isSameDomain(url, baseUrl) {
  try {
    return new URL(url).hostname.replace('www.', '') === new URL(baseUrl).hostname.replace('www.', '');
  } catch {
    return false;
  }
}

function findSubpageUrls(navLinks, baseUrl) {
  const types = {
    about: /about|who.?we.?are|our.?story|company/i,
    services: /service|what.?we.?do|solution|offer/i,
    contact: /contact|get.?in.?touch|reach.?us/i,
    portfolio: /portfolio|gallery|our.?work|project/i,
    testimonials: /testimonial|review|feedback/i,
  };

  const found = [];
  const foundTypes = new Set();

  for (const link of navLinks) {
    for (const [type, pattern] of Object.entries(types)) {
      if (!foundTypes.has(type) && (pattern.test(link.text) || pattern.test(link.url))) {
        found.push({ url: link.url, type });
        foundTypes.add(type);
        break;
      }
    }
  }

  // Guess common paths if not found in nav
  const base = baseUrl.replace(/\/$/, '');
  const guesses = [
    { type: 'about', paths: ['/about', '/about-us', '/about.html'] },
    { type: 'services', paths: ['/services', '/our-services', '/services.html'] },
    { type: 'contact', paths: ['/contact', '/contact-us', '/contact.html'] },
  ];

  for (const g of guesses) {
    if (!foundTypes.has(g.type)) {
      found.push({ url: base + g.paths[0], type: g.type });
    }
  }

  return found.slice(0, 5);
}
