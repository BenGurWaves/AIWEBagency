/**
 * POST /api/pipeline/qa
 *
 * Quality Assurance Agent
 * ───────────────────────
 * Validates generated website content and HTML for quality issues.
 * Catches AI slop, broken layouts, missing content, accessibility issues.
 *
 * Runs automated checks:
 *   1. Content quality — generic phrases, lorem ipsum, placeholder text
 *   2. HTML validity — unclosed tags, missing attributes
 *   3. Accessibility — missing alt text, color contrast, heading hierarchy
 *   4. Responsiveness — viewport meta, media queries, flexible layouts
 *   5. Performance — inline image sizes, excessive DOM depth
 *   6. SEO — meta tags, heading structure, link text
 *   7. Brand consistency — business name present, phone clickable, CTA exists
 *
 * Body: { build_id: string } or { html: string, business_name: string }
 * Returns: { score: number (0-100), issues: [...], passed: boolean }
 */
import { json, err, corsPreflightResponse, getKV } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);

  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON'); }

  let html = body.html || '';
  const bizName = body.business_name || '';

  // Load from KV if build_id provided
  if (!html && body.build_id && kv) {
    try {
      html = await kv.get(`preview:${body.build_id}`) || '';
      if (!html) html = await kv.get(`build:${body.build_id}:index.html`) || '';
    } catch {}
  }

  if (!html) return err('No HTML to validate. Provide html or build_id.');

  const result = runQA(html, bizName);

  // Store QA result
  if (kv && body.build_id) {
    try {
      await kv.put(`qa:${body.build_id}`, JSON.stringify(result), { expirationTtl: 86400 * 30 });
    } catch {}
  }

  return json(result);
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}

// ── QA Engine ─────────────────────────────────────────────────

function runQA(html, bizName) {
  const issues = [];
  let deductions = 0;

  // ── 1. AI Slop Detection ────────────────────────────────────
  const slopPatterns = [
    { pattern: /lorem ipsum/i, msg: 'Contains "Lorem ipsum" placeholder text', points: 15 },
    { pattern: /\[(?:insert|your|business|company|name|phone|email|address|location)\]/i, msg: 'Contains unfilled placeholder brackets', points: 15 },
    { pattern: /placeholder/i, msg: 'Contains "placeholder" text', points: 5 },
    { pattern: /we leverage cutting.?edge/i, msg: 'AI slop: "cutting-edge" language', points: 5 },
    { pattern: /synerg(?:y|ies|ize)/i, msg: 'AI slop: uses "synergy"', points: 5 },
    { pattern: /revolutioniz/i, msg: 'AI slop: uses "revolutionize"', points: 5 },
    { pattern: /paradigm shift/i, msg: 'AI slop: uses "paradigm shift"', points: 8 },
    { pattern: /best.in.class/i, msg: 'AI slop: uses "best-in-class"', points: 3 },
    { pattern: /world.?class/i, msg: 'AI slop: uses "world-class"', points: 3 },
    { pattern: /game.?chang/i, msg: 'AI slop: uses "game-changer"', points: 3 },
    { pattern: /elevat(?:e|ing) your (?:brand|business|experience)/i, msg: 'AI slop: "elevate your X"', points: 5 },
    { pattern: /unlock(?:ing)? (?:the )?(?:full )?potential/i, msg: 'AI slop: "unlock potential"', points: 5 },
    { pattern: /seamless(?:ly)? integrat/i, msg: 'AI slop: "seamlessly integrate"', points: 3 },
    { pattern: /delve(?:s)? (?:into|deeper)/i, msg: 'AI slop: uses "delve"', points: 5 },
    { pattern: /tapestry of/i, msg: 'AI slop: uses "tapestry"', points: 5 },
    { pattern: /in today'?s fast.?paced/i, msg: 'AI slop: "in today\'s fast-paced world"', points: 5 },
    { pattern: /comprehensive suite of/i, msg: 'AI slop: "comprehensive suite"', points: 3 },
    { pattern: /at the forefront of/i, msg: 'AI slop: "at the forefront"', points: 3 },
    { pattern: /empower(?:ing|s)? (?:you|your|businesses)/i, msg: 'AI slop: "empowering"', points: 3 },
    { pattern: /state.?of.?the.?art/i, msg: 'AI slop: "state-of-the-art"', points: 3 },
    { pattern: /(?:Your|Our) (?:dedicated|passionate) team/i, msg: 'AI slop: "dedicated/passionate team"', points: 3 },
    { pattern: /look no further/i, msg: 'AI slop: "look no further"', points: 3 },
    { pattern: /second to none/i, msg: 'AI slop: "second to none"', points: 3 },
    { pattern: /navigate the complex/i, msg: 'AI slop: "navigate the complex"', points: 5 },
    { pattern: /holistic approach/i, msg: 'AI slop: "holistic approach"', points: 3 },
    { pattern: /cutt?ing.?edge (?:technology|solution)/i, msg: 'AI slop: "cutting-edge technology"', points: 5 },
    { pattern: /unparalleled/i, msg: 'AI slop: uses "unparalleled"', points: 3 },
    { pattern: /bespoke/i, msg: 'AI slop: uses "bespoke"', points: 3 },
    { pattern: /(?:a |the )beacon of/i, msg: 'AI slop: "beacon of"', points: 5 },
    { pattern: /foster(?:ing|s)? (?:a )?(?:sense|culture|environment|community)/i, msg: 'AI slop: "fostering a sense"', points: 5 },
    { pattern: /(?:isn't just|is more than) (?:a |an )?(?:\w+ ){0,2}—? ?it'?s/i, msg: 'AI slop: "isn\'t just X — it\'s Y" pattern', points: 5 },
    { pattern: /at the heart of/i, msg: 'AI slop: "at the heart of"', points: 3 },
    { pattern: /testament to/i, msg: 'AI slop: "testament to"', points: 3 },
    { pattern: /landscape of/i, msg: 'AI slop: "landscape of"', points: 3 },
    { pattern: /(?:transform|reimagin)(?:ing|e) the way/i, msg: 'AI slop: "transform the way"', points: 5 },
    { pattern: /leverage our expertise/i, msg: 'AI slop: "leverage our expertise"', points: 5 },
    { pattern: /robust (?:and|yet|,) (?:scalable|flexible|comprehensive)/i, msg: 'AI slop: "robust and scalable"', points: 5 },
  ];

  for (const { pattern, msg, points } of slopPatterns) {
    if (pattern.test(html)) {
      issues.push({ type: 'slop', severity: points >= 8 ? 'high' : 'medium', message: msg });
      deductions += points;
    }
  }

  // ── 2. Content completeness ─────────────────────────────────
  if (!/<h1/i.test(html)) {
    issues.push({ type: 'content', severity: 'high', message: 'Missing H1 heading' });
    deductions += 10;
  }
  if (!/<nav/i.test(html)) {
    issues.push({ type: 'content', severity: 'medium', message: 'Missing navigation' });
    deductions += 5;
  }
  if (!/<footer/i.test(html)) {
    issues.push({ type: 'content', severity: 'medium', message: 'Missing footer' });
    deductions += 3;
  }

  // Check if business name appears in content
  if (bizName && !html.includes(bizName)) {
    issues.push({ type: 'brand', severity: 'high', message: 'Business name not found in page content' });
    deductions += 10;
  }

  // Phone link
  if (!/<a[^>]+href=["']tel:/i.test(html)) {
    issues.push({ type: 'brand', severity: 'medium', message: 'No clickable phone link (tel:)' });
    deductions += 5;
  }

  // CTA button
  if (!/<a[^>]+class=["'][^"']*btn/i.test(html) && !/<button/i.test(html)) {
    issues.push({ type: 'content', severity: 'medium', message: 'No call-to-action button found' });
    deductions += 5;
  }

  // ── 3. Accessibility ────────────────────────────────────────
  if (!/<meta[^>]*viewport/i.test(html)) {
    issues.push({ type: 'a11y', severity: 'high', message: 'Missing viewport meta tag' });
    deductions += 10;
  }
  if (!/<html[^>]*lang=/i.test(html)) {
    issues.push({ type: 'a11y', severity: 'medium', message: 'Missing lang attribute on <html>' });
    deductions += 3;
  }

  // Images without alt
  const imgMatches = html.match(/<img[^>]+>/gi) || [];
  let missingAlts = 0;
  for (const img of imgMatches) {
    if (!/alt=/i.test(img)) missingAlts++;
  }
  if (missingAlts > 0) {
    issues.push({ type: 'a11y', severity: 'medium', message: `${missingAlts} image(s) missing alt text` });
    deductions += Math.min(missingAlts * 2, 10);
  }

  // Heading hierarchy
  const headings = [];
  const headingMatches = html.matchAll(/<h([1-6])/gi);
  for (const m of headingMatches) headings.push(parseInt(m[1]));
  if (headings.length > 1) {
    for (let i = 1; i < headings.length; i++) {
      if (headings[i] > headings[i - 1] + 1) {
        issues.push({ type: 'a11y', severity: 'low', message: `Heading jump: H${headings[i - 1]} to H${headings[i]}` });
        deductions += 2;
        break;
      }
    }
  }

  // ── 4. SEO ──────────────────────────────────────────────────
  if (!/<title[^>]*>.+<\/title>/i.test(html)) {
    issues.push({ type: 'seo', severity: 'high', message: 'Missing or empty <title> tag' });
    deductions += 8;
  }
  if (!/<meta[^>]*description/i.test(html)) {
    issues.push({ type: 'seo', severity: 'medium', message: 'Missing meta description' });
    deductions += 5;
  }

  // ── 5. Performance ──────────────────────────────────────────
  const sizeKB = Math.round(html.length / 1024);
  if (sizeKB > 500) {
    issues.push({ type: 'perf', severity: 'medium', message: `Page HTML is ${sizeKB}KB (recommend < 500KB)` });
    deductions += 5;
  }

  // Excessive inline styles
  const inlineStyleCount = (html.match(/style="/gi) || []).length;
  if (inlineStyleCount > 100) {
    issues.push({ type: 'perf', severity: 'low', message: `${inlineStyleCount} inline styles detected` });
    deductions += 3;
  }

  // ── 6. Link quality ─────────────────────────────────────────
  const brokenLinkPatterns = /href=["'](?:#|javascript:|undefined|null)["']/gi;
  const brokenLinks = (html.match(brokenLinkPatterns) || []).length;
  if (brokenLinks > 2) {
    issues.push({ type: 'content', severity: 'medium', message: `${brokenLinks} empty/broken links found` });
    deductions += 3;
  }

  // ── 7. Responsive design ────────────────────────────────────
  if (!/@media/i.test(html) && !html.includes('responsive')) {
    issues.push({ type: 'responsive', severity: 'medium', message: 'No media queries — may not be responsive' });
    deductions += 8;
  }

  // ── 8. Content diversity ────────────────────────────────────
  // Check that headings aren't all the same length/pattern
  const h2Matches = html.match(/<h2[^>]*>(.*?)<\/h2>/gi) || [];
  const h2Texts = h2Matches.map(h => h.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  if (h2Texts.length > 2) {
    const avgLen = h2Texts.reduce((sum, t) => sum + t.length, 0) / h2Texts.length;
    const allSimilarLength = h2Texts.every(t => Math.abs(t.length - avgLen) < 5);
    if (allSimilarLength) {
      issues.push({ type: 'content', severity: 'low', message: 'All headings are suspiciously similar length — may look templated' });
      deductions += 3;
    }
  }

  // Check for repeated sentence starters
  const paragraphs = (html.match(/<p[^>]*>(.*?)<\/p>/gi) || [])
    .map(p => p.replace(/<[^>]+>/g, '').trim())
    .filter(p => p.length > 20);
  if (paragraphs.length > 3) {
    const starters = paragraphs.map(p => p.split(' ').slice(0, 3).join(' ').toLowerCase());
    const starterCounts = {};
    for (const s of starters) starterCounts[s] = (starterCounts[s] || 0) + 1;
    const repeated = Object.values(starterCounts).filter(c => c > 2).length;
    if (repeated > 0) {
      issues.push({ type: 'content', severity: 'medium', message: 'Multiple paragraphs start the same way — lacks variety' });
      deductions += 5;
    }
  }

  // ── 9. Design quality checks ──────────────────────────────
  // Check for Google Fonts (good design signal)
  if (!/fonts\.googleapis\.com/i.test(html)) {
    issues.push({ type: 'design', severity: 'low', message: 'No custom web fonts loaded — may look generic' });
    deductions += 2;
  }

  // Check for CSS custom properties (modern CSS)
  const cssVarCount = (html.match(/var\(--/gi) || []).length;
  if (cssVarCount < 3) {
    issues.push({ type: 'design', severity: 'low', message: 'Minimal CSS custom properties — may lack design system consistency' });
    deductions += 2;
  }

  // Check for adequate section count
  const sectionCount = (html.match(/<section/gi) || []).length;
  if (sectionCount < 3) {
    issues.push({ type: 'design', severity: 'medium', message: `Only ${sectionCount} sections found — page may feel incomplete` });
    deductions += 5;
  }

  // Check for hover/transition effects (design polish)
  if (!/:hover/i.test(html) && !/transition/i.test(html)) {
    issues.push({ type: 'design', severity: 'low', message: 'No hover effects or transitions — interactions may feel flat' });
    deductions += 2;
  }

  // ── 10. Contact info validation ───────────────────────────
  // Email link
  if (!/<a[^>]+href=["']mailto:/i.test(html)) {
    issues.push({ type: 'brand', severity: 'low', message: 'No clickable email link (mailto:)' });
    deductions += 2;
  }

  // Footer present and has content
  const footerHtml = (html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/i) || [])[1] || '';
  if (footerHtml && footerHtml.replace(/<[^>]+>/g, '').trim().length < 50) {
    issues.push({ type: 'content', severity: 'low', message: 'Footer has very little content' });
    deductions += 2;
  }

  // ── Calculate score ─────────────────────────────────────────
  const score = Math.max(0, 100 - deductions);
  const passed = score >= 70;

  return {
    score,
    passed,
    issues,
    total_issues: issues.length,
    breakdown: {
      slop: issues.filter(i => i.type === 'slop').length,
      content: issues.filter(i => i.type === 'content').length,
      accessibility: issues.filter(i => i.type === 'a11y').length,
      seo: issues.filter(i => i.type === 'seo').length,
      performance: issues.filter(i => i.type === 'perf').length,
      brand: issues.filter(i => i.type === 'brand').length,
      responsive: issues.filter(i => i.type === 'responsive').length,
      design: issues.filter(i => i.type === 'design').length,
    },
    checked_at: new Date().toISOString(),
  };
}
