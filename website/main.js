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

  // ── Counter animation for stat numbers ────────────────
  function animateCounter(el, target, suffix) {
    var start = 0;
    var duration = 1800;
    var startTime = null;

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      var current = Math.floor(eased * target);
      el.textContent = current + suffix;
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = target + suffix;
      }
    }
    requestAnimationFrame(step);
  }

  var statNumbers = document.querySelectorAll('.stat-number');
  if (statNumbers.length && 'IntersectionObserver' in window) {
    var statObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var el = entry.target;
            var text = el.textContent.trim();
            var numMatch = text.match(/(\d+)/);
            if (numMatch) {
              var num = parseInt(numMatch[1], 10);
              var suffix = text.replace(numMatch[1], '');
              animateCounter(el, num, suffix);
            }
            statObserver.unobserve(el);
          }
        });
      },
      { threshold: 0.3 }
    );
    statNumbers.forEach(function (el) { statObserver.observe(el); });
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

      // Redirect straight to create account — no API submission
      btn.textContent = 'Taking you to sign up...';
      btn.disabled = true;
      btn.style.opacity = '0.7';

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
