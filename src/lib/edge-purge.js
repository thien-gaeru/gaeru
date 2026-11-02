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

    return this.sendPurgeRequest({ tags: cleanTags });
  }

  async purgeProduct(slug) {
    const cleanSlug = String(slug || '').trim().toLowerCase();
    const tags = [
      'gaeru-catalog',
      cleanSlug ? `gaeru-product-${cleanSlug}` : null
    ].filter(Boolean);

    return this.purgeTags(tags);
  }

  async purgeCatalog() {
    return this.purgeTags(['gaeru-catalog', 'gaeru-html']);
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
