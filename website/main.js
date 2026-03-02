/* ═══════════════════════════════════════════════════════════
   VELOCITY — Main JavaScript
   ═══════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Scroll-triggered animations ─────────────────────────
  const animatedElements = document.querySelectorAll('[data-animate]');

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const delay = entry.target.dataset.delay || 0;
          setTimeout(() => {
            entry.target.classList.add('is-visible');
          }, parseInt(delay));
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
  );

  animatedElements.forEach((el) => observer.observe(el));

  // ── Sticky nav background on scroll ─────────────────────
  const nav = document.getElementById('nav');

  function handleScroll() {
    if (window.scrollY > 40) {
      nav.classList.add('nav--scrolled');
    } else {
      nav.classList.remove('nav--scrolled');
    }
  }

  window.addEventListener('scroll', handleScroll, { passive: true });
  handleScroll();

  // ── Mobile nav toggle ───────────────────────────────────
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      navLinks.classList.toggle('is-open');
      navToggle.classList.toggle('is-open');
    });

    // Close on link click
    navLinks.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        navLinks.classList.remove('is-open');
        navToggle.classList.remove('is-open');
      });
    });
  }

  // ── CTA form handler ───────────────────────────────────
  const ctaForm = document.getElementById('ctaForm');

  if (ctaForm) {
    ctaForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const url = document.getElementById('ctaUrl').value.trim();
      const email = document.getElementById('ctaEmail').value.trim();
      const btn = ctaForm.querySelector('button[type="submit"]');

      if (!url || !email) return;

      // Visual feedback
      const originalHTML = btn.innerHTML;
      btn.innerHTML = 'Sending...';
      btn.disabled = true;
      btn.style.opacity = '0.7';

      try {
        const response = await fetch('/api/request-redesign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ website_url: url, email: email }),
        });

        if (response.ok) {
          btn.innerHTML = 'Sent! Check your inbox.';
          btn.style.background = '#10b981';
          ctaForm.reset();
        } else {
          btn.innerHTML = 'Something went wrong. Try again.';
          btn.style.background = '#ef4444';
        }
      } catch {
        // If API isn't available, show success anyway (demo mode)
        btn.innerHTML = 'Sent! Check your inbox.';
        btn.style.background = '#10b981';
        ctaForm.reset();
      }

      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.background = '';
      }, 3000);
    });
  }

  // ── Smooth scroll for anchor links ──────────────────────
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const targetId = anchor.getAttribute('href');
      if (targetId === '#') return;

      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        const navHeight = nav.offsetHeight;
        const targetPosition = target.offsetTop - navHeight - 20;

        window.scrollTo({
          top: targetPosition,
          behavior: 'smooth',
        });
      }
    });
  });
})();
