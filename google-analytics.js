/**
 * GAERU — Google Analytics 4 (GA4) Client Integration
 * 
 * Provides Google Analytics 4 (gtag.js) tracking with Enhanced Ecommerce:
 * - view_item
 * - add_to_cart
 * - begin_checkout
 * - purchase
 * 
 * Safe against blockers, network errors, and runs non-blocking.
 */
(() => {
  'use strict';

  const getGlobal = () => (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
  const getStorage = () => (typeof sessionStorage !== 'undefined' ? sessionStorage : (typeof globalThis !== 'undefined' ? globalThis.sessionStorage : null));

  // Initialize dataLayer and gtag stub immediately
  const win = getGlobal();
  if (win) {
    win.dataLayer = win.dataLayer || [];
    if (typeof win.gtag !== 'function') {
      win.gtag = function gtag() {
        win.dataLayer.push(arguments);
      };
    }
  }

  const GA_ID_REGEX = /^G-[A-Za-z0-9]+$/;

  function sanitizeItems(rawItems) {
    if (!Array.isArray(rawItems)) return [];
    return rawItems.map((item, idx) => {
      const price = Number(item.priceVnd ?? item.price ?? 0);
      const qty = Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1;
      return {
        item_id: String(item.variantId || item.sku || item.id || `item_${idx + 1}`),
        item_name: String(item.name || item.productName || item.title || 'Sản phẩm GAERU'),
        item_category: String(item.category || 'Thiết bị âm thanh & sáng tạo'),
        price: Number.isFinite(price) && price >= 0 ? price : 0,
        quantity: qty
      };
    });
  }

  const GAERUAnalytics = {
    measurementId: null,
    isInitialized: false,

    /**
     * Initialize GA4 with measurement ID (G-XXXXXXXXXX)
     */
    init(measurementId, options = {}) {
      const g = getGlobal();
      if (!g || typeof document === 'undefined') return false;
      const cleanId = String(measurementId || '').trim();
      if (!GA_ID_REGEX.test(cleanId)) {
        return false;
      }

      if (this.isInitialized && this.measurementId === cleanId) {
        return true;
      }

      this.measurementId = cleanId;

      // Check if gtag script is already in DOM
      const existingScript = document.querySelector(`script[src*="googletagmanager.com/gtag/js?id=${cleanId}"]`);
      if (!existingScript && document.head) {
        const script = document.createElement('script');
        script.async = true;
        script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(cleanId)}`;
        document.head.appendChild(script);
      }

      if (typeof g.gtag === 'function') {
        g.gtag('js', new Date());
        g.gtag('config', cleanId, {
          send_page_view: options.send_page_view !== false,
          cookie_flags: 'SameSite=Lax;Secure',
          ...options
        });
      }

      this.isInitialized = true;

      try {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('gaeru:analytics-ready', {
            detail: { measurementId: cleanId }
          }));
        }
      } catch (_) {}

      return true;
    },

    /**
     * Send generic GA4 event
     */
    trackEvent(eventName, params = {}) {
      const g = (typeof gtag === 'function' ? gtag : null) || getGlobal()?.gtag;
      if (typeof g !== 'function') return;
      try {
        g('event', String(eventName), params);
      } catch (err) {
        console.warn('GAERU Analytics event dispatch warning:', err);
      }
    },

    /**
     * Track page view manually
     */
    trackPageView(pagePath, pageTitle) {
      this.trackEvent('page_view', {
        page_path: pagePath || (typeof location !== 'undefined' ? location.pathname : '/'),
        page_title: pageTitle || (typeof document !== 'undefined' ? document.title : '')
      });
    },

    /**
     * Enhanced Ecommerce: view_item
     */
    trackViewItem(product, variant = {}) {
      if (!product) return;
      const price = Number(variant.priceVnd ?? product.priceVnd ?? 0);
      const item = {
        item_id: String(variant.id || variant.sku || product.id || product.slug || 'gaeru-product'),
        item_name: String(variant.name ? `${product.name} - ${variant.name}` : product.name),
        item_category: String(product.category || 'Thiết bị sáng tạo'),
        price: Number.isFinite(price) && price >= 0 ? price : 0,
        quantity: 1
      };

      this.trackEvent('view_item', {
        currency: 'VND',
        value: item.price,
        items: [item]
      });
    },

    /**
     * Enhanced Ecommerce: add_to_cart
     */
    trackAddToCart(item) {
      if (!item) return;
      const sanitized = sanitizeItems([item])[0];
      if (!sanitized) return;

      this.trackEvent('add_to_cart', {
        currency: 'VND',
        value: sanitized.price * sanitized.quantity,
        items: [sanitized]
      });
    },

    /**
     * Enhanced Ecommerce: begin_checkout
     */
    trackBeginCheckout(items, totalVnd) {
      const sanitizedItems = sanitizeItems(items);
      const total = Number(totalVnd);
      const value = Number.isFinite(total) && total >= 0
        ? total
        : sanitizedItems.reduce((sum, it) => sum + (it.price * it.quantity), 0);

      this.trackEvent('begin_checkout', {
        currency: 'VND',
        value,
        items: sanitizedItems
      });
    },

    /**
     * Enhanced Ecommerce: purchase
     * Safe and deduplicated per order number
     */
    trackPurchase(order) {
      if (!order || !order.orderNumber) return;
      const orderNumber = String(order.orderNumber).trim();
      const dedupKey = `gaeru_ga_purchased_${orderNumber}`;

      const storage = getStorage();
      if (storage) {
        try {
          if (storage.getItem(dedupKey)) {
            return; // Already tracked in this browser session
          }
        } catch (_) {}
      }

      const total = Number(order.totalVnd);
      const shipping = Number(order.shippingFeeVnd ?? 0);
      const sanitizedItems = sanitizeItems(order.items);

      this.trackEvent('purchase', {
        transaction_id: orderNumber,
        value: Number.isFinite(total) && total >= 0 ? total : 0,
        currency: 'VND',
        shipping: Number.isFinite(shipping) && shipping >= 0 ? shipping : 0,
        items: sanitizedItems
      });

      if (storage) {
        try {
          storage.setItem(dedupKey, '1');
        } catch (_) {}
      }
    },

    /**
     * Auto bootstrap from DOM meta tag or API
     */
    async bootstrap() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;

      // 1. Check meta tag
      const meta = document.querySelector('meta[name="ga-measurement-id"]');
      if (meta && meta.content && GA_ID_REGEX.test(meta.content.trim())) {
        this.init(meta.content.trim());
        return;
      }

      // 2. Check cached global settings
      if (window.GAERUPublicSettings?.gaMeasurementId) {
        this.init(window.GAERUPublicSettings.gaMeasurementId);
        return;
      }

      // 3. Fetch from API endpoint
      try {
        const res = await fetch('/api/settings/public');
        if (res.ok) {
          const data = await res.json();
          if (data && data.gaMeasurementId && GA_ID_REGEX.test(data.gaMeasurementId.trim())) {
            this.init(data.gaMeasurementId.trim());
          }
        }
      } catch (_) {
        // Silent failure if offline or API unavailable
      }
    }
  };

  if (typeof window !== 'undefined') {
    window.GAERUAnalytics = GAERUAnalytics;

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => GAERUAnalytics.bootstrap());
    } else {
      GAERUAnalytics.bootstrap();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GAERUAnalytics;
  }
})();
