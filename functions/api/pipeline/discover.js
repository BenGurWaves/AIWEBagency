/**
 * POST /api/pipeline/discover
 *
 * Web Discovery Bot
 * ─────────────────
 * Crawls the internet to find high-quality websites in a given niche,
 * extracts their design patterns (colors, fonts, layouts, section structures),
 * and stores them as "inspiration templates" for the builder pipeline.
 *
 * This bot is 100% pure code — NO LLM, NO API calls to AI services.
 *
 * How it works:
 *   1. Maintains a curated database of award-winning/high-quality websites per niche
 *   2. Fetches 2-3 reference sites for the requested niche
 *   3. Extracts "design DNA" — colors, fonts, layout patterns, section structure, CSS techniques
 *   4. Follows outbound links to discover additional quality sites (limited depth)
 *   5. Stores extracted design patterns in KV for the builder to reference
 *   6. Returns a design intelligence report
 *
 * Body: { niche: string, email?: string, limit?: number }
 * Returns: { patterns: [...], sites_analyzed: number, stored: boolean }
 */
import { json, err, corsPreflightResponse, getKV, generateId } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);

  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON'); }

  const niche = (body.niche || '').trim().toLowerCase();
  if (!niche) return err('niche is required');

  const email = (body.email || '').trim().toLowerCase();
  const limit = Math.min(body.limit || 3, 5);

  // Check KV cache first (refresh every 7 days)
  if (kv && niche) {
    try {
      const cached = await kv.get('discover:' + niche, { type: 'json' });
      if (cached && cached.discovered_at) {
        const age = Date.now() - new Date(cached.discovered_at).getTime();
        if (age < 7 * 86400 * 1000) {
          return json({ ...cached, from_cache: true });
        }
      }
    } catch { /* proceed with fresh discovery */ }
  }

  // Get reference sites for this niche
  const referenceSites = getReferenceSites(niche);
  const sitesToAnalyze = referenceSites.slice(0, limit);

  // Fetch and analyze each site
  const patterns = [];
  const discoveredSites = [];

  const analyzePromises = sitesToAnalyze.map(async (site) => {
    try {
      const result = await analyzeSite(site);
      if (result) {
        patterns.push(result);
        // Try to discover more sites from outbound links
        const discovered = extractOutboundSites(result._html || '', site.url, niche);
        discoveredSites.push(...discovered.slice(0, 2));
      }
    } catch { /* skip failed sites */ }
  });

  await Promise.all(analyzePromises);

  // Analyze a couple discovered sites too (if time permits)
  const bonusSites = discoveredSites.slice(0, 2);
  const bonusPromises = bonusSites.map(async (site) => {
    try {
      const result = await analyzeSite(site);
      if (result) patterns.push(result);
    } catch {}
  });
  await Promise.all(bonusPromises);

  // Clean up — remove raw HTML from stored patterns
  const cleanPatterns = patterns.map(p => {
    const { _html, ...clean } = p;
    return clean;
  });

  // Build the design intelligence report
  const report = {
    niche,
    sites_analyzed: cleanPatterns.length,
    patterns: cleanPatterns,
    // Aggregate the most common design choices across analyzed sites
    aggregate: aggregatePatterns(cleanPatterns),
    discovered_at: new Date().toISOString(),
  };

  // Store in KV
  if (kv) {
    try {
      await kv.put('discover:' + niche, JSON.stringify(report), { expirationTtl: 86400 * 30 });
      report.stored = true;
    } catch { report.stored = false; }

    // Also store per-email if provided
    if (email) {
      try {
        await kv.put('discover:' + email, JSON.stringify(report), { expirationTtl: 86400 * 90 });
      } catch {}
    }
  }

  return json(report);
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}

// ── Curated Reference Sites Database ──────────────────────────
//
// Award-winning, high-quality websites organized by niche.
// These serve as design inspiration — the bot fetches and extracts
// their visual patterns for the builder to reference.

function getReferenceSites(niche) {
  const db = {
    // ── Trades / Home Services ──
    'roofing': [
      { url: 'https://www.gaf.com', category: 'roofing-manufacturer', quality: 'high' },
      { url: 'https://www.owenscorning.com/en-us/roofing', category: 'roofing-brand', quality: 'high' },
      { url: 'https://www.certainteed.com/roofing', category: 'roofing-brand', quality: 'high' },
      { url: 'https://www.davinciroofscapes.com', category: 'premium-roofing', quality: 'high' },
    ],
    'plumbing': [
      { url: 'https://www.moen.com', category: 'plumbing-brand', quality: 'high' },
      { url: 'https://www.kohler.com', category: 'plumbing-brand', quality: 'high' },
      { url: 'https://www.deltafaucet.com', category: 'plumbing-brand', quality: 'high' },
    ],
    'hvac': [
      { url: 'https://www.carrier.com', category: 'hvac-brand', quality: 'high' },
      { url: 'https://www.trane.com', category: 'hvac-brand', quality: 'high' },
      { url: 'https://www.lennox.com', category: 'hvac-brand', quality: 'high' },
    ],
    'electrical': [
      { url: 'https://www.leviton.com', category: 'electrical-brand', quality: 'high' },
      { url: 'https://www.lutron.com', category: 'lighting-controls', quality: 'high' },
    ],
    'landscaping': [
      { url: 'https://www.husqvarna.com', category: 'landscape-equipment', quality: 'high' },
      { url: 'https://www.stihl.com', category: 'landscape-brand', quality: 'high' },
    ],
    'painting': [
      { url: 'https://www.sherwin-williams.com', category: 'paint-brand', quality: 'high' },
      { url: 'https://www.benjaminmoore.com', category: 'paint-brand', quality: 'high' },
    ],
    'cleaning': [
      { url: 'https://www.mollymaid.com', category: 'cleaning-service', quality: 'high' },
      { url: 'https://www.merrymaid.com', category: 'cleaning-service', quality: 'high' },
    ],
    'construction': [
      { url: 'https://www.caterpillar.com', category: 'construction-equipment', quality: 'high' },
      { url: 'https://www.hilti.com', category: 'construction-tools', quality: 'high' },
    ],

    // ── Creative / Portfolio ──
    'photography': [
      { url: 'https://www.squarespace.com/templates/portfolio', category: 'portfolio-templates', quality: 'high' },
      { url: 'https://www.format.com', category: 'photographer-platform', quality: 'high' },
      { url: 'https://www.adobe.com/creativecloud/photography.html', category: 'photo-platform', quality: 'high' },
    ],
    'design': [
      { url: 'https://www.pentagram.com', category: 'design-agency', quality: 'premium' },
      { url: 'https://www.ideo.com', category: 'design-agency', quality: 'premium' },
      { url: 'https://www.frogdesign.com', category: 'design-agency', quality: 'high' },
    ],
    'musician': [
      { url: 'https://www.bandcamp.com', category: 'music-platform', quality: 'high' },
      { url: 'https://www.soundcloud.com', category: 'music-platform', quality: 'high' },
    ],

    // ── Food / Restaurant ──
    'restaurant': [
      { url: 'https://www.sweetgreen.com', category: 'fast-casual', quality: 'premium' },
      { url: 'https://www.shakeshack.com', category: 'restaurant-chain', quality: 'high' },
      { url: 'https://www.chipotle.com', category: 'fast-casual', quality: 'high' },
    ],
    'bakery': [
      { url: 'https://www.levainbakery.com', category: 'artisan-bakery', quality: 'high' },
      { url: 'https://www.magnoliamarket.com', category: 'bakery-brand', quality: 'high' },
    ],
    'cafe': [
      { url: 'https://bluebottlecoffee.com', category: 'specialty-coffee', quality: 'premium' },
      { url: 'https://www.intelligentsia.com', category: 'coffee-roaster', quality: 'high' },
    ],

    // ── Health / Wellness ──
    'dental': [
      { url: 'https://www.aspendentalcom', category: 'dental-chain', quality: 'high' },
      { url: 'https://www.smile.com', category: 'dental-platform', quality: 'high' },
    ],
    'fitness': [
      { url: 'https://www.equinox.com', category: 'premium-fitness', quality: 'premium' },
      { url: 'https://www.barrys.com', category: 'boutique-fitness', quality: 'high' },
      { url: 'https://www.soulcycle.com', category: 'boutique-fitness', quality: 'high' },
    ],
    'salon': [
      { url: 'https://www.drybar.com', category: 'salon-brand', quality: 'high' },
      { url: 'https://www.bumbleandbumble.com', category: 'salon-brand', quality: 'high' },
    ],
    'spa': [
      { url: 'https://www.exhalespa.com', category: 'spa-brand', quality: 'high' },
    ],
    'yoga': [
      { url: 'https://www.corepoweryoga.com', category: 'yoga-studio', quality: 'high' },
      { url: 'https://www.yogaworks.com', category: 'yoga-studio', quality: 'high' },
    ],

    // ── Professional / B2B ──
    'law': [
      { url: 'https://www.wsgr.com', category: 'law-firm', quality: 'high' },
      { url: 'https://www.cooley.com', category: 'law-firm', quality: 'high' },
    ],
    'accounting': [
      { url: 'https://www.deloitte.com', category: 'accounting-firm', quality: 'premium' },
      { url: 'https://www.bdo.com', category: 'accounting-firm', quality: 'high' },
    ],
    'real-estate': [
      { url: 'https://www.compass.com', category: 'real-estate-platform', quality: 'premium' },
      { url: 'https://www.sothebysrealty.com', category: 'luxury-real-estate', quality: 'premium' },
    ],
    'consulting': [
      { url: 'https://www.mckinsey.com', category: 'consulting-firm', quality: 'premium' },
      { url: 'https://www.bain.com', category: 'consulting-firm', quality: 'high' },
    ],
    'insurance': [
      { url: 'https://www.lemonade.com', category: 'insurance-tech', quality: 'premium' },
      { url: 'https://www.progressive.com', category: 'insurance-brand', quality: 'high' },
    ],

    // ── E-commerce / Retail ──
    'ecommerce': [
      { url: 'https://www.allbirds.com', category: 'dtc-brand', quality: 'premium' },
      { url: 'https://www.glossier.com', category: 'dtc-beauty', quality: 'premium' },
      { url: 'https://www.everlane.com', category: 'dtc-fashion', quality: 'high' },
    ],
    'boutique': [
      { url: 'https://www.anthropologie.com', category: 'boutique-retail', quality: 'high' },
      { url: 'https://www.freepeople.com', category: 'boutique-fashion', quality: 'high' },
    ],
    'jewelry': [
      { url: 'https://www.mejuri.com', category: 'jewelry-brand', quality: 'premium' },
      { url: 'https://www.catbirdnyc.com', category: 'jewelry-brand', quality: 'high' },
    ],

    // ── Automotive ──
    'auto': [
      { url: 'https://www.tesla.com', category: 'automotive', quality: 'premium' },
      { url: 'https://www.rivian.com', category: 'automotive', quality: 'premium' },
    ],

    // ── Nonprofit ──
    'nonprofit': [
      { url: 'https://www.charitywater.org', category: 'nonprofit', quality: 'premium' },
      { url: 'https://www.worldwildlife.org', category: 'nonprofit', quality: 'high' },
      { url: 'https://www.habitat.org', category: 'nonprofit', quality: 'high' },
    ],
  };

  // Direct match
  if (db[niche]) return shuffleArray(db[niche]);

  // Partial match
  for (const [key, sites] of Object.entries(db)) {
    if (niche.includes(key) || key.includes(niche)) return shuffleArray(sites);
  }

  // Archetype-based fallback
  const archetype = detectNicheArchetype(niche);
  const archetypeFallbacks = {
    'creative': [...(db['design'] || []), ...(db['photography'] || [])],
    'food': [...(db['restaurant'] || []), ...(db['cafe'] || [])],
    'wellness': [...(db['fitness'] || []), ...(db['salon'] || [])],
    'professional': [...(db['consulting'] || []), ...(db['law'] || [])],
    'ecommerce': [...(db['ecommerce'] || []), ...(db['boutique'] || [])],
    'nonprofit': db['nonprofit'] || [],
    'local-service': [...(db['roofing'] || []), ...(db['plumbing'] || []), ...(db['painting'] || [])],
  };

  return shuffleArray(archetypeFallbacks[archetype] || archetypeFallbacks['local-service']);
}

// ── Site Analysis Engine ──────────────────────────────────────

async function analyzeSite(site) {
  let html = '';
  try {
    const resp = await fetch(site.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    html = await resp.text();
  } catch {
    return null;
  }

  if (!html || html.length < 500) return null;

  return {
    url: site.url,
    category: site.category,
    quality: site.quality,
    // Design DNA extraction
    colors: extractColorPalette(html),
    fonts: extractFontStack(html),
    layout: extractLayoutPatterns(html),
    sections: extractSectionStructure(html),
    navigation: extractNavPattern(html),
    hero: extractHeroPattern(html),
    buttons: extractButtonStyles(html),
    spacing: extractSpacingPatterns(html),
    effects: extractVisualEffects(html),
    imagery: extractImageryStyle(html),
    _html: html, // kept temporarily for link extraction
  };
}

// ── Color Palette Extraction ──────────────────────────────────

function extractColorPalette(html) {
  const colors = {};

  // CSS custom properties (most reliable)
  const varMatches = html.matchAll(/--[\w-]*(?:color|bg|accent|primary|secondary|brand|text|heading)[\w-]*\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsl[a]?\([^)]+\))/gi);
  for (const m of varMatches) addColorEntry(colors, m[1], 3);

  // Direct CSS color declarations
  const hexMatches = html.matchAll(/(?:color|background(?:-color)?|border-color|fill|stroke)\s*:\s*(#[0-9a-fA-F]{3,8})/gi);
  for (const m of hexMatches) addColorEntry(colors, m[1], 1);

  // Theme color meta tag
  const themeMatch = html.match(/<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i);
  if (themeMatch) addColorEntry(colors, themeMatch[1], 5);

  // msapplication-TileColor
  const tileMatch = html.match(/<meta[^>]*name=["']msapplication-TileColor["'][^>]*content=["']([^"']+)["']/i);
  if (tileMatch) addColorEntry(colors, tileMatch[1], 4);

  // Sort by weight and categorize
  const sorted = Object.entries(colors)
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0])
    .filter(c => {
      if (!c.startsWith('#')) return false;
      const hex = c.replace('#', '').toLowerCase();
      if (hex.length < 6) return true;
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      return brightness > 10 && brightness < 245;
    })
    .slice(0, 10);

  return {
    primary: sorted[0] || null,
    secondary: sorted[1] || null,
    accent: sorted[2] || null,
    palette: sorted,
  };
}

function addColorEntry(map, color, weight) {
  const c = normalizeColor(color);
  if (!c) return;
  map[c] = (map[c] || 0) + weight;
}

function normalizeColor(color) {
  if (!color) return null;
  color = color.trim().toLowerCase();
  if (color.startsWith('#') && color.length >= 4) return color;
  // rgba(r,g,b) → hex
  const rgbaMatch = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1]).toString(16).padStart(2, '0');
    const g = parseInt(rgbaMatch[2]).toString(16).padStart(2, '0');
    const b = parseInt(rgbaMatch[3]).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  }
  return null;
}

// ── Font Stack Extraction ─────────────────────────────────────

function extractFontStack(html) {
  const fonts = {
    heading: null,
    body: null,
    google_fonts: [],
    system_fonts: [],
  };

  // Google Fonts links
  const gfMatches = html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&]+)/gi);
  for (const m of gfMatches) {
    const families = decodeURIComponent(m[1]).split('&family=');
    for (const f of families) {
      const name = f.split(':')[0].replace(/\+/g, ' ').trim();
      if (name && !fonts.google_fonts.includes(name)) {
        fonts.google_fonts.push(name);
      }
    }
  }

  // Adobe Fonts / Typekit
  if (/use\.typekit\.net|fonts\.adobe\.com/i.test(html)) {
    fonts.source = 'adobe-fonts';
  }

  // CSS font-family declarations
  const fontFamilyMatches = html.matchAll(/font-family\s*:\s*["']?([^;}"']+)["']?/gi);
  const fontFamilies = [];
  for (const m of fontFamilyMatches) {
    const family = m[1].split(',')[0].trim().replace(/["']/g, '');
    if (family && !['inherit', 'initial', 'unset', 'system-ui', '-apple-system'].includes(family.toLowerCase())) {
      fontFamilies.push(family);
    }
  }

  // Try to determine heading vs body fonts
  const headingFontMatch = html.match(/h[1-3][^{]*\{[^}]*font-family\s*:\s*["']?([^;}"']+)/i);
  if (headingFontMatch) fonts.heading = headingFontMatch[1].split(',')[0].trim().replace(/["']/g, '');

  const bodyFontMatch = html.match(/body[^{]*\{[^}]*font-family\s*:\s*["']?([^;}"']+)/i);
  if (bodyFontMatch) fonts.body = bodyFontMatch[1].split(',')[0].trim().replace(/["']/g, '');

  // Fallback: use first two unique font families
  if (!fonts.heading && fonts.google_fonts.length > 0) fonts.heading = fonts.google_fonts[0];
  if (!fonts.body && fonts.google_fonts.length > 1) fonts.body = fonts.google_fonts[1];
  if (!fonts.body && fontFamilies.length > 0) fonts.body = fontFamilies[0];

  // Detect system font usage
  if (/system-ui|-apple-system|BlinkMacSystemFont|Segoe UI/i.test(html)) {
    fonts.system_fonts.push('system-ui');
  }

  return fonts;
}

// ── Layout Pattern Extraction ─────────────────────────────────

function extractLayoutPatterns(html) {
  const layout = {
    max_width: null,
    uses_grid: false,
    uses_flexbox: false,
    column_count: null,
    has_sidebar: false,
    is_single_column: false,
    container_style: null,
  };

  // Max-width detection
  const maxWidthMatch = html.match(/max-width\s*:\s*(\d+)(px|rem|em)/i);
  if (maxWidthMatch) layout.max_width = parseInt(maxWidthMatch[1]) + maxWidthMatch[2];

  // Grid usage
  layout.uses_grid = /display\s*:\s*grid/i.test(html);
  layout.uses_flexbox = /display\s*:\s*flex/i.test(html);

  // Column patterns
  const gridColMatch = html.match(/grid-template-columns\s*:\s*repeat\(\s*(\d+)/i);
  if (gridColMatch) layout.column_count = parseInt(gridColMatch[1]);

  // Sidebar detection
  layout.has_sidebar = /sidebar|aside|left-col|right-col/i.test(html);

  // Single column (centered content)
  layout.is_single_column = !layout.has_sidebar && (!layout.column_count || layout.column_count <= 1);

  // Container width classification
  if (layout.max_width) {
    const w = parseInt(layout.max_width);
    if (w <= 800) layout.container_style = 'narrow';
    else if (w <= 1100) layout.container_style = 'standard';
    else if (w <= 1400) layout.container_style = 'wide';
    else layout.container_style = 'full-width';
  }

  return layout;
}

// ── Section Structure Extraction ──────────────────────────────

function extractSectionStructure(html) {
  const sections = [];

  // Find all major sections
  const sectionMatches = html.matchAll(/<(?:section|div)[^>]*(?:class|id)=["']([^"']+)["'][^>]*>/gi);
  for (const m of sectionMatches) {
    const classOrId = m[1].toLowerCase();

    // Classify section type
    if (/hero|banner|jumbotron|splash|masthead/i.test(classOrId)) {
      sections.push({ type: 'hero', position: sections.length });
    } else if (/service|feature|offering|capability|what-we/i.test(classOrId)) {
      sections.push({ type: 'services', position: sections.length });
    } else if (/about|story|who-we|mission/i.test(classOrId)) {
      sections.push({ type: 'about', position: sections.length });
    } else if (/testimonial|review|feedback|quote/i.test(classOrId)) {
      sections.push({ type: 'testimonials', position: sections.length });
    } else if (/portfolio|gallery|work|project|case-stud/i.test(classOrId)) {
      sections.push({ type: 'portfolio', position: sections.length });
    } else if (/contact|cta|call-to-action|get-started/i.test(classOrId)) {
      sections.push({ type: 'cta', position: sections.length });
    } else if (/pricing|plan|package/i.test(classOrId)) {
      sections.push({ type: 'pricing', position: sections.length });
    } else if (/team|staff|people/i.test(classOrId)) {
      sections.push({ type: 'team', position: sections.length });
    } else if (/faq|question|accordion/i.test(classOrId)) {
      sections.push({ type: 'faq', position: sections.length });
    } else if (/stat|number|counter|metric/i.test(classOrId)) {
      sections.push({ type: 'stats', position: sections.length });
    } else if (/blog|news|article|post/i.test(classOrId)) {
      sections.push({ type: 'blog', position: sections.length });
    } else if (/partner|client|logo|brand/i.test(classOrId)) {
      sections.push({ type: 'logos', position: sections.length });
    }
  }

  // Deduplicate by type preserving order
  const seen = new Set();
  const unique = sections.filter(s => {
    if (seen.has(s.type)) return false;
    seen.add(s.type);
    return true;
  });

  return {
    order: unique.map(s => s.type),
    total_sections: unique.length,
    has_pricing: unique.some(s => s.type === 'pricing'),
    has_faq: unique.some(s => s.type === 'faq'),
    has_team: unique.some(s => s.type === 'team'),
    has_portfolio: unique.some(s => s.type === 'portfolio'),
    has_stats: unique.some(s => s.type === 'stats'),
    has_blog: unique.some(s => s.type === 'blog'),
    has_logos: unique.some(s => s.type === 'logos'),
  };
}

// ── Navigation Pattern Extraction ─────────────────────────────

function extractNavPattern(html) {
  const nav = {
    style: 'standard',
    is_sticky: false,
    is_transparent: false,
    has_cta: false,
    has_dropdown: false,
    link_count: 0,
    has_logo: false,
  };

  // Sticky nav
  nav.is_sticky = /position\s*:\s*(?:sticky|fixed)/i.test(html) && /<nav|<header/i.test(html);

  // Transparent/overlay nav
  nav.is_transparent = /nav[^{]*\{[^}]*(?:background\s*:\s*transparent|background-color\s*:\s*transparent)/i.test(html)
    || /transparent|overlay/i.test(html.match(/<nav[^>]*class=["']([^"']+)/i)?.[1] || '');

  // CTA in nav
  const navHtml = (html.match(/<nav[^>]*>([\s\S]*?)<\/nav>/i) || [])[1] || '';
  nav.has_cta = /btn|button|cta|get-started|sign-up|contact/i.test(navHtml);

  // Dropdown menus
  nav.has_dropdown = /dropdown|submenu|sub-menu|mega-menu/i.test(html);

  // Count nav links
  const linkMatches = navHtml.match(/<a[^>]+/gi) || [];
  nav.link_count = Math.min(linkMatches.length, 20);

  // Logo presence
  nav.has_logo = /<(?:img|svg)[^>]*(?:logo|brand)/i.test(navHtml) || /class=["'][^"']*logo/i.test(navHtml);

  // Classify style
  if (nav.is_transparent && nav.link_count <= 5) nav.style = 'minimal';
  else if (nav.has_dropdown) nav.style = 'mega';
  else if (nav.link_count > 6) nav.style = 'corporate';
  else nav.style = 'standard';

  return nav;
}

// ── Hero Pattern Extraction ───────────────────────────────────

function extractHeroPattern(html) {
  const hero = {
    style: 'standard',
    has_image: false,
    has_video: false,
    text_alignment: 'left',
    has_overlay: false,
    has_badge: false,
    has_stats: false,
    cta_count: 0,
  };

  // Look for hero section
  const heroHtml = (html.match(/<(?:section|div)[^>]*(?:hero|banner|jumbotron|masthead)[^>]*>([\s\S]*?)(?:<\/section|<\/div)/i) || [])[1] || '';
  if (!heroHtml) return hero;

  // Background image
  hero.has_image = /background[-_]?image|hero[-_]?img|<img/i.test(heroHtml);

  // Video background
  hero.has_video = /<video/i.test(heroHtml);

  // Text alignment
  if (/text-(?:align|center)\s*:\s*center|text-center/i.test(heroHtml)) hero.text_alignment = 'center';

  // Overlay
  hero.has_overlay = /overlay|gradient/i.test(heroHtml);

  // Badge/tag
  hero.has_badge = /badge|tag|label|chip/i.test(heroHtml);

  // Stats in hero
  hero.has_stats = /stat|number|counter/i.test(heroHtml);

  // CTA buttons
  const ctaMatches = heroHtml.match(/<(?:a|button)[^>]*(?:btn|button|cta)/gi) || [];
  hero.cta_count = ctaMatches.length;

  // Classify hero style
  if (hero.has_video) hero.style = 'video-background';
  else if (hero.has_image && hero.has_overlay) hero.style = 'image-overlay';
  else if (hero.text_alignment === 'center' && !hero.has_image) hero.style = 'centered-text';
  else if (hero.has_stats) hero.style = 'split-with-stats';
  else hero.style = 'split-content';

  return hero;
}

// ── Button Style Extraction ───────────────────────────────────

function extractButtonStyles(html) {
  const buttons = {
    border_radius: null,
    has_rounded: false,
    has_square: false,
    has_pill: false,
    has_outline_variant: false,
    has_ghost: false,
    padding_style: 'medium',
    text_transform: 'none',
  };

  // Button border-radius
  const btnRadiusMatch = html.match(/\.btn[^{]*\{[^}]*border-radius\s*:\s*(\d+)(px|rem|em|%)/i)
    || html.match(/button[^{]*\{[^}]*border-radius\s*:\s*(\d+)(px|rem|em|%)/i);
  if (btnRadiusMatch) {
    const val = parseInt(btnRadiusMatch[1]);
    buttons.border_radius = val + btnRadiusMatch[2];
    if (val === 0) buttons.has_square = true;
    else if (val >= 50) buttons.has_pill = true;
    else buttons.has_rounded = true;
  }

  // Outline/ghost variants
  buttons.has_outline_variant = /btn[-_]outline|btn[-_]ghost|btn[-_]secondary|border.*transparent/i.test(html);
  buttons.has_ghost = /btn[-_]ghost|btn[-_]link|btn[-_]text/i.test(html);

  // Text transform
  const textTransformMatch = html.match(/\.btn[^{]*\{[^}]*text-transform\s*:\s*(\w+)/i);
  if (textTransformMatch) buttons.text_transform = textTransformMatch[1];

  return buttons;
}

// ── Spacing Pattern Extraction ────────────────────────────────

function extractSpacingPatterns(html) {
  const spacing = {
    section_padding: null,
    density: 'balanced',
    uses_generous_whitespace: false,
  };

  // Section padding
  const sectionPadding = html.match(/section[^{]*\{[^}]*padding\s*:\s*(\d+)(px|rem)/i);
  if (sectionPadding) {
    const val = parseInt(sectionPadding[1]);
    spacing.section_padding = val + sectionPadding[2];
    if (val >= 100 || (sectionPadding[2] === 'rem' && val >= 6)) {
      spacing.density = 'airy';
      spacing.uses_generous_whitespace = true;
    } else if (val <= 40 || (sectionPadding[2] === 'rem' && val <= 2.5)) {
      spacing.density = 'compact';
    }
  }

  return spacing;
}

// ── Visual Effects Extraction ─────────────────────────────────

function extractVisualEffects(html) {
  return {
    has_animations: /animation|@keyframes|transition|transform/i.test(html),
    has_parallax: /parallax|data-speed|data-scroll/i.test(html),
    has_blur: /backdrop-filter\s*:\s*blur|filter\s*:\s*blur/i.test(html),
    has_gradients: /linear-gradient|radial-gradient/i.test(html),
    has_shadows: /box-shadow|drop-shadow/i.test(html),
    has_rounded_corners: /border-radius/i.test(html),
    has_hover_effects: /:hover/i.test(html),
    has_dark_mode: /prefers-color-scheme\s*:\s*dark|dark-mode|theme-dark/i.test(html),
    has_scroll_animations: /scroll-animation|data-aos|wow\.js|gsap|framer-motion|scroll-trigger/i.test(html),
  };
}

// ── Imagery Style Extraction ──────────────────────────────────

function extractImageryStyle(html) {
  const images = (html.match(/<img[^>]+>/gi) || []).length;
  const svgs = (html.match(/<svg[^>]*>/gi) || []).length;
  const videos = (html.match(/<video[^>]*>/gi) || []).length;

  return {
    image_count: images,
    svg_count: svgs,
    video_count: videos,
    uses_lazy_loading: /loading=["']lazy/i.test(html),
    uses_webp: /\.webp/i.test(html),
    uses_icons: svgs > 3 || /fontawesome|feather|heroicons|lucide|material-icons/i.test(html),
    icon_library: /fontawesome/i.test(html) ? 'fontawesome'
      : /feather/i.test(html) ? 'feather'
      : /heroicons/i.test(html) ? 'heroicons'
      : /lucide/i.test(html) ? 'lucide'
      : /material-icons/i.test(html) ? 'material'
      : svgs > 3 ? 'custom-svg' : 'none',
    has_illustrations: /illustration|undraw|blush|humaaans/i.test(html),
  };
}

// ── Outbound Link Discovery ──────────────────────────────────

function extractOutboundSites(html, sourceUrl, niche) {
  const discovered = [];
  const sourceDomain = extractDomain(sourceUrl);
  const seen = new Set([sourceDomain]);

  // Find outbound links in footer, partners, resources sections
  const footerHtml = (html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/i) || [])[1] || '';
  const allLinks = html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>(.*?)<\/a>/gi);

  for (const m of allLinks) {
    const href = m[1];
    const text = (m[2] || '').replace(/<[^>]+>/g, '').trim().toLowerCase();
    const domain = extractDomain(href);

    if (seen.has(domain)) continue;
    if (domain.includes('google') || domain.includes('facebook') || domain.includes('twitter') ||
        domain.includes('instagram') || domain.includes('youtube') || domain.includes('linkedin') ||
        domain.includes('pinterest') || domain.includes('tiktok') || domain.includes('apple.com') ||
        domain.includes('play.google.com') || domain.includes('cdn.') || domain.includes('cloudflare')) continue;

    seen.add(domain);

    // Only keep links that seem relevant to the niche
    if (text.includes(niche) || href.includes(niche) ||
        /partner|recommend|featured|resource|similar|related|collaborate/i.test(text)) {
      discovered.push({
        url: href,
        category: 'discovered-' + niche,
        quality: 'unknown',
        found_via: text.substring(0, 60),
      });
    }
  }

  return discovered.slice(0, 5);
}

// ── Pattern Aggregation ───────────────────────────────────────

function aggregatePatterns(patterns) {
  if (!patterns.length) return {};

  const agg = {
    // Most common colors
    dominant_colors: [],
    // Most common fonts
    popular_fonts: [],
    // Layout trends
    common_layout: {},
    // Section ordering consensus
    typical_sections: [],
    // Navigation trends
    nav_trends: {},
    // Hero style trends
    hero_trends: {},
    // Button style consensus
    button_style: {},
    // Effect usage rates
    effect_popularity: {},
  };

  // Aggregate colors
  const colorCounts = {};
  for (const p of patterns) {
    if (p.colors?.palette) {
      for (const c of p.colors.palette) {
        colorCounts[c] = (colorCounts[c] || 0) + 1;
      }
    }
  }
  agg.dominant_colors = Object.entries(colorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(e => e[0]);

  // Aggregate fonts
  const fontCounts = {};
  for (const p of patterns) {
    if (p.fonts?.google_fonts) {
      for (const f of p.fonts.google_fonts) {
        fontCounts[f] = (fontCounts[f] || 0) + 1;
      }
    }
    if (p.fonts?.heading) fontCounts[p.fonts.heading] = (fontCounts[p.fonts.heading] || 0) + 2;
    if (p.fonts?.body) fontCounts[p.fonts.body] = (fontCounts[p.fonts.body] || 0) + 2;
  }
  agg.popular_fonts = Object.entries(fontCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(e => e[0]);

  // Aggregate layout
  const gridCount = patterns.filter(p => p.layout?.uses_grid).length;
  const flexCount = patterns.filter(p => p.layout?.uses_flexbox).length;
  agg.common_layout = {
    grid_usage: Math.round((gridCount / patterns.length) * 100) + '%',
    flexbox_usage: Math.round((flexCount / patterns.length) * 100) + '%',
    single_column_pct: Math.round((patterns.filter(p => p.layout?.is_single_column).length / patterns.length) * 100) + '%',
  };

  // Aggregate sections
  const sectionCounts = {};
  for (const p of patterns) {
    if (p.sections?.order) {
      for (const s of p.sections.order) {
        sectionCounts[s] = (sectionCounts[s] || 0) + 1;
      }
    }
  }
  agg.typical_sections = Object.entries(sectionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(e => e[0]);

  // Aggregate nav
  const stickyCount = patterns.filter(p => p.navigation?.is_sticky).length;
  const ctaNavCount = patterns.filter(p => p.navigation?.has_cta).length;
  agg.nav_trends = {
    sticky_pct: Math.round((stickyCount / patterns.length) * 100) + '%',
    has_cta_pct: Math.round((ctaNavCount / patterns.length) * 100) + '%',
  };

  // Aggregate hero
  const heroStyles = {};
  for (const p of patterns) {
    if (p.hero?.style) heroStyles[p.hero.style] = (heroStyles[p.hero.style] || 0) + 1;
  }
  agg.hero_trends = {
    styles: heroStyles,
    centered_text_pct: Math.round((patterns.filter(p => p.hero?.text_alignment === 'center').length / patterns.length) * 100) + '%',
  };

  // Aggregate effects
  const effectNames = ['has_animations', 'has_parallax', 'has_blur', 'has_gradients', 'has_shadows', 'has_dark_mode', 'has_scroll_animations'];
  for (const eff of effectNames) {
    const count = patterns.filter(p => p.effects?.[eff]).length;
    agg.effect_popularity[eff] = Math.round((count / patterns.length) * 100) + '%';
  }

  return agg;
}

// ── Utilities ─────────────────────────────────────────────────

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function detectNicheArchetype(niche) {
  const n = niche.toLowerCase();
  const creativeNiches = ['photography', 'videography', 'music', 'musician', 'artist', 'design', 'graphic', 'filmmaker', 'dj', 'band', 'producer', 'creative', 'art', 'illustration', 'tattoo'];
  if (creativeNiches.some(c => n.includes(c))) return 'creative';

  const foodNiches = ['restaurant', 'cafe', 'bakery', 'catering', 'bar', 'food', 'chef', 'bistro', 'pizzeria', 'brewery', 'coffee'];
  if (foodNiches.some(c => n.includes(c))) return 'food';

  const healthNiches = ['dental', 'chiropractic', 'fitness', 'personal training', 'salon', 'barbershop', 'spa', 'massage', 'yoga', 'therapy', 'medical', 'clinic', 'vet', 'wellness', 'skincare'];
  if (healthNiches.some(c => n.includes(c))) return 'wellness';

  const proNiches = ['law', 'legal', 'accounting', 'bookkeeping', 'consulting', 'insurance', 'real-estate', 'realtor', 'financial', 'marketing', 'agency', 'tech', 'software', 'it-services'];
  if (proNiches.some(c => n.includes(c))) return 'professional';

  const retailNiches = ['ecommerce', 'shop', 'store', 'retail', 'boutique', 'fashion', 'jewelry'];
  if (retailNiches.some(c => n.includes(c))) return 'ecommerce';

  if (n.includes('nonprofit') || n.includes('charity') || n.includes('foundation')) return 'nonprofit';

  return 'local-service';
}
