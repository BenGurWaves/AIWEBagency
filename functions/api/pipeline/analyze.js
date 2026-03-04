/**
 * POST /api/pipeline/analyze
 * Body: { project_id }
 *
 * Runs the analysis pipeline:
 *   1. Fetch target website HTML
 *   2. Extract business info (name, phone, email, tagline)
 *   3. Generate redesign preview from template
 *   4. Store preview HTML in KV
 *   5. Mark project as preview_ready
 */
import { json, err, corsPreflightResponse, getSession, getKV, esc } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);
  if (!kv) return err('Storage not configured', 500);

  const session = await getSession(kv, context.request);
  if (!session) return err('Not authenticated', 401);

  let body;
  try {
    body = await context.request.json();
  } catch {
    return err('Invalid JSON');
  }

  const projectId = (body.project_id || '').trim();
  if (!projectId) return err('project_id is required');

  const project = await kv.get(`project:${projectId}`, { type: 'json' });
  if (!project) return err('Project not found', 404);
  if (project.user_email !== session.email) return err('Forbidden', 403);

  // Already complete?
  if (project.status === 'preview_ready' || project.status === 'deployed') {
    return json({ project });
  }

  // ── Step 1: Analyzing (10%) ──────────────────────────────
  project.status = 'analyzing';
  project.progress = 10;
  await kv.put(`project:${projectId}`, JSON.stringify(project), { expirationTtl: 86400 * 365 });

  // ── Step 2: Fetch website (30%) ──────────────────────────
  let siteHtml = '';
  try {
    const resp = await fetch(project.website_url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VelocityBot/1.0)' },
      redirect: 'follow',
    });
    siteHtml = await resp.text();
  } catch {
    siteHtml = '';
  }

  project.progress = 30;
  await kv.put(`project:${projectId}`, JSON.stringify(project), { expirationTtl: 86400 * 365 });

  // ── Step 3: Extract business info (50%) ──────────────────
  const info = extractBusinessInfo(siteHtml, project.website_url);
  project.business_info = info;
  project.progress = 50;
  await kv.put(`project:${projectId}`, JSON.stringify(project), { expirationTtl: 86400 * 365 });

  // ── Step 4: Generate preview (80%) ───────────────────────
  const previewHtml = generatePreview(info);

  // Store preview HTML separately (KV value limit is 25MB, plenty for HTML)
  await kv.put(`preview:${projectId}`, previewHtml, { expirationTtl: 86400 * 365 });

  project.progress = 80;
  project.preview_url = `/preview/${projectId}`;
  await kv.put(`project:${projectId}`, JSON.stringify(project), { expirationTtl: 86400 * 365 });

  // ── Step 5: Done (100%) ──────────────────────────────────
  project.status = 'preview_ready';
  project.progress = 100;
  project.preview_ready_at = new Date().toISOString();
  await kv.put(`project:${projectId}`, JSON.stringify(project), { expirationTtl: 86400 * 365 });

  return json({ project });
}

// ── Business info extraction from HTML ────────────────────

function extractBusinessInfo(html, url) {
  const info = {
    name: 'Your Business',
    phone: '',
    email: '',
    address: '',
    tagline: '',
    domain: '',
  };

  // Extract domain for display
  try {
    info.domain = new URL(url).hostname.replace('www.', '');
  } catch {
    info.domain = url;
  }

  if (!html) return info;

  // Title tag → business name
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (titleMatch) {
    let title = titleMatch[1]
      .replace(/\s*[-|–—:]\s*.*/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#\d+;/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (title && title.length > 2 && title.length < 60) info.name = title;
  }

  // Phone number
  const phoneMatch = html.match(/(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
  if (phoneMatch) info.phone = phoneMatch[1];

  // Email
  const emailMatch = html.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) info.email = emailMatch[1];

  // Meta description → tagline
  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["'](.*?)["']/i);
  if (descMatch && descMatch[1].length > 10 && descMatch[1].length < 200) {
    info.tagline = descMatch[1];
  }

  // Address (look for common patterns)
  const addrMatch = html.match(/\d{2,5}\s+[\w\s.]+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct|Pl)[.,]?\s*(?:Suite|Ste|#|Apt)?\s*\d*[.,]?\s*\w+[.,]?\s*[A-Z]{2}\s+\d{5}/i);
  if (addrMatch) info.address = addrMatch[0].trim();

  return info;
}

// ── Preview HTML generation ───────────────────────────────

function generatePreview(info) {
  const name = esc(info.name);
  const phone = esc(info.phone || '(555) 123-4567');
  const tagline = esc(info.tagline || 'Quality service you can trust.');
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${name} — Redesigned by Velocity</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: Georgia, 'Times New Roman', serif;
    background: #0f0d0b;
    color: #e2d9cf;
    font-size: 14px;
    line-height: 1.6;
    overflow-x: hidden;
  }
  body::after {
    content: '';
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 999;
    opacity: 0.025;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-repeat: repeat;
    background-size: 256px 256px;
  }
  .sans { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 24px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .logo { font-size: 18px; color: #e2d9cf; }
  .logo em { color: #c8956a; font-style: normal; }
  nav .links { display: flex; gap: 20px; font-family: -apple-system, system-ui, sans-serif; font-size: 12px; }
  nav .links a { color: #8a8078; text-decoration: none; }
  nav .links a:hover { color: #e2d9cf; }
  .hero {
    padding: 60px 24px 48px;
    max-width: 600px;
  }
  .hero-label {
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: #c8956a;
    margin-bottom: 12px;
  }
  .hero h1 {
    font-size: 36px;
    font-weight: 400;
    line-height: 1.12;
    margin-bottom: 14px;
    letter-spacing: -0.01em;
  }
  .hero h1 em { color: #c8956a; font-style: italic; }
  .hero p {
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 14px;
    color: #8a8078;
    line-height: 1.65;
    margin-bottom: 24px;
  }
  .cta-btn {
    display: inline-block;
    background: #c8956a;
    color: #0f0d0b;
    padding: 12px 28px;
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    border-radius: 6px;
    text-decoration: none;
    transition: background 0.2s;
  }
  .cta-btn:hover { background: #d4a57a; }
  .ghost-btn {
    display: inline-block;
    color: #8a8078;
    padding: 12px 20px;
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 13px;
    text-decoration: none;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 6px;
    margin-left: 8px;
    transition: color 0.2s, border-color 0.2s;
  }
  .ghost-btn:hover { color: #e2d9cf; border-color: rgba(255,255,255,0.2); }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    padding: 0 24px 48px;
  }
  .stat-card {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.05);
    border-radius: 12px;
    padding: 20px;
    text-align: center;
  }
  .stat-num {
    display: block;
    font-size: 32px;
    color: #c8956a;
    line-height: 1;
    margin-bottom: 4px;
  }
  .stat-text {
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 10px;
    color: #6a6460;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .section {
    padding: 40px 24px;
    border-top: 1px solid rgba(255,255,255,0.05);
  }
  .section-label {
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: #c8956a;
    margin-bottom: 6px;
  }
  .section h2 {
    font-size: 24px;
    font-weight: 400;
    margin-bottom: 20px;
  }
  .services-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .service-item {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.05);
    border-radius: 8px;
    padding: 16px;
  }
  .service-item h3 {
    font-size: 15px;
    font-weight: 400;
    margin-bottom: 4px;
  }
  .service-item p {
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 12px;
    color: #6a6460;
    line-height: 1.5;
  }
  .testimonial {
    padding: 40px 24px;
    border-top: 1px solid rgba(255,255,255,0.05);
  }
  .testimonial blockquote {
    font-size: 17px;
    font-style: italic;
    line-height: 1.5;
    color: #c4bab0;
    border-left: 2px solid #c8956a;
    padding-left: 16px;
    margin-bottom: 10px;
  }
  .testimonial cite {
    font-family: -apple-system, system-ui, sans-serif;
    font-style: normal;
    font-size: 12px;
    color: #6a6460;
  }
  .final-cta {
    padding: 48px 24px;
    border-top: 1px solid rgba(255,255,255,0.05);
    text-align: center;
  }
  .final-cta h2 {
    font-size: 26px;
    font-weight: 400;
    margin-bottom: 10px;
  }
  .final-cta h2 em { color: #c8956a; font-style: italic; }
  .final-cta p {
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 13px;
    color: #6a6460;
    margin-bottom: 20px;
  }
  footer {
    padding: 28px 24px;
    border-top: 1px solid rgba(255,255,255,0.05);
    text-align: center;
  }
  footer .foot-logo { font-size: 16px; margin-bottom: 6px; }
  footer .foot-logo em { color: #c8956a; font-style: normal; }
  footer p {
    font-family: -apple-system, system-ui, sans-serif;
    font-size: 11px;
    color: #4a4540;
    line-height: 1.6;
  }
  .badge {
    display: inline-block;
    background: rgba(200,149,106,0.1);
    color: #c8956a;
    font-size: 10px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 4px;
    margin-top: 8px;
  }
  .velocity-watermark{position:fixed;inset:0;z-index:9998;pointer-events:none;overflow:hidden;opacity:.045}
  .velocity-watermark-inner{position:absolute;top:-50%;left:-50%;width:200%;height:200%;transform:rotate(-30deg);display:flex;flex-wrap:wrap;gap:80px 60px;align-content:flex-start;justify-content:center}
  .velocity-watermark-inner span{font-family:sans-serif;font-size:14px;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:#c8956a;white-space:nowrap}
  @media (max-width: 480px) {
    .stats { grid-template-columns: 1fr; }
    .services-grid { grid-template-columns: 1fr; }
    .hero h1 { font-size: 28px; }
  }
</style>
</head>
<body>
<div class="velocity-watermark"><div class="velocity-watermark-inner">${Array(120).fill('<span>VELOCITY PREVIEW</span>').join('')}</div></div>
<nav>
  <div class="logo">${name}<em>.</em></div>
  <div class="links">
    <a href="#">Services</a>
    <a href="#">About</a>
    <a href="#">Contact</a>
  </div>
</nav>
<div class="hero">
  <div class="hero-label">Welcome to ${name}</div>
  <h1>Quality you can <em>trust.</em></h1>
  <p>${tagline}</p>
  <a href="tel:${esc(phone.replace(/[^0-9+]/g, ''))}" class="cta-btn">Call ${phone}</a>
  <a href="#" class="ghost-btn">Our services</a>
</div>
<div class="stats">
  <div class="stat-card"><span class="stat-num">10+</span><span class="stat-text">Years experience</span></div>
  <div class="stat-card"><span class="stat-num">500+</span><span class="stat-text">Projects done</span></div>
  <div class="stat-card"><span class="stat-num">5.0</span><span class="stat-text">Star rating</span></div>
</div>
<div class="section">
  <div class="section-label">Our services</div>
  <h2>What we do best.</h2>
  <div class="services-grid">
    <div class="service-item"><h3>Core Service</h3><p>Professional quality work you can rely on.</p></div>
    <div class="service-item"><h3>Consultation</h3><p>Free estimates and honest advice.</p></div>
    <div class="service-item"><h3>Emergency</h3><p>Available when you need us most.</p></div>
    <div class="service-item"><h3>Maintenance</h3><p>Ongoing care to protect your investment.</p></div>
  </div>
</div>
<div class="testimonial">
  <div class="section-label">What clients say</div>
  <blockquote>"Outstanding work. Professional, on time, and honest. Highly recommended."</blockquote>
  <cite>&mdash; A satisfied customer</cite>
</div>
<div class="final-cta">
  <h2>Ready to get <em>started?</em></h2>
  <p>Contact us today for a free estimate. No obligation.</p>
  <a href="tel:${esc(phone.replace(/[^0-9+]/g, ''))}" class="cta-btn">Call ${phone}</a>
</div>
<footer>
  <div class="foot-logo">${name}<em>.</em></div>
  <p>&copy; ${year} ${name}. All rights reserved.</p>
  <span class="badge"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:3px;opacity:.6"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg><a href="https://velocity.delivery" style="color:inherit;text-decoration:none;">Velocity</a></span>
</footer>
</body>
</html>`;
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}
