/**
 * GAERU Product Experience Module
 * Premium Smooth Scrolling, Scroll Reveal, Sticky Local Navigation & Micro-Interactions
 * 100% Proprietary GAERU Studio Experience Design System
 */
(function() {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let renderPollRafId = null;

  function initProductExperience() {
    const detailContainer = document.querySelector('#product-detail');
    if (!detailContainer) return;

    if (renderPollRafId !== null) {
      cancelAnimationFrame(renderPollRafId);
      renderPollRafId = null;
    }

    let frames = 0;
    const MAX_WAIT_FRAMES = 600;
    // Wait until product is rendered by commerce.js
    const checkProductRendered = () => {
      renderPollRafId = null;
      if (!detailContainer.isConnected) return;
      const heading = document.querySelector('.product-purchase-heading h1');
      if (!heading) {
        const failed = detailContainer.querySelector('.product-empty, .product-not-found, .not-found, [data-product-error]');
        if (failed || ++frames >= MAX_WAIT_FRAMES) return;
        renderPollRafId = requestAnimationFrame(checkProductRendered);
        return;
      }
      setupProductLocalNav();
      setupMobileStickyPurchaseBar();
      setupScrollReveal();
      setupGalleryCrossfade();
    };

    renderPollRafId = requestAnimationFrame(checkProductRendered);
  }

  /**
   * 1. Sticky Local Navigation Bar (Subnav)
   */
  function setupProductLocalNav() {
    const existingNav = document.querySelector('.product-local-subnav');
    if (existingNav) {
      const freshPriceNode = document.querySelector('[data-selected-price]');
      if (freshPriceNode && existingNav._priceObserver) {
        existingNav._priceObserver.disconnect();
        existingNav._priceObserver.observe(freshPriceNode, { childList: true, characterData: true, subtree: true });
      }
      return;
    }

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
      const observer = new MutationObserver(() => {
        const currentNode = document.querySelector('[data-selected-price]') || priceNode;
        const localPrice = nav.querySelector('[data-local-nav-price]');
        if (localPrice && currentNode) localPrice.textContent = formatSubnavPrice(currentNode);
      });
      observer.observe(priceNode, { childList: true, characterData: true, subtree: true });
      nav._priceObserver = observer;
    }

    // Scroll Visibility & Progress Tracking (rAF-throttled, batched DOM read -> write to avoid layout thrashing)
    const progressBar = nav.querySelector('.product-subnav-progress');
    const heroSection = document.querySelector('.product-detail');
    const links = nav.querySelectorAll('.product-local-subnav-links a');
    let scrollRafPending = false;
    let lastVisible = null;
    let lastCurrent = '';
    let lastRatioStr = '';

    const runScrollUpdate = () => {
      scrollRafPending = false;
      // Batch ALL layout reads first
      const addToCartBtn = document.querySelector('.detail-actions [data-add-to-cart], [data-add-to-cart], .detail-actions');
      const siteHeaderEl = document.querySelector('#site-header');
      const headerThreshold = siteHeaderEl ? (siteHeaderEl.offsetHeight || 50) : 50;
      const triggerBottom = addToCartBtn
        ? addToCartBtn.getBoundingClientRect().bottom
        : (heroSection ? heroSection.getBoundingClientRect().bottom : 500);
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const scrolled = window.scrollY || window.pageYOffset || 0;
      const infoEl = document.querySelector('#product-information');
      const specsEl = document.querySelector('#product-specs') || ensureSpecsAnchor();
      const infoTop = infoEl ? infoEl.getBoundingClientRect().top : 9999;
      const specsTop = specsEl ? specsEl.getBoundingClientRect().top : 9999;

      // Batch ALL DOM writes after reads
      const shouldShow = triggerBottom <= headerThreshold;
      if (shouldShow !== lastVisible) {
        nav.classList.toggle('is-visible', shouldShow);
        lastVisible = shouldShow;
      }

      const ratio = Math.min(1, Math.max(0, docHeight > 0 ? (scrolled / docHeight) : 0));
      const ratioStr = ratio.toFixed(4);
      if (progressBar && ratioStr !== lastRatioStr) {
        progressBar.style.transform = 'scaleX(' + ratioStr + ')';
        lastRatioStr = ratioStr;
      }

      let current = 'overview';
      if (specsTop <= 200) {
        current = 'specs';
      } else if (infoTop <= 200) {
        current = 'features';
      }

      if (current !== lastCurrent) {
        links.forEach(link => {
          link.classList.toggle('is-active', link.dataset.navTarget === current);
        });
        lastCurrent = current;
      }
    };

    const handleScroll = () => {
      if (scrollRafPending) return;
      scrollRafPending = true;
      requestAnimationFrame(runScrollUpdate);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    runScrollUpdate();

    // Smooth Scroll Click Handlers with precise sticky offset calculation
    // Matches links even after clean-urls.js rewrites "#id" to "/san-pham/<slug>#id"
    nav.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-nav-target], a[data-local-nav-buy], a[href*="#"]');
      if (!link) return;
      const rawHref = link.getAttribute('href') || '';
      const hashIndex = rawHref.indexOf('#');
      if (hashIndex < 0) return;
      const targetId = rawHref.slice(hashIndex);
      if (!targetId || targetId === '#') return;
      e.preventDefault();

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

    if (typeof IntersectionObserver !== 'function') {
      elements.forEach(el => {
        el.classList.add('product-reveal-ready', 'is-inview');
      });
      return;
    }

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
      if (thumb.dataset.crossfadeBound === 'true') return;
      thumb.dataset.crossfadeBound = 'true';
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

  /**
   * 4. Mobile Bottom Sticky Purchase Bar (<= 768px via IntersectionObserver)
   */
  function setupMobileStickyPurchaseBar() {
    const buyBox = document.querySelector('.product-detail-copy .detail-actions') || document.querySelector('.detail-actions');
    if (!buyBox) return;

    let bar = document.querySelector('[data-mobile-sticky-bar]');
    if (!bar) {
      bar = document.createElement('aside');
      bar.className = 'pdp-mobile-sticky-bar';
      bar.setAttribute('data-mobile-sticky-bar', '');
      bar.setAttribute('aria-label', 'Mua nhanh sản phẩm');
      bar.hidden = true;
      bar.innerHTML =
        '<div class="pdp-mobile-sticky-info">' +
          '<span class="pdp-mobile-sticky-label" data-sticky-variant-label>Chọn phiên bản</span>' +
          '<strong class="pdp-mobile-sticky-price" data-sticky-price></strong>' +
        '</div>' +
        '<div class="pdp-mobile-sticky-actions">' +
          '<button type="button" class="button pdp-sticky-cart-btn" data-sticky-add>Thêm vào giỏ</button>' +
          '<button type="button" class="button button-blue pdp-sticky-buy-btn" data-sticky-buy>Mua ngay</button>' +
        '</div>';
      document.body.appendChild(bar);

      const scrollToPicker = () => {
        const picker = document.querySelector('.product-choice-group, .product-variant-grid, .product-variant-card, .product-detail-copy');
        if (picker) {
          const siteHeader = document.querySelector('#site-header');
          const headerH = siteHeader ? (siteHeader.offsetHeight || 50) : 50;
          const rect = picker.getBoundingClientRect();
          window.scrollTo({ top: Math.max(0, (window.scrollY || 0) + rect.top - headerH - 16), behavior: 'smooth' });
          const firstBtn = picker.querySelector('button:not(:disabled)');
          if (firstBtn) setTimeout(() => firstBtn.focus({ preventScroll: true }), 260);
        }
        if (window.GAERUNotify && typeof window.GAERUNotify.toast === 'function') {
          window.GAERUNotify.toast('Vui lòng chọn phiên bản phù hợp trước khi đặt mua.', 'info');
        }
      };

      bar.addEventListener('click', (e) => {
        const addTrigger = e.target.closest('[data-sticky-add]');
        const buyTrigger = e.target.closest('[data-sticky-buy]');
        if (!addTrigger && !buyTrigger) return;
        const selector = document.querySelector('#product-variant');
        const primaryAdd = document.querySelector('.detail-actions [data-add-to-cart]');
        const primaryBuy = document.querySelector('.detail-actions [data-buy-now]');
        if (!selector || !selector.value) {
          scrollToPicker();
          return;
        }
        if (addTrigger && primaryAdd && !primaryAdd.disabled) {
          primaryAdd.click();
        } else if (buyTrigger && primaryBuy && !primaryBuy.disabled) {
          primaryBuy.click();
        }
      });
    }

    if (bar._buyObserver) bar._buyObserver.disconnect();
    if (bar._priceMutObserver) bar._priceMutObserver.disconnect();

    const normalizeLabel = (s) => String(s || '').replace(/\bmicro\s*usb\b/gi, 'Micro USB');
    const syncStickyState = () => {
      const priceNode = document.querySelector('[data-selected-price]');
      const selector = document.querySelector('#product-variant');
      const primaryAdd = document.querySelector('.detail-actions [data-add-to-cart]');
      const stickyPrice = bar.querySelector('[data-sticky-price]');
      const stickyLabel = bar.querySelector('[data-sticky-variant-label]');
      const stickyAdd = bar.querySelector('[data-sticky-add]');
      const stickyBuy = bar.querySelector('[data-sticky-buy]');

      if (stickyPrice && priceNode) {
        const compact = priceNode.querySelector && priceNode.querySelector('.price-text-compact');
        const rawText = (compact && compact.textContent) ? compact.textContent : (priceNode.textContent || '');
        stickyPrice.textContent = rawText.trim().replace(/^Từ\s+/i, '').replace(/\s+đến\s+/i, ' – ');
        stickyPrice.classList.toggle('is-flash', Boolean(priceNode.classList && priceNode.classList.contains('detail-price-flash')));
      }
      const hasVariant = Boolean(selector && selector.value);
      const outOfStock = Boolean(hasVariant && primaryAdd && primaryAdd.disabled);
      if (stickyLabel) {
        if (!hasVariant) {
          stickyLabel.textContent = 'Chưa chọn phiên bản';
        } else {
          const opt = selector.options && selector.options[selector.selectedIndex];
          const optLabel = opt ? opt.textContent.split(' — ')[0].split(' · ')[0] : '';
          stickyLabel.textContent = outOfStock ? 'Tạm hết hàng' : normalizeLabel(optLabel || 'Đã chọn phiên bản');
        }
      }
      if (stickyAdd) stickyAdd.disabled = outOfStock;
      if (stickyBuy) stickyBuy.disabled = outOfStock;
    };

    syncStickyState();
    const selector = document.querySelector('#product-variant');
    if (selector && selector.dataset.stickyBound !== 'true') {
      selector.dataset.stickyBound = 'true';
      selector.addEventListener('change', syncStickyState);
    }
    const priceNode = document.querySelector('[data-selected-price]');
    if (priceNode && typeof MutationObserver === 'function') {
      const mo = new MutationObserver(syncStickyState);
      mo.observe(priceNode, { childList: true, characterData: true, subtree: true });
      bar._priceMutObserver = mo;
    }

    const mq = window.matchMedia ? window.matchMedia('(max-width: 768px)') : { matches: (window.innerWidth || 1024) <= 768 };
    let isBuyBoxVisible = true;
    const applyBarVisibility = () => {
      const show = Boolean(mq.matches && !isBuyBoxVisible);
      bar.hidden = !mq.matches;
      bar.classList.toggle('is-visible', show);
      if (document.body && document.body.classList) {
        document.body.classList.toggle('has-pdp-sticky-bar', show);
      }
    };

    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
          isBuyBoxVisible = entries[i].isIntersecting;
        }
        applyBarVisibility();
      }, { threshold: 0.05 });
      io.observe(buyBox);
      bar._buyObserver = io;
    }
    if (mq.addEventListener) mq.addEventListener('change', applyBarVisibility);
    applyBarVisibility();
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
