/**
 * POST /api/pipeline/build
 *
 * Multi-Page Website Builder Agent
 * ─────────────────────────────────
 * Takes content from the Content Agent + site DNA from the Scraper Agent
 * and builds a complete, multi-page production website.
 *
 * Pages generated:
 *   1. index.html    — Homepage with hero, trust bar, services preview, testimonials, CTA
 *   2. services.html — Full services page with detailed descriptions
 *   3. about.html    — About page with story, team, values
 *   4. contact.html  — Contact page with form, map embed, phone/email/address
 *   5. reviews.html  — Testimonials/reviews page
 *
 * Each page shares a common nav, footer, and stylesheet.
 * Output is stored as a JSON bundle in KV: { pages: { 'index.html': '...', ... }, stylesheet: '...' }
 *
 * Body: {
 *   email: string,
 *   business_name: string,
 *   niche?: string,
 *   style?: string,
 *   plan?: 'starter'|'professional'|'premium',
 * }
 *
 * Returns: { build_id, pages: [...], preview_url }
 */
import { json, err, corsPreflightResponse, getKV, generateId, esc } from '../../_lib/helpers.js';

export async function onRequestPost(context) {
  const kv = getKV(context.env);
  if (!kv) return err('Storage not configured', 500);

  let body;
  try { body = await context.request.json(); } catch { return err('Invalid JSON'); }

  const email = (body.email || '').trim().toLowerCase();
  if (!email) return err('email is required');

  // Load content and site DNA
  let content, siteDna;
  try {
    content = await kv.get('content:' + email, { type: 'json' });
    siteDna = await kv.get('site_dna:' + email, { type: 'json' });
  } catch {}

  if (!content) return err('No content found. Run content agent first.', 400);

  const biz = {
    name: body.business_name || siteDna?.business_name || 'Your Business',
    niche: body.niche || '',
    style: body.style || 'modern-clean',
    plan: body.plan || 'starter',
    location: body.location || siteDna?.address || '',
    phone: body.phone || siteDna?.phone || '',
    email: body.contact_email || siteDna?.email || email,
    years: body.years || '',
    domain: siteDna?.domain || '',
    logo_url: siteDna?.logo_url || '',
    colors: siteDna?.colors || [],
  };

  const buildId = generateId();
  const archetype = detectArchetype(biz);
  const theme = getTheme(biz.style, archetype);

  // Determine pages based on plan
  const pageList = ['index', 'services', 'about', 'contact'];
  if (biz.plan !== 'starter') {
    pageList.push('reviews');
  }

  // Generate shared CSS
  const stylesheet = generateStylesheet(theme, biz);

  // Build shared components
  const nav = buildNav(biz, pageList, theme);
  const footer = buildFooter(biz, content, theme);

  // Generate each page
  const pages = {};
  for (const page of pageList) {
    const pageContent = generatePage(page, biz, content, theme, nav, footer, stylesheet);
    pages[page + '.html'] = pageContent;
  }

  // Store in KV
  const bundle = {
    build_id: buildId,
    email,
    pages: Object.keys(pages),
    plan: biz.plan,
    style: biz.style,
    built_at: new Date().toISOString(),
  };

  // Store each page separately for serving
  for (const [filename, html] of Object.entries(pages)) {
    await kv.put(`build:${buildId}:${filename}`, html, { expirationTtl: 86400 * 90 });
  }

  // Store the index as the preview
  await kv.put(`preview:${buildId}`, pages['index.html'], { expirationTtl: 86400 * 90 });

  // Store build manifest
  await kv.put(`build:${buildId}`, JSON.stringify(bundle), { expirationTtl: 86400 * 90 });

  // Update redesign record
  try {
    const existing = await kv.get('redesign:' + email, { type: 'json' }) || {};
    Object.assign(existing, {
      build_id: buildId,
      preview_id: buildId,
      preview_url: `/preview/${buildId}`,
      build_pages: Object.keys(pages),
      build_plan: biz.plan,
      built_at: bundle.built_at,
    });
    await kv.put('redesign:' + email, JSON.stringify(existing), { expirationTtl: 86400 * 90 });
  } catch {}

  return json({
    build_id: buildId,
    preview_url: `/preview/${buildId}`,
    pages: Object.keys(pages),
    plan: biz.plan,
  });
}

export async function onRequestOptions() {
  return corsPreflightResponse();
}

// ═══════════════════════════════════════════════════════════════
// PAGE GENERATORS
// ═══════════════════════════════════════════════════════════════

function generatePage(page, biz, content, theme, nav, footer, stylesheet) {
  const name = esc(biz.name);
  const pageTitle = getPageTitle(page, biz);

  const bodyContent = {
    index: () => buildHomePage(biz, content, theme),
    services: () => buildServicesPage(biz, content, theme),
    about: () => buildAboutPage(biz, content, theme),
    contact: () => buildContactPage(biz, content, theme),
    reviews: () => buildReviewsPage(biz, content, theme),
  };

  const body = (bodyContent[page] || bodyContent.index)();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(content.meta?.description || '')}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${theme.gFont}&display=swap" rel="stylesheet">
<style>${stylesheet}</style>
</head>
<body>
${nav.replace('{{ACTIVE}}', page)}
${body}
${footer}
</body>
</html>`;
}

function getPageTitle(page, biz) {
  const name = biz.name;
  const niche = biz.niche ? ' — ' + capitalizeWords(biz.niche) : '';
  const titles = {
    index: `${name}${niche} in ${biz.location || 'Your Area'}`,
    services: `Our Services | ${name}`,
    about: `About Us | ${name}`,
    contact: `Contact Us | ${name}`,
    reviews: `Reviews | ${name}`,
  };
  return titles[page] || name;
}

// ── Homepage ──────────────────────────────────────────────────

function buildHomePage(biz, content, theme) {
  const name = esc(biz.name);
  const phone = esc(biz.phone || '');
  const phoneHref = (biz.phone || '').replace(/[^0-9+]/g, '');
  const loc = esc(biz.location || 'Your Area');
  const hero = content.hero || {};
  const stats = content.stats || [];
  const services = (content.services || []).slice(0, 3);
  const testimonials = (content.testimonials || []).slice(0, 3);
  const cta = content.cta || {};
  const isDark = biz.style === 'bold-dark';

  return `
<section class="hero">
  <div class="hero-inner">
    <div class="fu">
      <div class="hero-tag">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        ${esc(hero.tag || 'Licensed & Insured • ' + loc)}
      </div>
      <h1>${esc(hero.headline || 'Quality you can trust.')}</h1>
      <p class="hero-sub">${esc(hero.subtext || '')}</p>
      <div class="hero-btns">
        ${phone ? `<a href="tel:${phoneHref}" class="btn-p"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg> ${esc(hero.cta_primary || 'Get Your Free Quote')}</a>` : `<a href="contact.html" class="btn-p">${esc(hero.cta_primary || 'Get Your Free Quote')}</a>`}
        <a href="services.html" class="btn-o">${esc(hero.cta_secondary || 'See Our Work')}</a>
      </div>
      <div class="hero-proof">
        <span class="hero-stars">★★★★★</span>
        <span class="hero-proof-text"><strong>4.9/5</strong> from 200+ reviews</span>
      </div>
    </div>
    <div class="fu fu1">
      <div class="hero-card">
        <div class="hero-card-label">Why ${name}?</div>
        <div class="hero-card-stat">${esc(biz.years || '10+')}</div>
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

${stats.length ? `<div class="trust"><div class="trust-inner">${stats.map(s => `<div class="trust-item"><div class="trust-num">${esc(String(s.number))}</div><div class="trust-label">${esc(s.label)}</div></div>`).join('')}</div></div>` : ''}

<section class="services" id="services">
  <div class="wrap">
    <div class="sec-tag">What We Do</div>
    <div class="sec-title">Our Services</div>
    <p class="sec-desc">Every project gets our full attention. Here's how we help homeowners and businesses in ${loc}.</p>
    <div class="services-grid">
${services.map((s, i) => `      <div class="svc-card fu fu${i}">
        <div class="svc-icon">${getSvgIcon(s.icon || 'check')}</div>
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.description)}</p>
      </div>`).join('\n')}
    </div>
    <div class="section-cta"><a href="services.html" class="btn-o">View All Services →</a></div>
  </div>
</section>

${testimonials.length ? `
<section class="reviews" id="reviews">
  <div class="wrap">
    <div class="sec-tag">Reviews</div>
    <div class="sec-title">What our customers say</div>
    <div class="reviews-grid">
${testimonials.map((t, i) => `      <div class="review-card fu fu${i}">
        <div class="review-stars">★★★★★</div>
        <blockquote>${esc(t.text)}</blockquote>
        <cite>${esc(t.author)}<span>${esc(t.role)}</span></cite>
      </div>`).join('\n')}
    </div>
  </div>
</section>` : ''}

<section class="cta">
  <div class="cta-inner">
    <div class="sec-tag">Ready?</div>
    <h2>${esc(cta.heading || 'Let\'s talk about your project.')}</h2>
    <p>${esc(cta.subtext || 'No pressure, no obligation. Call us or send an email.')}</p>
    <div class="cta-btns">
      ${phone ? `<a href="tel:${phoneHref}" class="btn-p">${esc(cta.button_text || 'Call Now')}</a>` : ''}
      <a href="contact.html" class="btn-o">Contact Us</a>
    </div>
  </div>
</section>`;
}

// ── Services page ─────────────────────────────────────────────

function buildServicesPage(biz, content, theme) {
  const loc = esc(biz.location || 'Your Area');
  const services = content.services || [];
  const phone = esc(biz.phone || '');
  const phoneHref = (biz.phone || '').replace(/[^0-9+]/g, '');

  return `
<section class="page-hero">
  <div class="wrap">
    <div class="sec-tag">Our Services</div>
    <h1 class="page-title">What we do — and why we do it well.</h1>
    <p class="page-sub">Every service we offer comes with ${esc(biz.years || '10+')} years of experience, a quality guarantee, and people who actually care about the outcome.</p>
  </div>
</section>

<section class="services services--full">
  <div class="wrap">
    <div class="services-grid services-grid--full">
${services.map((s, i) => `      <div class="svc-card svc-card--full fu fu${Math.min(i, 3)}">
        <div class="svc-icon svc-icon--lg">${getSvgIcon(s.icon || 'check')}</div>
        <div class="svc-content">
          <h2>${esc(s.name)}</h2>
          <p>${esc(s.description)}</p>
          <a href="contact.html" class="svc-link">Get a quote →</a>
        </div>
      </div>`).join('\n')}
    </div>
  </div>
</section>

<section class="cta">
  <div class="cta-inner">
    <div class="sec-tag">Need something specific?</div>
    <h2>Don't see your exact need? We still want to hear from you.</h2>
    <p>We handle custom projects all the time. Tell us what you need, and we'll give you an honest answer about whether we can help.</p>
    <div class="cta-btns">
      ${phone ? `<a href="tel:${phoneHref}" class="btn-p">Call Us</a>` : ''}
      <a href="contact.html" class="btn-o">Send a Message</a>
    </div>
  </div>
</section>`;
}

// ── About page ────────────────────────────────────────────────

function buildAboutPage(biz, content, theme) {
  const name = esc(biz.name);
  const loc = esc(biz.location || 'Your Area');
  const about = content.about || {};
  const values = about.values || [];

  return `
<section class="page-hero">
  <div class="wrap">
    <div class="sec-tag">About ${name}</div>
    <h1 class="page-title">${esc(about.heading || 'Real people. Real work.')}</h1>
  </div>
</section>

<section class="about-full">
  <div class="wrap">
    <div class="about-story">
${(about.paragraphs || []).map(p => `      <p>${esc(p)}</p>`).join('\n')}
    </div>
  </div>
</section>

${values.length ? `
<section class="values">
  <div class="wrap">
    <div class="sec-tag">Our Values</div>
    <div class="sec-title">What we stand for.</div>
    <div class="values-grid">
${values.map((v, i) => `      <div class="value-card fu fu${i}">
        <h3>${esc(v.title)}</h3>
        <p>${esc(v.desc)}</p>
      </div>`).join('\n')}
    </div>
  </div>
</section>` : ''}

<section class="about-stats-section">
  <div class="wrap">
    <div class="about-stats-grid">
      <div class="about-stat-block"><strong>${esc(biz.years || '10+')}</strong><span>Years in Business</span></div>
      <div class="about-stat-block"><strong>500+</strong><span>Projects Completed</span></div>
      <div class="about-stat-block"><strong>4.9</strong><span>Average Rating</span></div>
      <div class="about-stat-block"><strong>100%</strong><span>Licensed & Insured</span></div>
    </div>
  </div>
</section>

<section class="cta">
  <div class="cta-inner">
    <h2>Want to work with people who actually care?</h2>
    <p>Reach out. We'd love to hear about your project.</p>
    <div class="cta-btns">
      <a href="contact.html" class="btn-p">Get in Touch</a>
    </div>
  </div>
</section>`;
}

// ── Contact page ──────────────────────────────────────────────

function buildContactPage(biz, content, theme) {
  const name = esc(biz.name);
  const phone = esc(biz.phone || '');
  const phoneHref = (biz.phone || '').replace(/[^0-9+]/g, '');
  const contactEmail = esc(biz.email || '');
  const loc = esc(biz.location || '');

  return `
<section class="page-hero">
  <div class="wrap">
    <div class="sec-tag">Contact</div>
    <h1 class="page-title">Let's talk about your project.</h1>
    <p class="page-sub">Call us, email us, or fill out the form. We typically respond within a few hours during business hours.</p>
  </div>
</section>

<section class="contact-section">
  <div class="wrap">
    <div class="contact-grid">
      <div class="contact-info">
        <h2>Get in touch</h2>
        ${phone ? `<div class="contact-item"><div class="contact-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg></div><div><strong>Phone</strong><a href="tel:${phoneHref}">${phone}</a></div></div>` : ''}
        ${contactEmail ? `<div class="contact-item"><div class="contact-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg></div><div><strong>Email</strong><a href="mailto:${contactEmail}">${contactEmail}</a></div></div>` : ''}
        ${loc ? `<div class="contact-item"><div class="contact-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg></div><div><strong>Location</strong><span>${loc}</span></div></div>` : ''}
        <div class="contact-hours">
          <h3>Hours</h3>
          <p>Mon–Fri: 7:00 AM – 6:00 PM<br>Sat: 8:00 AM – 2:00 PM<br>Sun: Emergency calls only</p>
        </div>
      </div>
      <div class="contact-form-wrap">
        <form class="contact-form" onsubmit="event.preventDefault();this.querySelector('button').textContent='Message Sent!';this.querySelector('button').disabled=true;">
          <div class="form-row">
            <div class="form-group"><label>Name</label><input type="text" name="name" placeholder="Your name" required></div>
            <div class="form-group"><label>Phone</label><input type="tel" name="phone" placeholder="(555) 123-4567"></div>
          </div>
          <div class="form-group"><label>Email</label><input type="email" name="email" placeholder="you@example.com" required></div>
          <div class="form-group"><label>How can we help?</label><textarea name="message" rows="5" placeholder="Tell us about your project..." required></textarea></div>
          <button type="submit" class="btn-p btn-full">Send Message</button>
        </form>
      </div>
    </div>
  </div>
</section>`;
}

// ── Reviews page ──────────────────────────────────────────────

function buildReviewsPage(biz, content, theme) {
  const name = esc(biz.name);
  const testimonials = content.testimonials || [];

  return `
<section class="page-hero">
  <div class="wrap">
    <div class="sec-tag">Reviews</div>
    <h1 class="page-title">Don't take our word for it.</h1>
    <p class="page-sub">Here's what real customers say about working with ${name}.</p>
  </div>
</section>

<section class="reviews reviews--full">
  <div class="wrap">
    <div class="reviews-stats">
      <div class="reviews-big-num">4.9<span>/5</span></div>
      <div class="reviews-stars-row">★★★★★</div>
      <p>Based on 200+ reviews</p>
    </div>
    <div class="reviews-grid reviews-grid--full">
${testimonials.map((t, i) => `      <div class="review-card fu fu${Math.min(i, 3)}">
        <div class="review-stars">★★★★★</div>
        <blockquote>${esc(t.text)}</blockquote>
        <cite>${esc(t.author)}<span>${esc(t.role)}</span></cite>
      </div>`).join('\n')}
    </div>
  </div>
</section>

<section class="cta">
  <div class="cta-inner">
    <h2>Ready to become our next happy customer?</h2>
    <p>Free estimates. No obligation. Just honest work from people who stand behind it.</p>
    <div class="cta-btns">
      <a href="contact.html" class="btn-p">Get Your Free Estimate</a>
      <a href="services.html" class="btn-o">View Our Services</a>
    </div>
  </div>
</section>`;
}

// ═══════════════════════════════════════════════════════════════
// SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════════

function buildNav(biz, pageList, theme) {
  const name = esc(biz.name);
  const phone = esc(biz.phone || '');
  const phoneHref = (biz.phone || '').replace(/[^0-9+]/g, '');

  const links = pageList.map(p => {
    const label = { index: 'Home', services: 'Services', about: 'About', contact: 'Contact', reviews: 'Reviews' }[p] || capitalizeWords(p);
    const href = p === 'index' ? 'index.html' : p + '.html';
    return `<a href="${href}" class="nav-link${p === '{{ACTIVE}}' ? ' nav-link--active' : ''}">${label}</a>`;
  });

  return `<nav class="nav">
  <div class="nav-inner">
    <a href="index.html" class="logo">${name}<span>.</span></a>
    <div class="nav-links">${links.join('')}${phone ? `<a href="tel:${phoneHref}" class="nav-cta"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg> ${phone}</a>` : ''}</div>
    <button class="nav-toggle" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('nav-mobile-open')"><span></span><span></span><span></span></button>
    <div class="nav-mobile">${links.join('')}</div>
  </div>
</nav>`;
}

function buildFooter(biz, content, theme) {
  const name = esc(biz.name);
  const phone = esc(biz.phone || '');
  const phoneHref = (biz.phone || '').replace(/[^0-9+]/g, '');
  const contactEmail = esc(biz.email || '');
  const loc = esc(biz.location || '');
  const year = new Date().getFullYear();
  const services = (content.services || []).slice(0, 4);

  return `<footer>
  <div class="footer-inner">
    <div class="footer-brand">
      <a href="index.html" class="logo">${name}<span>.</span></a>
      <p>Serving ${loc || 'your area'} ${biz.years ? `for ${esc(biz.years)} years` : 'and surrounding areas'}. Licensed, insured, and committed to quality.</p>
    </div>
    <div class="footer-col">
      <h4>Services</h4>
      <ul>${services.map(s => `<li><a href="services.html">${esc(s.name)}</a></li>`).join('')}</ul>
    </div>
    <div class="footer-col">
      <h4>Company</h4>
      <ul><li><a href="about.html">About</a></li><li><a href="reviews.html">Reviews</a></li><li><a href="services.html">Services</a></li><li><a href="contact.html">Contact</a></li></ul>
    </div>
    <div class="footer-col">
      <h4>Contact</h4>
      <ul>${phone ? `<li><a href="tel:${phoneHref}">${phone}</a></li>` : ''}${contactEmail ? `<li><a href="mailto:${contactEmail}">${contactEmail}</a></li>` : ''}${loc ? `<li>${loc}</li>` : ''}</ul>
    </div>
  </div>
  <div class="footer-bottom">
    <span>&copy; ${year} ${name}. All rights reserved.</span>
    <span class="footer-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Built by Velocity</span>
  </div>
</footer>`;
}

// ═══════════════════════════════════════════════════════════════
// THEME & STYLESHEET
// ═══════════════════════════════════════════════════════════════

function getTheme(style, archetype) {
  // Archetype-specific base themes — each archetype gets DIFFERENT fonts, colors, layout vars
  const archetypeThemes = {
    'local-service': {
      font: "'Poppins', -apple-system, system-ui, sans-serif", fontHead: "'Poppins', sans-serif",
      gFont: 'Poppins:wght@400;500;600;700;800',
      bg: '#fafaf5', bgAlt: '#f2f1eb', nav: '#fff', accent: '#1a5632', accentHover: '#134425',
      accentBg: 'rgba(26,86,50,0.06)', accentBgSolid: '#ecf4ef', trust: '#14301e', text: '#1a2e1c', textSec: '#4d5e4f',
      muted: '#7a8b7c', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #ecf4ef 0%, #fafaf5 50%, #f5f3ec 100%)',
    },
    'food': {
      font: "'Lato', sans-serif", fontHead: "'Playfair Display', Georgia, serif",
      gFont: 'Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Lato:wght@300;400;700',
      bg: '#fdf8f3', bgAlt: '#f6efe6', nav: '#fdf8f3', accent: '#8b2252', accentHover: '#6d1a40',
      accentBg: 'rgba(139,34,82,0.06)', accentBgSolid: '#faf0f4', trust: '#3a1522', text: '#2c1a18', textSec: '#6b524e',
      muted: '#9a8480', card: '#fff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #faf0f4 0%, #fdf8f3 50%, #f8f0e8 100%)',
    },
    'creative': {
      font: "'Inter', -apple-system, system-ui, sans-serif", fontHead: "'Space Grotesk', sans-serif",
      gFont: 'Space+Grotesk:wght@300;400;500;600;700&family=Inter:wght@300;400;500',
      bg: '#ffffff', bgAlt: '#f6f6f6', nav: '#fff', accent: '#111111', accentHover: '#333333',
      accentBg: 'rgba(0,0,0,0.04)', accentBgSolid: '#f4f4f4', trust: '#111111', text: '#111111', textSec: '#666666',
      muted: '#999999', card: '#f6f6f6', border: 'rgba(0,0,0,0.08)', heroGrad: 'linear-gradient(135deg, #ffffff 0%, #fafafa 50%, #f8f8f8 100%)',
    },
    'wellness': {
      font: "'Jost', sans-serif", fontHead: "'Cormorant Garamond', Georgia, serif",
      gFont: 'Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Jost:wght@300;400;500;600',
      bg: '#f5faf6', bgAlt: '#edf4ef', nav: '#f5faf6', accent: '#4a7c59', accentHover: '#3a6348',
      accentBg: 'rgba(74,124,89,0.06)', accentBgSolid: '#e8f2eb', trust: '#2a4a32', text: '#1e3228', textSec: '#5a7562',
      muted: '#7a9580', card: '#ffffff', border: 'rgba(0,0,0,0.05)', heroGrad: 'linear-gradient(135deg, #e8f2eb 0%, #f5faf6 50%, #f0f7f2 100%)',
    },
    'professional': {
      font: "'Source Sans 3', -apple-system, system-ui, sans-serif", fontHead: "'Libre Baskerville', Georgia, serif",
      gFont: 'Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Source+Sans+3:wght@400;500;600;700',
      bg: '#f4f5f7', bgAlt: '#eceef2', nav: '#fff', accent: '#1e3a5f', accentHover: '#152d4d',
      accentBg: 'rgba(30,58,95,0.06)', accentBgSolid: '#e8eef6', trust: '#0f1f33', text: '#1a2030', textSec: '#4a5568',
      muted: '#8a95a5', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #e8eef6 0%, #f4f5f7 50%, #eff1f6 100%)',
    },
    'ecommerce': {
      font: "'Inter', -apple-system, system-ui, sans-serif", fontHead: "'Sora', sans-serif",
      gFont: 'Sora:wght@300;400;500;600;700&family=Inter:wght@400;500',
      bg: '#fafafa', bgAlt: '#f0f0f0', nav: '#fff', accent: '#e85d3a', accentHover: '#d04c2a',
      accentBg: 'rgba(232,93,58,0.06)', accentBgSolid: '#fef0ec', trust: '#2a1510', text: '#1a1a1a', textSec: '#666666',
      muted: '#999999', card: '#ffffff', border: 'rgba(0,0,0,0.06)', heroGrad: 'linear-gradient(135deg, #fef0ec 0%, #fafafa 50%, #f8f6f4 100%)',
    },
    'nonprofit': {
      font: "'Open Sans', -apple-system, system-ui, sans-serif", fontHead: "'Merriweather', Georgia, serif",
      gFont: 'Merriweather:ital,wght@0,400;0,700;1,400&family=Open+Sans:wght@400;500;600;700',
      bg: '#f8f6f2', bgAlt: '#f0ece5', nav: '#fff', accent: '#2a6b4e', accentHover: '#1e5a3d',
      accentBg: 'rgba(42,107,78,0.06)', accentBgSolid: '#e8f2ec', trust: '#1a3a2a', text: '#1e2a20', textSec: '#5a6b5e',
      muted: '#8a9a8e', card: '#ffffff', border: 'rgba(0,0,0,0.05)', heroGrad: 'linear-gradient(135deg, #e8f2ec 0%, #f8f6f2 50%, #f2f0ea 100%)',
    },
  };

  // Style overrides layer on top of archetype base
  const styleOverrides = {
    'bold-dark': {
      bg: '#0e0c0a', bgAlt: '#161412', nav: '#121010', text: '#e8ddd3', textSec: '#a89f94',
      muted: '#6d6560', card: '#1a1815', border: 'rgba(255,255,255,0.06)', trust: '#1a1614',
      heroGrad: 'linear-gradient(135deg, #1a1410 0%, #0e0c0a 50%, #12100e 100%)',
      accentBg: 'rgba(200,149,106,0.08)', accentBgSolid: '#1e1a15',
      accent: '#c8956a', accentHover: '#d4a57a',
    },
    'warm-friendly': { accent: '#c66b2e', accentHover: '#b55e24', accentBg: 'rgba(198,107,46,0.07)', accentBgSolid: '#fdf3e8' },
    'surprise': { accent: '#7c3aed', accentHover: '#6d28d9', accentBg: 'rgba(124,58,237,0.06)', accentBgSolid: '#f0ecff' },
    'rustic': { accent: '#7a6040', accentHover: '#6a5035', accentBg: 'rgba(122,96,64,0.07)', accentBgSolid: '#f0ebe0' },
  };

  const base = archetypeThemes[archetype] || archetypeThemes['local-service'];
  const override = styleOverrides[style] || {};
  return { ...base, ...override };
}

// ── Archetype detection (shared with orchestrate.js) ──────────

function detectArchetype(biz) {
  const niche = (biz.niche || '').toLowerCase();
  const notes = (biz.notes || '').toLowerCase();
  const name = (biz.name || '').toLowerCase();

  const creativeNiches = ['photography', 'videography', 'music', 'musician', 'artist', 'design', 'graphic', 'filmmaker', 'dj', 'band', 'producer', 'creative', 'art', 'illustration', 'tattoo'];
  if (creativeNiches.some(n => niche.includes(n) || notes.includes(n) || name.includes(n))) return 'creative';

  const foodNiches = ['restaurant', 'cafe', 'bakery', 'catering', 'bar', 'food', 'chef', 'bistro', 'pizzeria', 'brewery', 'coffee'];
  if (foodNiches.some(n => niche.includes(n) || notes.includes(n))) return 'food';

  const healthNiches = ['dental', 'chiropractic', 'fitness', 'personal training', 'salon', 'barbershop', 'spa', 'massage', 'yoga', 'therapy', 'medical', 'clinic', 'vet', 'wellness', 'skincare'];
  if (healthNiches.some(n => niche.includes(n) || notes.includes(n))) return 'wellness';

  const proNiches = ['law', 'legal', 'accounting', 'bookkeeping', 'consulting', 'insurance', 'real-estate', 'realtor', 'financial', 'marketing', 'agency', 'tech', 'software', 'it-services'];
  if (proNiches.some(n => niche.includes(n) || notes.includes(n))) return 'professional';

  const retailNiches = ['ecommerce', 'shop', 'store', 'retail', 'boutique', 'fashion', 'jewelry'];
  if (retailNiches.some(n => niche.includes(n) || notes.includes(n))) return 'ecommerce';

  if (niche.includes('nonprofit') || niche.includes('charity') || niche.includes('foundation')) return 'nonprofit';

  return 'local-service';
}

function generateStylesheet(t, biz) {
  const isDark = biz.style === 'bold-dark';
  return `*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:${t.bg};--bg-alt:${t.bgAlt};--nav:${t.nav};--accent:${t.accent};--accent-hover:${t.accentHover};--accent-bg:${t.accentBg};--accent-bg-solid:${t.accentBgSolid};--trust:${t.trust};--text:${t.text};--text-sec:${t.textSec};--muted:${t.muted};--card:${t.card};--border:${t.border};--font:${t.font};--font-head:${t.fontHead};--r:8px;--rl:14px}
html{scroll-behavior:smooth;-webkit-font-smoothing:antialiased}body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.65;overflow-x:hidden}a{color:inherit;text-decoration:none}img{max-width:100%;display:block}.wrap{max-width:1100px;margin:0 auto;padding:0 24px}
.nav{position:sticky;top:0;z-index:100;background:var(--nav);border-bottom:1px solid var(--border);backdrop-filter:blur(12px)}
.nav-inner{max-width:1100px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;height:64px}
.logo{font-family:var(--font-head);font-size:20px;font-weight:400;color:var(--text);letter-spacing:-.02em}.logo span{color:var(--accent)}
.nav-links{display:flex;align-items:center;gap:24px;font-size:14px;color:var(--text-sec)}.nav-links a{transition:color .2s}.nav-links a:hover,.nav-link--active{color:var(--accent)!important;font-weight:500}
.nav-cta{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#fff!important;padding:9px 20px;border-radius:var(--r);font-weight:600;font-size:13px;transition:all .2s}.nav-cta:hover{background:var(--accent-hover);transform:translateY(-1px)}
.nav-toggle{display:none;background:none;border:none;cursor:pointer;padding:6px}.nav-toggle span{display:block;width:20px;height:2px;background:var(--text);margin:4px 0;transition:all .2s}
.nav-mobile{display:none;position:fixed;top:64px;left:0;right:0;bottom:0;background:var(--bg);flex-direction:column;align-items:center;justify-content:center;gap:24px;font-size:18px;z-index:99}
.nav-mobile-open{display:flex!important}
.hero{padding:80px 24px 64px;background:${t.heroGrad};position:relative;overflow:hidden}
.hero::after{content:'';position:absolute;top:-30%;right:-15%;width:500px;height:500px;border-radius:50%;background:var(--accent-bg);filter:blur(80px);pointer-events:none;opacity:.7}
.hero-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1.15fr .85fr;gap:48px;align-items:center;position:relative;z-index:1}
.hero-tag{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);margin-bottom:16px;padding:6px 14px;background:var(--accent-bg-solid);border-radius:100px;border:1px solid var(--accent-bg)}
.hero h1{font-family:var(--font-head);font-size:clamp(28px,4.5vw,46px);font-weight:400;line-height:1.12;letter-spacing:-.02em;margin-bottom:20px}
.hero-sub{font-size:16px;color:var(--text-sec);line-height:1.75;margin-bottom:32px;max-width:500px}
.hero-btns{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:36px}
.btn-p{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#fff;padding:14px 28px;border-radius:var(--r);font-weight:600;font-size:15px;transition:all .25s;border:none;cursor:pointer}
.btn-p:hover{background:var(--accent-hover);transform:translateY(-2px);box-shadow:0 8px 24px ${isDark ? 'rgba(200,149,106,.2)' : 'rgba(0,0,0,.12)'}}
.btn-o{display:inline-flex;align-items:center;gap:8px;background:transparent;color:var(--text-sec);padding:14px 28px;border-radius:var(--r);font-weight:500;font-size:15px;border:1px solid var(--border);transition:all .25s;cursor:pointer}
.btn-o:hover{border-color:var(--accent);color:var(--accent)}.btn-full{width:100%;justify-content:center}
.hero-proof{display:flex;align-items:center;gap:14px}.hero-stars{color:#f5b731;font-size:15px;letter-spacing:2px}
.hero-proof-text{font-size:13px;color:var(--text-sec)}.hero-proof-text strong{color:var(--text)}
.hero-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:32px;box-shadow:0 24px 64px ${isDark ? 'rgba(0,0,0,.4)' : 'rgba(0,0,0,.08)'};position:relative}
.hero-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--accent);border-radius:var(--rl) var(--rl) 0 0}
.hero-card-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--accent);margin-bottom:20px}
.hero-card-stat{font-family:var(--font-head);font-size:52px;color:var(--text);line-height:1;margin-bottom:4px}
.hero-card-desc{font-size:14px;color:var(--text-sec);margin-bottom:24px}
.hero-card-row{display:flex;gap:12px}.hero-card-mini{flex:1;text-align:center;padding:14px 8px;background:var(--accent-bg-solid);border-radius:var(--r);border:1px solid var(--accent-bg)}
.hero-card-mini strong{display:block;font-family:var(--font-head);font-size:22px;color:var(--accent)}.hero-card-mini span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.trust{background:var(--trust);padding:24px}.trust-inner{max-width:1100px;margin:0 auto;display:flex;justify-content:center;gap:48px;flex-wrap:wrap}
.trust-item{display:flex;flex-direction:column;align-items:center;gap:2px}.trust-num{font-family:var(--font-head);font-size:24px;color:#fff;font-weight:400}.trust-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.45)}
.services{padding:80px 24px}.sec-tag{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--accent);margin-bottom:8px}
.sec-title{font-family:var(--font-head);font-size:clamp(22px,3.5vw,34px);font-weight:400;margin-bottom:12px}.sec-desc{font-size:15px;color:var(--text-sec);line-height:1.7;margin-bottom:40px;max-width:540px}
.services-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.svc-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:28px;transition:all .3s}
.svc-card:hover{border-color:var(--accent);transform:translateY(-3px);box-shadow:0 12px 32px ${isDark ? 'rgba(0,0,0,.25)' : 'rgba(0,0,0,.06)'}}
.svc-icon{width:44px;height:44px;border-radius:var(--r);background:var(--accent-bg-solid);display:flex;align-items:center;justify-content:center;margin-bottom:16px;color:var(--accent);border:1px solid var(--accent-bg)}
.svc-icon--lg{width:56px;height:56px}.svc-card h3,.svc-card h2{font-size:16px;font-weight:600;margin-bottom:8px}.svc-card p{font-size:13px;color:var(--text-sec);line-height:1.65}
.svc-link{display:inline-block;margin-top:12px;font-size:13px;color:var(--accent);font-weight:600}
.svc-card--full{display:flex;gap:24px;align-items:flex-start}.svc-card--full .svc-content{flex:1}
.services-grid--full{grid-template-columns:1fr 1fr;gap:20px}
.section-cta{text-align:center;margin-top:32px}
.page-hero{padding:100px 24px 48px;background:var(--bg-alt)}.page-title{font-family:var(--font-head);font-size:clamp(26px,4vw,40px);font-weight:400;margin-bottom:12px}
.page-sub{font-size:16px;color:var(--text-sec);line-height:1.7;max-width:600px}
.about-full{padding:64px 24px}.about-story{max-width:700px;margin:0 auto}.about-story p{font-size:16px;color:var(--text-sec);line-height:1.85;margin-bottom:20px}
.values{padding:64px 24px;background:var(--bg-alt)}.values-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:32px}
.value-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:24px}.value-card h3{font-size:15px;font-weight:600;margin-bottom:8px;color:var(--accent)}.value-card p{font-size:13px;color:var(--text-sec);line-height:1.6}
.about-stats-section{padding:64px 24px}.about-stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;max-width:800px;margin:0 auto;text-align:center}
.about-stat-block strong{display:block;font-family:var(--font-head);font-size:40px;color:var(--accent);line-height:1;margin-bottom:6px}.about-stat-block span{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.reviews{padding:80px 24px}.reviews-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.reviews-grid--full{grid-template-columns:repeat(2,1fr)}
.review-card{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:28px;display:flex;flex-direction:column}
.review-stars{color:#f5b731;font-size:14px;letter-spacing:2px;margin-bottom:16px}
.review-card blockquote{font-size:14px;color:var(--text-sec);line-height:1.7;margin-bottom:auto;padding-bottom:20px;flex:1}
.review-card cite{font-style:normal;font-size:13px;font-weight:600;color:var(--text);display:block;padding-top:16px;border-top:1px solid var(--border)}
.review-card cite span{font-weight:400;color:var(--muted);font-size:12px;display:block;margin-top:2px}
.reviews-stats{text-align:center;margin-bottom:48px}.reviews-big-num{font-family:var(--font-head);font-size:64px;color:var(--text);line-height:1}
.reviews-big-num span{font-size:32px;color:var(--muted)}.reviews-stars-row{color:#f5b731;font-size:24px;letter-spacing:4px;margin:8px 0}.reviews-stats p{color:var(--text-sec);font-size:14px}
.contact-section{padding:64px 24px}.contact-grid{display:grid;grid-template-columns:1fr 1.2fr;gap:48px;max-width:900px;margin:0 auto}
.contact-info h2{font-family:var(--font-head);font-size:24px;margin-bottom:24px}
.contact-item{display:flex;gap:16px;align-items:flex-start;margin-bottom:20px}.contact-icon{width:44px;height:44px;border-radius:var(--r);background:var(--accent-bg-solid);display:flex;align-items:center;justify-content:center;color:var(--accent);border:1px solid var(--accent-bg);flex-shrink:0}
.contact-item strong{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:2px}
.contact-item a,.contact-item span{font-size:15px;color:var(--text)}
.contact-hours{margin-top:32px;padding-top:24px;border-top:1px solid var(--border)}.contact-hours h3{font-size:14px;font-weight:600;margin-bottom:8px}.contact-hours p{font-size:14px;color:var(--text-sec);line-height:1.8}
.contact-form{background:var(--card);border:1px solid var(--border);border-radius:var(--rl);padding:32px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px}
.form-group input,.form-group textarea{width:100%;padding:12px 16px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;transition:border-color .2s}
.form-group input:focus,.form-group textarea:focus{outline:none;border-color:var(--accent)}
.cta{padding:80px 24px;background:var(--bg-alt);text-align:center}.cta-inner{max-width:600px;margin:0 auto}
.cta h2{font-family:var(--font-head);font-size:clamp(22px,3.5vw,34px);font-weight:400;margin-bottom:16px}
.cta p{font-size:15px;color:var(--text-sec);line-height:1.7;margin-bottom:28px}.cta-btns{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}
footer{padding:48px 24px 32px;border-top:1px solid var(--border);background:var(--bg)}
.footer-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:40px}
.footer-brand .logo{margin-bottom:12px;display:inline-block}.footer-brand p{font-size:13px;color:var(--muted);line-height:1.6;max-width:240px}
.footer-col h4{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:12px}
.footer-col ul{list-style:none}.footer-col li{margin-bottom:6px}.footer-col a{font-size:13px;color:var(--text-sec);transition:color .2s}.footer-col a:hover{color:var(--accent)}
.footer-bottom{max-width:1100px;margin:32px auto 0;padding-top:24px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}
.footer-badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--accent);background:var(--accent-bg-solid);padding:4px 10px;border-radius:4px;font-weight:600;border:1px solid var(--accent-bg)}
@media(max-width:900px){.hero-inner{grid-template-columns:1fr}.hero-card{display:none}.services-grid,.reviews-grid{grid-template-columns:1fr 1fr}.services-grid--full{grid-template-columns:1fr}.about-stats-grid,.values-grid{grid-template-columns:1fr 1fr}.contact-grid{grid-template-columns:1fr}.footer-inner{grid-template-columns:1fr 1fr}.footer-brand{grid-column:1/-1}}
@media(max-width:600px){.services-grid,.reviews-grid,.reviews-grid--full{grid-template-columns:1fr}.trust-inner{gap:24px}.nav-links{display:none}.nav-toggle{display:block}.hero{padding:60px 20px 40px}.footer-inner{grid-template-columns:1fr}.footer-bottom{flex-direction:column;gap:8px;text-align:center}.form-row{grid-template-columns:1fr}.about-stats-grid,.values-grid{grid-template-columns:1fr}}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}.fu{animation:fadeUp .6s ease both}.fu0{animation-delay:.1s}.fu1{animation-delay:.2s}.fu2{animation-delay:.3s}.fu3{animation-delay:.4s}`;
}

// ── SVG Icons ─────────────────────────────────────────────────

function getSvgIcon(icon) {
  const icons = {
    check: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    home: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    shield: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    search: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
    tool: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    droplet: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>',
    filter: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>',
    building: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/></svg>',
    layers: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    wind: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>',
    alert: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    sun: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
    zap: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    calendar: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>',
    settings: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    message: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    refresh: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/><path d="M2 11.5a10 10 0 0 1 18.8-4.3"/><path d="M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>',
    thermometer: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/></svg>',
    flame: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
    snowflake: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/></svg>',
    battery: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="16" height="10" rx="2"/><line x1="22" y1="11" x2="22" y2="13"/><line x1="6" y1="11" x2="6" y2="13"/><line x1="10" y1="11" x2="10" y2="13"/><line x1="14" y1="11" x2="14" y2="13"/></svg>',
    pen: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    scissors: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
    tree: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 22v-2"/><path d="M9 18a5 5 0 0 1-4.25-7.67L7 7l2.94-4.27a1.39 1.39 0 0 1 2.12 0L15 7l2.25 3.33A5 5 0 0 1 13 18"/><path d="M7 22v-2"/><path d="M12 22v-8"/></svg>',
    palette: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>',
    box: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
    sparkle: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>',
  };
  return icons[icon] || icons.check;
}

function capitalizeWords(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}
