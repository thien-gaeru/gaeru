/**
 * GAERU Product Experience Module
 * Apple-style Smooth Scrolling, Scroll Reveal, Sticky Local Navigation & Micro-Interactions
 */
(function() {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  function initProductExperience() {
    const detailContainer = document.querySelector('#product-detail');
    if (!detailContainer) return;

    // Wait until product is rendered by commerce.js
    const checkProductRendered = () => {
      const heading = document.querySelector('.product-purchase-heading h1');
      if (!heading) {
        requestAnimationFrame(checkProductRendered);
        return;
      }
      setupAppleLocalNav();
      setupScrollReveal();
      setupGalleryCrossfade();
    };

    requestAnimationFrame(checkProductRendered);
  }

  /**
   * 1. Apple-Style Sticky Local Navigation Bar
   */
  function setupAppleLocalNav() {
    if (document.querySelector('.apple-local-nav')) return;

    const heading = document.querySelector('.product-purchase-heading h1');
    const productName = heading ? heading.textContent.replace(/^Mua\s+/i, '').trim() : 'Sản phẩm GAERU';
    const priceNode = document.querySelector('[data-selected-price]');
    const currentPrice = priceNode ? priceNode.textContent : '';

    const nav = document.createElement('nav');
    nav.className = 'apple-local-nav';
    nav.setAttribute('aria-label', `Điều hướng nhanh ${productName}`);
    nav.innerHTML = `
      <div class="apple-local-nav-inner">
        <div class="apple-local-nav-title">
          <span>${escapeHtml(productName)}</span>
          <span class="apple-nav-badge">Chính hãng</span>
        </div>
        <ul class="apple-local-nav-links">
          <li><a href="#product-detail" class="is-active" data-nav-target="overview">Tổng quan</a></li>
          <li><a href="#product-information" data-nav-target="features">Tính năng</a></li>
          <li><a href="#product-specs" data-nav-target="specs">Thông số</a></li>
        </ul>
        <div class="apple-local-nav-cta">
          <span class="apple-local-nav-price" data-local-nav-price>${escapeHtml(currentPrice)}</span>
          <a href="#product-detail" class="apple-local-nav-btn" data-local-nav-buy>Mua ngay</a>
        </div>
      </div>
      <div class="apple-nav-progress" aria-hidden="true"></div>
    `;

    // Insert right after #site-header or at top of body
    const siteHeader = document.querySelector('#site-header');
    if (siteHeader) {
      siteHeader.after(nav);
    } else {
      document.body.prepend(nav);
    }

    // Connect Specs anchor if not present
    const specsSection = document.querySelector('.product-feature-specs, .m3-specs, .product-story-specs');
    if (specsSection && !specsSection.id) {
      specsSection.id = 'product-specs';
    }

    // Price synchronization
    if (priceNode) {
      const observer = new MutationObserver(() => {
        const localPrice = nav.querySelector('[data-local-nav-price]');
        if (localPrice) localPrice.textContent = priceNode.textContent;
      });
      observer.observe(priceNode, { childList: true, characterData: true, subtree: true });
    }

    // Scroll Visibility & Progress Tracking
    const progressBar = nav.querySelector('.apple-nav-progress');
    const heroSection = document.querySelector('.product-detail');
    const links = nav.querySelectorAll('.apple-local-nav-links a');

    const handleScroll = () => {
      // 1. Visibility toggle
      const triggerTop = heroSection ? heroSection.getBoundingClientRect().top : 300;
      if (triggerTop <= 50) {
        nav.classList.add('is-visible');
      } else {
        nav.classList.remove('is-visible');
      }

      // 2. Progress Bar
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docHeight > 0 ? (window.scrollY / docHeight) * 100 : 0;
      if (progressBar) {
        progressBar.style.width = Math.min(100, Math.max(0, progress)) + '%';
      }

      // 3. ScrollSpy Active Indicator
      const infoEl = document.querySelector('#product-information');
      const specsEl = document.querySelector('#product-specs');

      const infoTop = infoEl ? infoEl.getBoundingClientRect().top : 9999;
      const specsTop = specsEl ? specsEl.getBoundingClientRect().top : 9999;

      let current = 'overview';
      if (specsTop <= 160) {
        current = 'specs';
      } else if (infoTop <= 160) {
        current = 'features';
      }

      links.forEach(link => {
        if (link.dataset.navTarget === current) {
          link.classList.add('is-active');
        } else {
          link.classList.remove('is-active');
        }
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    // Smooth Scroll Click Handlers
    nav.addEventListener('click', (e) => {
      const link = e.target.closest('a[href^="#"]');
      if (!link) return;
      e.preventDefault();
      const targetId = link.getAttribute('href');
      const target = document.querySelector(targetId);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }

  /**
   * 2. Apple-Style Scroll Reveal Animation with IntersectionObserver
   */
  function setupScrollReveal() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const selectors = [
      '.product-feature-intro',
      '.product-feature-chapter',
      '.product-story-chapter',
      '.m3-intro',
      '.m3-chapter',
      '.product-feature-highlights>div',
      '.m3-highlights>div',
      '.product-feature-specs',
      '.m3-specs',
      '.description-figure',
      '.product-bundle-cross-sell'
    ];

    const elements = document.querySelectorAll(selectors.join(', '));
    if (!elements.length) return;

    elements.forEach(el => {
      el.classList.add('product-reveal-ready');
    });

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-inview');
          // Once revealed, keep it visible for smooth continuous reading
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.08,
      rootMargin: '0px 0px -40px 0px'
    });

    elements.forEach(el => observer.observe(el));
  }

  /**
   * 3. Gallery Crossfade & Artwork Transitions
   */
  function setupGalleryCrossfade() {
    const mainImg = document.querySelector('[data-product-main-image]');
    const thumbs = document.querySelectorAll('[data-gallery-image]');
    if (!mainImg || !thumbs.length) return;

    thumbs.forEach(thumb => {
      thumb.addEventListener('click', () => {
        mainImg.style.opacity = '0.35';
        mainImg.style.transform = 'scale(0.98)';
        setTimeout(() => {
          mainImg.style.opacity = '1';
          mainImg.style.transform = 'none';
        }, 120);
      });
    });
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Auto initialize on DOM ready and custom events
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initProductExperience);
  } else {
    initProductExperience();
  }

  // Re-run if products reloaded via AJAX
  document.addEventListener('gaeru:products-rendered', initProductExperience);
})();
