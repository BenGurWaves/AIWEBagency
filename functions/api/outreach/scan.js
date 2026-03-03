/**
 * POST /api/outreach/scan
 *
 * Automated prospect scanner. Given a business URL, it:
 *   1. Fetches the website
 *   2. Analyzes quality signals (speed, mobile, SSL, design age)
 *   3. Extracts business info (name, phone, email, location)
 *   4. Scores the site (higher = worse = better prospect)
 *   5. Stores as a prospect in KV
 *
 * Body: { url: string }
 * Returns: { prospect: { ... }, score: number, issues: [...] }
 *
 * Can also accept a batch:
 * Body: { urls: [string, string, ...] }
 * Returns: { prospects: [...] }
 */
import { json, err, corsPreflightResponse, getKV, generateId, esc } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);

  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON'); }

  // Single URL or batch
  const urls = body.urls || (body.url ? [body.url] : []);
  if (!urls.length) return err('url or urls[] required');
  if (urls.length > 10) return err('Maximum 10 URLs per batch');

  const prospects = [];

  for (const rawUrl of urls) {
    let url = rawUrl.trim();
    if (!url) continue;
    if (!url.startsWith('http')) url = 'https://' + url;

    try {
      const prospect = await analyzeProspect(url);
      prospects.push(prospect);

      // Store in KV if available
      if (kv) {
        const key = 'prospect:' + prospect.domain;
        await kv.put(key, JSON.stringify(prospect), { expirationTtl: 86400 * 30 });
      }
    } catch (e) {
      prospects.push({
        url,
        error: e.message,
        score: 0,
      });
    }
  }

  return json({ prospects });
}

async function analyzeProspect(url) {
  const startTime = Date.now();
  const issues = [];
  let html = '';
  let statusCode = 0;
  let isHttps = url.startsWith('https');
  let loadTime = 0;

  // ── Fetch the site ──
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    statusCode = resp.status;
    html = await resp.text();
    loadTime = Date.now() - startTime;

    // Check final URL for HTTPS
    isHttps = resp.url.startsWith('https');
  } catch (e) {
    issues.push('Site unreachable or extremely slow');
    return {
      url,
      domain: extractDomain(url),
      reachable: false,
      score: 95,
      issues,
      scanned_at: new Date().toISOString(),
    };
  }

  // ── Extract business info ──
  const info = extractInfo(html, url);

  // ── Score the site (higher = worse website = better prospect) ──
  let score = 0;

  // Speed issues
  if (loadTime > 5000) { score += 20; issues.push('Very slow load time (' + Math.round(loadTime / 1000) + 's)'); }
  else if (loadTime > 3000) { score += 12; issues.push('Slow load time (' + Math.round(loadTime / 1000) + 's)'); }
  else if (loadTime > 2000) { score += 5; issues.push('Moderate load time'); }

  // SSL
  if (!isHttps) { score += 15; issues.push('No HTTPS/SSL — shows "Not Secure" warning'); }

  // Mobile viewport
  if (!html.includes('viewport')) { score += 20; issues.push('No mobile viewport — not mobile-friendly'); }

  // Old technology signals
  if (html.includes('<!--[if IE') || html.includes('X-UA-Compatible')) { score += 10; issues.push('IE compatibility code — outdated site'); }
  if (/<table[^>]*width=/i.test(html)) { score += 12; issues.push('Table-based layout — early 2000s design'); }
  if (/marquee/i.test(html)) { score += 15; issues.push('Uses <marquee> tag — extremely dated'); }
  if (/Comic Sans/i.test(html)) { score += 8; issues.push('Uses Comic Sans font'); }
  if (/<blink/i.test(html)) { score += 10; issues.push('Uses <blink> tag'); }
  if (/Under Construction/i.test(html)) { score += 12; issues.push('"Under construction" message'); }

  // WordPress/builder bloat
  if (/wp-content/i.test(html)) {
    // Check for excessive plugins
    const pluginMatches = html.match(/wp-content\/plugins\//gi) || [];
    if (pluginMatches.length > 10) { score += 8; issues.push('WordPress with ' + pluginMatches.length + '+ plugins (bloated)'); }
  }

  // Missing meta tags
  if (!/<meta[^>]*description/i.test(html)) { score += 8; issues.push('Missing meta description — poor SEO'); }
  if (!/<meta[^>]*og:/i.test(html) && !/<meta[^>]*property="og:/i.test(html)) { score += 5; issues.push('No Open Graph tags — poor social sharing'); }

  // No structured data
  if (!html.includes('schema.org') && !html.includes('application/ld+json')) { score += 5; issues.push('No structured data / schema markup'); }

  // Large page size (rough estimate from HTML length)
  const sizeKB = Math.round(html.length / 1024);
  if (sizeKB > 500) { score += 10; issues.push('Very large page (' + sizeKB + ' KB HTML)'); }

  // Flash/Java/Silverlight
  if (/\.swf|flash|shockwave/i.test(html)) { score += 15; issues.push('Uses Flash — obsolete technology'); }

  // Inline styles abuse
  const inlineStyles = (html.match(/style="/gi) || []).length;
  if (inlineStyles > 50) { score += 5; issues.push('Excessive inline styles — poor code quality'); }

  // Cap score at 100
  score = Math.min(score, 100);

  return {
    url,
    domain: info.domain,
    reachable: true,
    status_code: statusCode,
    load_time_ms: loadTime,
    is_https: isHttps,
    business_name: info.name,
    phone: info.phone,
    email: info.email,
    address: info.address,
    tagline: info.tagline,
    score,
    issues,
    page_size_kb: sizeKB,
    scanned_at: new Date().toISOString(),
  };
}

function extractInfo(html, url) {
  const info = { name: '', phone: '', email: '', address: '', tagline: '', domain: '' };
  try { info.domain = new URL(url).hostname.replace('www.', ''); } catch { info.domain = url; }
  if (!html) return info;

  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (titleMatch) {
    let t = titleMatch[1].replace(/\s*[-|–—:].*/g, '').replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/<[^>]+>/g, '').trim();
    if (t.length > 2 && t.length < 60) info.name = t;
  }
  const phoneMatch = html.match(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
  if (phoneMatch) info.phone = phoneMatch[1];
  const emailMatch = html.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch && !emailMatch[1].includes('example.') && !emailMatch[1].includes('wix') && !emailMatch[1].includes('wordpress')) {
    info.email = emailMatch[1];
  }
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/i);
  if (descMatch && descMatch[1].length > 10 && descMatch[1].length < 200) info.tagline = descMatch[1];
  const addrMatch = html.match(/\d{2,5}\s+[\w\s.]+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct|Pl)[.,]?\s*(?:Suite|Ste|#|Apt)?\s*\d*[.,]?\s*\w+[.,]?\s*[A-Z]{2}\s+\d{5}/i);
  if (addrMatch) info.address = addrMatch[0].trim();
  return info;
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
