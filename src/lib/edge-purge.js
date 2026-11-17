'use strict';

/**
 * Cloudflare Edge Purge Service
 * Integrates with Cloudflare Cache-Tag API to instantly purge Edge caches across VN points of presence.
 */
class EdgePurgeService {
  constructor({
    zoneId = process.env.CLOUDFLARE_ZONE_ID,
    apiToken = process.env.CLOUDFLARE_API_TOKEN,
    apiKey = process.env.CLOUDFLARE_API_KEY,
    apiEmail = process.env.CLOUDFLARE_EMAIL,
    fetcher = fetch
  } = {}) {
    this.zoneId = zoneId ? String(zoneId).trim() : '';
    this.apiToken = apiToken ? String(apiToken).trim() : '';
    this.apiKey = apiKey ? String(apiKey).trim() : '';
    this.apiEmail = apiEmail ? String(apiEmail).trim() : '';
    this.fetcher = fetcher;
  }

  isConfigured() {
    return Boolean(this.zoneId && (this.apiToken || (this.apiKey && this.apiEmail)));
  }

  getAuthHeaders() {
    if (this.apiToken) {
      return {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      };
    }
    if (this.apiKey && this.apiEmail) {
      return {
        'X-Auth-Key': this.apiKey,
        'X-Auth-Email': this.apiEmail,
        'Content-Type': 'application/json'
      };
    }
    return { 'Content-Type': 'application/json' };
  }

  async sendPurgeRequest(body) {
    if (!this.isConfigured()) {
      return { skipped: true, reason: 'CLOUDFLARE_NOT_CONFIGURED' };
    }

    const endpoint = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(this.zoneId)}/purge_cache`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
      const response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: this.getAuthHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        console.warn('[EDGE-PURGE] Cloudflare purge returned error:', data.errors || response.statusText);
        return { success: false, errors: data.errors, status: response.status };
      }

      return { success: true, data };
    } catch (err) {
      console.warn('[EDGE-PURGE] Cloudflare purge request failed:', err.message);
      return { success: false, error: err.message };
    } finally {
      clearTimeout(timeout);
    }
  }

  async purgeTags(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return { skipped: true };
    const cleanTags = tags.map(t => String(t).trim().toLowerCase()).filter(Boolean);
    if (cleanTags.length === 0) return { skipped: true };

    if (process.env.CLOUDFLARE_TAG_PURGE === 'true') {
      return this.sendPurgeRequest({ tags: cleanTags });
    }

    const base = require('../primary-domain').normalizePublicBase(process.env.PUBLIC_BASE_URL || 'https://gaeru.com');
    const urlSet = new Set();
    for (const tag of cleanTags) {
      if (tag === 'catalog' || tag === 'gaeru-catalog' || tag === 'products' || tag === 'product:list' || tag === 'search-index' || tag === 'promotions' || tag === 'gaeru-html' || tag === '*') {
        urlSet.add(`${base}/`);
        urlSet.add(`${base}/cua-hang`);
        urlSet.add(`${base}/api/products`);
        urlSet.add(`${base}/api/search-index.json`);
      }
      if (tag.startsWith('gaeru-product-')) {
        const slug = tag.slice('gaeru-product-'.length);
        if (slug) {
          urlSet.add(`${base}/san-pham/${encodeURIComponent(slug)}`);
          urlSet.add(`${base}/api/products/${encodeURIComponent(slug)}`);
        }
      }
      if (tag === 'news' || tag === '*') {
        urlSet.add(`${base}/tin-tuc`);
        urlSet.add(`${base}/api/news?page=1`);
      }
    }
    const urls = [...urlSet].slice(0, 30);
    if (!urls.length) return { skipped: true, reason: 'CLOUDFLARE_FREE_NO_TAG_MAPPING' };
    return this.purgeUrls(urls);
  }

  async purgeProduct(slug) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    if (process.env.CLOUDFLARE_TAG_PURGE === 'true') {
      const tags = [
        'gaeru-catalog',
        cleanSlug ? `gaeru-product-${cleanSlug}` : null
      ].filter(Boolean);
      return this.sendPurgeRequest({ tags });
    }
    const base = require('../primary-domain').normalizePublicBase(process.env.PUBLIC_BASE_URL || 'https://gaeru.com');
    const urls = [
      `${base}/`,
      `${base}/cua-hang`,
      `${base}/api/products`,
      `${base}/api/search-index.json`
    ];
    if (cleanSlug) {
      urls.push(
        `${base}/san-pham/${encodeURIComponent(cleanSlug)}`,
        `${base}/api/products/${encodeURIComponent(cleanSlug)}`
      );
    }
    return this.purgeUrls(urls);
  }

  async purgeCatalog() {
    if (process.env.CLOUDFLARE_TAG_PURGE === 'true') {
      return this.sendPurgeRequest({ tags: ['gaeru-catalog', 'gaeru-html'] });
    }
    const base = require('../primary-domain').normalizePublicBase(process.env.PUBLIC_BASE_URL || 'https://gaeru.com');
    return this.purgeUrls([
      `${base}/`,
      `${base}/cua-hang`,
      `${base}/tin-tuc`,
      `${base}/api/products`,
      `${base}/api/search-index.json`
    ]);
  }

  async purgeUrls(urls) {
    if (!Array.isArray(urls) || urls.length === 0) return { skipped: true };
    return this.sendPurgeRequest({ files: urls });
  }

  async purgeAll() {
    return this.sendPurgeRequest({ purge_everything: true });
  }
}

const edgePurge = new EdgePurgeService();

module.exports = {
  EdgePurgeService,
  edgePurge
};
