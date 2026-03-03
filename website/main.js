/* ═══════════════════════════════════════════════════════════
   VELOCITY — Main JavaScript
   Warm, organic interactions. Nothing flashy.
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Scroll-triggered fade-in animations ────────────────
  const animated = document.querySelectorAll('[data-animate]');

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -30px 0px' }
    );
    animated.forEach((el) => observer.observe(el));
  } else {
    // Fallback: show everything
    animated.forEach((el) => el.classList.add('is-visible'));
  }

  // ── Sticky nav on scroll ───────────────────────────────
  const nav = document.getElementById('nav');

  function handleScroll() {
    if (window.scrollY > 50) {
      nav.classList.add('nav--scrolled');
    } else {
      nav.classList.remove('nav--scrolled');
    }
  }

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();

  // ── Mobile nav toggle ──────────────────────────────────
  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');

  if (toggle && links) {
    toggle.addEventListener('click', () => {
      links.classList.toggle('is-open');
      toggle.classList.toggle('is-open');
    });

    // Close on link click
    links.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        links.classList.remove('is-open');
        toggle.classList.remove('is-open');
      });
    });
  }

  // ── CTA form submission ────────────────────────────────
  const form = document.getElementById('ctaForm');
  const btn = document.getElementById('ctaBtn');
  const success = document.getElementById('ctaSuccess');

  if (form && btn && success) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const url = document.getElementById('ctaUrl').value.trim();
      const email = document.getElementById('ctaEmail').value.trim();

      if (!url || !email) return;

      // Visual feedback
      btn.textContent = 'Sending...';
      btn.disabled = true;
      btn.style.opacity = '0.7';

      // Fire API request in background (don't block redirect)
      try {
        fetch('/api/request-redesign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ website_url: url, email: email }),
        }).catch(function() {});
      } catch (_) {}

      // Redirect to sign-up page with pre-filled data
      const params = new URLSearchParams({ email: email, website: url });
      window.location.href = '/auth.html?' + params.toString();
    });
  }

  // ── Smooth scroll for anchor links ─────────────────────
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const id = anchor.getAttribute('href');
      if (id === '#') return;

      const target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        const offset = nav ? nav.offsetHeight + 20 : 80;
        const top = target.getBoundingClientRect().top + window.pageYOffset - offset;

        window.scrollTo({ top: top, behavior: 'smooth' });
      }
    });
  });
})();
