/**
 * POST /api/checker/analyze
 * Free website checker — analyzes a URL and returns quality scores
 */
import { json, err, corsPreflightResponse } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON'); }

  const url = (body.url || '').trim();
  if (!url) return err('url is required');

  try {
    new URL(url);
  } catch {
    return err('Invalid URL');
  }

  const results = {
    url,
    scores: {},
    details: [],
    overall: 0,
  };

  try {
    const startTime = Date.now();
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelocityChecker/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    const loadTime = Date.now() - startTime;
    const html = await resp.text();
    const contentLength = html.length;

    // === PERFORMANCE ===
    let perfScore = 100;
    if (loadTime > 5000) perfScore -= 40;
    else if (loadTime > 3000) perfScore -= 25;
    else if (loadTime > 1500) perfScore -= 10;
    if (contentLength > 500000) perfScore -= 15;
    else if (contentLength > 200000) perfScore -= 5;
    results.scores.performance = Math.max(0, perfScore);
    results.details.push({ label: 'Page load time', value: (loadTime / 1000).toFixed(1) + 's', pass: loadTime < 3000 });
    results.details.push({ label: 'Page size', value: (contentLength / 1024).toFixed(0) + ' KB', pass: contentLength < 300000 });

    // === SEO ===
    let seoScore = 0;
    const hasTitle = /<title[^>]*>.{3,}<\/title>/i.test(html);
    const hasMeta = /<meta[^>]*name=["']description["'][^>]*content=["'].{10,}["']/i.test(html);
    const hasH1 = /<h1[^>]*>/i.test(html);
    const hasCanonical = /<link[^>]*rel=["']canonical["']/i.test(html);
    const hasOG = /<meta[^>]*property=["']og:/i.test(html);
    const hasStructuredData = /application\/ld\+json/i.test(html);
    const hasLang = /<html[^>]*lang=/i.test(html);

    if (hasTitle) { seoScore += 20; results.details.push({ label: 'Page title', value: 'Found', pass: true }); }
    else results.details.push({ label: 'Page title', value: 'Missing', pass: false });

    if (hasMeta) { seoScore += 20; results.details.push({ label: 'Meta description', value: 'Found', pass: true }); }
    else results.details.push({ label: 'Meta description', value: 'Missing', pass: false });

    if (hasH1) { seoScore += 15; results.details.push({ label: 'H1 heading', value: 'Found', pass: true }); }
    else results.details.push({ label: 'H1 heading', value: 'Missing', pass: false });

    if (hasCanonical) { seoScore += 10; results.details.push({ label: 'Canonical URL', value: 'Set', pass: true }); }
    else results.details.push({ label: 'Canonical URL', value: 'Missing', pass: false });

    if (hasOG) { seoScore += 15; results.details.push({ label: 'Open Graph tags', value: 'Found', pass: true }); }
    else results.details.push({ label: 'Open Graph tags', value: 'Missing', pass: false });

    if (hasStructuredData) { seoScore += 10; results.details.push({ label: 'Structured data', value: 'Found', pass: true }); }
    else results.details.push({ label: 'Structured data', value: 'Missing', pass: false });

    if (hasLang) { seoScore += 10; results.details.push({ label: 'Lang attribute', value: 'Set', pass: true }); }
    else results.details.push({ label: 'Lang attribute', value: 'Missing', pass: false });

    results.scores.seo = Math.min(100, seoScore);

    // === MOBILE ===
    let mobileScore = 0;
    const hasViewport = /<meta[^>]*name=["']viewport["']/i.test(html);
    const hasMediaQueries = /@media/i.test(html);
    const hasTouchIcon = /apple-touch-icon/i.test(html);

    if (hasViewport) { mobileScore += 40; results.details.push({ label: 'Viewport meta tag', value: 'Found', pass: true }); }
    else results.details.push({ label: 'Viewport meta tag', value: 'Missing', pass: false });

    if (hasMediaQueries) { mobileScore += 30; results.details.push({ label: 'Responsive CSS', value: 'Found', pass: true }); }
    else results.details.push({ label: 'Responsive CSS', value: 'Not detected', pass: false });

    if (hasTouchIcon) { mobileScore += 15; results.details.push({ label: 'Touch icon', value: 'Found', pass: true }); }
    else results.details.push({ label: 'Touch icon', value: 'Missing', pass: false });

    // Check for fixed-width elements
    const hasFixedWidth = /width\s*:\s*\d{4,}px/i.test(html);
    if (!hasFixedWidth) { mobileScore += 15; results.details.push({ label: 'No fixed-width issues', value: 'Clean', pass: true }); }
    else results.details.push({ label: 'Fixed-width elements', value: 'Found (bad for mobile)', pass: false });

    results.scores.mobile = Math.min(100, mobileScore);

    // === SECURITY ===
    let secScore = 0;
    const isHttps = url.startsWith('https://');
    if (isHttps) { secScore += 50; results.details.push({ label: 'HTTPS / SSL', value: 'Secure', pass: true }); }
    else results.details.push({ label: 'HTTPS / SSL', value: 'Not secure', pass: false });

    const hasCSP = resp.headers.get('content-security-policy') !== null;
    const hasXFrame = resp.headers.get('x-frame-options') !== null;

    if (hasCSP) { secScore += 25; results.details.push({ label: 'Content Security Policy', value: 'Set', pass: true }); }
    else results.details.push({ label: 'Content Security Policy', value: 'Missing', pass: false });

    if (hasXFrame) { secScore += 25; results.details.push({ label: 'X-Frame-Options', value: 'Set', pass: true }); }
    else results.details.push({ label: 'X-Frame-Options', value: 'Missing', pass: false });

    results.scores.security = Math.min(100, secScore);

    // === ACCESSIBILITY ===
    let a11yScore = 0;
    const imgCount = (html.match(/<img/gi) || []).length;
    const imgAltCount = (html.match(/<img[^>]*alt=["'][^"']+["']/gi) || []).length;
    const altRatio = imgCount > 0 ? imgAltCount / imgCount : 1;

    if (altRatio >= 0.9) { a11yScore += 30; results.details.push({ label: 'Image alt text', value: Math.round(altRatio * 100) + '% coverage', pass: true }); }
    else results.details.push({ label: 'Image alt text', value: Math.round(altRatio * 100) + '% coverage', pass: false });

    const hasAriaLabels = /aria-label/i.test(html);
    if (hasAriaLabels) { a11yScore += 20; results.details.push({ label: 'ARIA labels', value: 'Found', pass: true }); }
    else results.details.push({ label: 'ARIA labels', value: 'Not detected', pass: false });

    const hasSkipLink = /skip.*nav|skip.*content|skip.*main/i.test(html);
    if (hasSkipLink) { a11yScore += 15; results.details.push({ label: 'Skip navigation', value: 'Found', pass: true }); }
    else results.details.push({ label: 'Skip navigation', value: 'Missing', pass: false });

    const hasFocusStyles = /focus/i.test(html);
    if (hasFocusStyles) { a11yScore += 15; }

    const hasSemanticHtml = /<(header|main|footer|nav|section|article|aside)\b/i.test(html);
    if (hasSemanticHtml) { a11yScore += 20; results.details.push({ label: 'Semantic HTML', value: 'Used', pass: true }); }
    else results.details.push({ label: 'Semantic HTML', value: 'Missing', pass: false });

    results.scores.accessibility = Math.min(100, a11yScore);

    // Overall score
    results.overall = Math.round(
      (results.scores.performance * 0.25) +
      (results.scores.seo * 0.25) +
      (results.scores.mobile * 0.2) +
      (results.scores.security * 0.15) +
      (results.scores.accessibility * 0.15)
    );

  } catch (e) {
    return err('Could not reach website. Check the URL and try again.');
  }

  return json(results);
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
