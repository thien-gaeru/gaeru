/**
 * GAERU Product Experience Module
 * Premium Smooth Scrolling, Scroll Reveal, Sticky Local Navigation & Micro-Interactions
 * 100% Proprietary GAERU Studio Experience Design System
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
      setupProductLocalNav();
      setupScrollReveal();
      setupGalleryCrossfade();
    };

    requestAnimationFrame(checkProductRendered);
  }

  /**
   * 1. Sticky Local Navigation Bar (Subnav)
   */
  function setupProductLocalNav() {
    if (document.querySelector('.product-local-subnav')) return;

    const heading = document.querySelector('.product-purchase-heading h1');
    const productName = heading ? heading.textContent.replace(/^Mua\s+/i, '').trim() : 'Sản phẩm GAERU';
    function formatSubnavPrice(nodeOrStr) {
      if (!nodeOrStr) return '';
      let text = '';
      if (typeof nodeOrStr === 'string') {
        text = nodeOrStr;
      } else if (nodeOrStr && typeof nodeOrStr === 'object') {
        const compactNode = nodeOrStr.querySelector?.('.price-text-compact');
        if (compactNode && compactNode.textContent) {
          text = compactNode.textContent;
        } else {
          const fullNode = nodeOrStr.querySelector?.('.price-text-full');
          text = (fullNode ? fullNode.textContent : nodeOrStr.textContent) || '';
        }
      }
      const trimmed = text.trim();
      return trimmed.replace(/^Từ\s+/i, '').replace(/\s+đến\s+/i, ' – ');
    }

    const priceNode = document.querySelector('[data-selected-price]');
    const currentPrice = priceNode ? formatSubnavPrice(priceNode) : '';

    const nav = document.createElement('nav');
    nav.className = 'product-local-subnav';
    nav.setAttribute('aria-label', `Điều hướng nhanh ${productName}`);
    nav.innerHTML = `
      <div class="product-local-subnav-inner">
        <div class="product-local-subnav-title">
          <span>${escapeHtml(productName)}</span>
          <span class="product-subnav-badge">Chính hãng</span>
        </div>
        <ul class="product-local-subnav-links">
          <li><a href="#product-detail" class="is-active" data-nav-target="overview">Tổng quan</a></li>
          <li><a href="#product-information" data-nav-target="features">Tính năng</a></li>
          <li><a href="#product-specs" data-nav-target="specs">Thông số</a></li>
        </ul>
        <div class="product-local-subnav-cta">
          <span class="product-local-subnav-price" data-local-nav-price>${escapeHtml(currentPrice)}</span>
          <a href="#product-detail" class="product-local-subnav-btn" data-local-nav-buy>Mua ngay</a>
        </div>
      </div>
      <div class="product-subnav-progress" aria-hidden="true"></div>
    `;

    // Insert right after #site-header or at top of body
    const siteHeader = document.querySelector('#site-header');
    if (siteHeader) {
      siteHeader.after(nav);
    } else {
      document.body.prepend(nav);
    }

    // Robust Specs element finder & anchor connector
    function findSpecsElement() {
      let el = document.querySelector('#product-specs');
      if (el) return el;
      el = document.querySelector('.product-feature-specs, .m3-specs, .k9-specs, .product-story-specs, [data-specs-section]');
      if (el) return el;
      const info = document.querySelector('#product-information');
      if (info) {
        const candidates = info.querySelectorAll('h2, h3, h4, p, details, dl, table, figure');
        for (const node of candidates) {
          const text = (node.textContent || '').toLowerCase();
          if (text.includes('th\u00f4ng s\u1ed1')) {
            return node;
          }
          const alt = (node.querySelector?.('img')?.getAttribute('alt') || '').toLowerCase();
          if (alt.includes('th\u00f4ng s\u1ed1')) {
            return node;
          }
        }
        return info.querySelector('.product-description-media, .detail-description') || info;
      }
      return null;
    }

    function ensureSpecsAnchor() {
      let specs = document.querySelector('#product-specs');
      if (!specs) {
        specs = findSpecsElement();
        if (specs && !specs.id) {
          specs.id = 'product-specs';
        }
      }
      return specs;
    }

    ensureSpecsAnchor();

    // Price synchronization
    if (priceNode) {
      const syncSubnavPrice = () => {
        const localPrice = nav.querySelector('[data-local-nav-price]');
        if (localPrice) localPrice.textContent = formatSubnavPrice(priceNode);
      };
      syncSubnavPrice();
      const observer = new MutationObserver(syncSubnavPrice);
      observer.observe(priceNode, { childList: true, characterData: true, subtree: true });
    }

    // Scroll Visibility & Progress Tracking
    const progressBar = nav.querySelector('.product-subnav-progress');
    const heroSection = document.querySelector('.product-detail');
    const links = nav.querySelectorAll('.product-local-subnav-links a');

    const handleScroll = () => {
      // 1. Visibility toggle: Chỉ hiển thị khi trượt qua nội dung nút "Thêm vào giỏ"
      const addToCartBtn = document.querySelector('.detail-actions [data-add-to-cart], [data-add-to-cart], .detail-actions');
      const siteHeader = document.querySelector('#site-header');
      const headerThreshold = siteHeader ? (siteHeader.offsetHeight || 50) : 50;

      if (addToCartBtn) {
        const btnRect = addToCartBtn.getBoundingClientRect();
        // Trượt qua nút thêm vào giỏ (đáy nút vượt lên trên thanh menu header)
        if (btnRect.bottom <= headerThreshold) {
          nav.classList.add('is-visible');
        } else {
          nav.classList.remove('is-visible');
        }
      } else {
        const triggerTop = heroSection ? heroSection.getBoundingClientRect().bottom : 500;
        if (triggerTop <= headerThreshold) {
          nav.classList.add('is-visible');
        } else {
          nav.classList.remove('is-visible');
        }
      }

      // 2. Progress Bar
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrolled = window.scrollY || window.pageYOffset || 0;
      const progress = docHeight > 0 ? (scrolled / docHeight) * 100 : 0;
      if (progressBar) {
        progressBar.style.width = Math.min(100, Math.max(0, progress)) + '%';
      }

      // 3. ScrollSpy Active Indicator
      const infoEl = document.querySelector('#product-information');
      const specsEl = document.querySelector('#product-specs') || ensureSpecsAnchor();

      const infoTop = infoEl ? infoEl.getBoundingClientRect().top : 9999;
      const specsTop = specsEl ? specsEl.getBoundingClientRect().top : 9999;

      let current = 'overview';
      if (specsTop <= 200) {
        current = 'specs';
      } else if (infoTop <= 200) {
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

    // Smooth Scroll Click Handlers with precise sticky offset calculation
    nav.addEventListener('click', (e) => {
      const link = e.target.closest('a[href^="#"]');
      if (!link) return;
      e.preventDefault();
      const targetId = link.getAttribute('href');

      if (targetId === '#product-detail') {
        const targetElement = document.querySelector('.detail-actions, .product-choice-group, .product-detail-copy');
        if (targetElement) {
          const siteHeader = document.querySelector('#site-header');
          const headerHeight = siteHeader ? (siteHeader.offsetHeight || 50) : 50;
          const targetRect = targetElement.getBoundingClientRect();
          window.scrollTo({
            top: Math.max(0, window.scrollY + targetRect.top - headerHeight - 16),
            behavior: 'smooth'
          });
        } else {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        links.forEach(l => l.classList.remove('is-active'));
        const overviewLink = nav.querySelector('[data-nav-target="overview"]');
        if (overviewLink) overviewLink.classList.add('is-active');
        return;
      }

      let target = document.querySelector(targetId);
      if (!target && targetId === '#product-specs') {
        target = ensureSpecsAnchor();
      }

      if (target) {
        const parentDetails = target.closest('details');
        if (parentDetails && !parentDetails.open) {
          parentDetails.open = true;
        }

        const navHeight = nav.offsetHeight || 52;
        const siteHeader = document.querySelector('#site-header');
        const headerHeight = siteHeader ? (siteHeader.offsetHeight || 52) : 52;
        const totalOffset = navHeight + headerHeight + 16;

        const targetRect = target.getBoundingClientRect();
        const absoluteTargetTop = window.scrollY + targetRect.top - totalOffset;

        window.scrollTo({
          top: Math.max(0, absoluteTargetTop),
          behavior: 'smooth'
        });

        links.forEach(l => l.classList.remove('is-active'));
        link.classList.add('is-active');

        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      } else if (targetId === '#product-specs') {
        const info = document.querySelector('#product-information');
        if (info) {
          info.scrollIntoView({ behavior: 'smooth' });
        }
      }
    });
  }

  /**
   * 2. Smooth Scroll Reveal Animation with IntersectionObserver
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
      '.k9-intro',
      '.k9-chapter',
      '.product-feature-highlights>div',
      '.m3-highlights>div',
      '.m3-highlights>span',
      '.k9-highlights>div',
      '.k9-highlights>span',
      '.product-feature-specs',
      '.m3-specs',
      '.k9-specs',
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
