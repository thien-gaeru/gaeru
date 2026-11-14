'use strict';

const fs = require('fs');
const path = require('path');
const { withTransaction } = require('./db');
const inventory = require('./inventory');

class FailoverSyncManager {
  constructor(config = {}, pool = null) {
    this.config = config;
    this.pool = pool;
    this.role = process.env.SERVER_ROLE || config.SERVER_ROLE || 'standby';
    this.primaryDomain = process.env.PRIMARY_DOMAIN || config.PRIMARY_DOMAIN || 'gaeru.com';
    this.primaryApiBase = process.env.PRIMARY_API_BASE || config.PRIMARY_API_BASE || `https://${this.primaryDomain}`;
    this.autoSyncHours = parseInt(process.env.AUTO_SYNC_INTERVAL_HOURS || '6', 10);
    
    this.state = {
      role: this.role, // 'standby' | 'primary'
      primaryDomain: this.primaryDomain,
      primaryApiBase: this.primaryApiBase,
      isPromoted: this.role === 'primary',
      status: 'idle', // 'idle' | 'syncing' | 'error'
      lastSyncTime: null,
      lastSyncStats: null,
      lastError: null,
      primaryHealth: {
        online: false,
        latencyMs: 0,
        statusCode: null,
        checkedAt: null
      }
    };

    // Persist failover state outside repo root (DATA_DIR / MEDIA_ROOT parent / OS temp)
    const stateDir = config.DATA_DIR || process.env.DATA_DIR
      || (process.env.MEDIA_ROOT ? path.dirname(process.env.MEDIA_ROOT) : null)
      || require('node:os').tmpdir();
    this.stateFilePath = config.FAILOVER_STATE_PATH || process.env.FAILOVER_STATE_PATH
      || path.join(stateDir, 'gaeru-failover-state.json');
    try { fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true, mode: 0o700 }); } catch (_) {}
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.lastSyncTime) this.state.lastSyncTime = parsed.lastSyncTime;
        if (parsed.lastSyncStats) this.state.lastSyncStats = parsed.lastSyncStats;
        if (parsed.role) {
          this.state.role = parsed.role;
          this.state.isPromoted = parsed.role === 'primary';
        }
      }
    } catch (_) {}
  }

  saveState() {
    try {
      fs.writeFileSync(this.stateFilePath, JSON.stringify({
        role: this.state.role,
        lastSyncTime: this.state.lastSyncTime,
        lastSyncStats: this.state.lastSyncStats
      }, null, 2), 'utf8');
    } catch (_) {}
  }

  getStatus() {
    return {
      ok: true,
      role: this.state.role,
      isPromoted: this.state.isPromoted,
      primaryDomain: this.primaryDomain,
      primaryApiBase: this.primaryApiBase,
      status: this.state.status,
      lastSyncTime: this.state.lastSyncTime,
      lastSyncStats: this.state.lastSyncStats,
      lastError: this.state.lastError,
      primaryHealth: this.state.primaryHealth,
      readyForTraffic: true,
      timestamp: new Date().toISOString()
    };
  }

  async checkPrimaryHealth() {
    const start = Date.now();
    try {
      const url = `${this.primaryApiBase}/`;
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(6000)
      });
      const latencyMs = Date.now() - start;
      const online = res.status < 500;
      this.state.primaryHealth = {
        online,
        statusCode: res.status,
        latencyMs,
        checkedAt: new Date().toISOString()
      };
      return this.state.primaryHealth;
    } catch (e) {
      const latencyMs = Date.now() - start;
      this.state.primaryHealth = {
        online: false,
        statusCode: null,
        latencyMs,
        error: e.message,
        checkedAt: new Date().toISOString()
      };
      return this.state.primaryHealth;
    }
  }

  async syncFromPrimary({ fetcher = fetch } = {}) {
    if (this.state.status === 'syncing') {
      return { ok: false, error: 'Tiến trình đồng bộ đang chạy.' };
    }

    this.state.status = 'syncing';
    this.state.lastError = null;

    try {
      const stats = {
        productsCount: 0,
        settingsSynced: false,
        syncedAt: new Date().toISOString()
      };

      if (!this.pool) throw new Error('Chưa có cơ sở dữ liệu để đồng bộ.');
      // Read both snapshots before opening a transaction. No partial catalog or
      // stock update is committed if either request or any inventory check fails.
      const [prodRes, setRes] = await Promise.all([
        fetcher(`${this.primaryApiBase}/api/products`, {
          signal: AbortSignal.timeout(10000)
        }),
        fetcher(`${this.primaryApiBase}/api/settings/public`, {
          signal: AbortSignal.timeout(8000)
        })
      ]);
      if (!prodRes.ok || !setRes.ok) throw new Error(`Đồng bộ thất bại: HTTP ${!prodRes.ok ? prodRes.status : setRes.status}`);
      const [prodData, settings] = await Promise.all([prodRes.json(), setRes.json()]);
      const products = Array.isArray(prodData) ? prodData : prodData?.products;
      if (!Array.isArray(products) || !settings || typeof settings !== 'object' || Array.isArray(settings)) {
        throw new Error('Dữ liệu đồng bộ từ máy chủ chính không hợp lệ.');
      }
      const actor = { username: 'failover-sync', source: 'system', fullName: 'Đồng bộ máy chủ dự phòng' };
      await withTransaction(this.pool, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:failover-catalog-sync'))");
        for (const p of [...products].sort((a, b) => String(a?.slug).localeCompare(String(b?.slug)))) {
          if (!p?.slug || !p.name || !Array.isArray(p.variants)) throw new Error('Sản phẩm đồng bộ không hợp lệ.');
          const category = ['audio', 'video', 'accessory'].includes(p.category) ? p.category : 'audio';
          const prodRow = (await client.query(`
            INSERT INTO products (slug, name, category, descriptor, description, image_url, image_alt, active, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
            ON CONFLICT (slug) DO UPDATE
            SET name = EXCLUDED.name,
                category = EXCLUDED.category,
                descriptor = EXCLUDED.descriptor,
                description = EXCLUDED.description,
                image_url = EXCLUDED.image_url,
                image_alt = EXCLUDED.image_alt,
                active = true,
                updated_at = NOW()
            RETURNING id;
          `, [
            p.slug,
            p.name,
            category,
            p.descriptor || '',
            p.description || '',
            p.imageUrl || p.image_url || '',
            p.imageAlt || p.image_alt || ''
          ])).rows[0];

          const productId = prodRow.id;
          for (const v of [...p.variants].sort((a, b) => String(a?.sku).localeCompare(String(b?.sku)))) {
            const quantity = Number(v?.stockQuantity ?? v?.stock_quantity ?? 0);
            const price = Number(v?.priceVnd ?? v?.price_vnd ?? 0);
            if (!v?.sku || !v.name || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1_000_000_000 ||
                !Number.isSafeInteger(price) || price < 0 || price > 2_000_000_000) {
              throw new Error('Giá hoặc tồn kho đồng bộ không hợp lệ.');
            }
            const variant = (await client.query(`
              INSERT INTO product_variants (product_id, sku, name, options, price_vnd, stock_quantity, active, updated_at)
              VALUES ($1, $2, $3, $4, $5, 0, true, NOW())
              ON CONFLICT (sku) DO UPDATE
              SET name = EXCLUDED.name,
                  options = EXCLUDED.options,
                  price_vnd = EXCLUDED.price_vnd,
                  active = true,
                  updated_at = NOW()
              RETURNING id, product_id, stock_quantity;
            `, [productId, v.sku, v.name, JSON.stringify(v.options || {}), price])).rows[0];
            if (variant.product_id !== productId) throw new Error('SKU đồng bộ thuộc sản phẩm khác; cần đối soát trước khi đồng bộ.');
            // Preserve local IDs and inventory history. Initialize new (or legacy
            // unallocated) stock, then record a normal ledger adjustment so the
            // aggregate and warehouse balances agree.
            await inventory.initializeVariantStock(client, { variantId: variant.id, quantity: variant.stock_quantity, actor });
            await inventory.setVariantStock(client, { variantId: variant.id, quantity, actor, reason: 'Đối chiếu tồn khả dụng từ máy chủ chính' });
          }
        }
        await client.query(`
          INSERT INTO store_settings (setting_key, setting_value, updated_at)
          VALUES ('public_config', $1::jsonb, NOW())
          ON CONFLICT (setting_key) DO UPDATE
          SET setting_value = EXCLUDED.setting_value, updated_at = NOW();
        `, [JSON.stringify(settings)]);
      });
      stats.productsCount = products.length;
      stats.settingsSynced = true;

      this.state.status = 'idle';
      this.state.lastSyncTime = stats.syncedAt;
      this.state.lastSyncStats = stats;
      this.saveState();

      return {
        ok: true,
        message: 'Đồng bộ dữ liệu từ máy chủ chính thành công.',
        stats
      };
    } catch (e) {
      this.state.status = 'error';
      this.state.lastError = e.message;
      return { ok: false, error: e.message };
    }
  }

  promoteToPrimary() {
    this.state.role = 'primary';
    this.state.isPromoted = true;
    this.saveState();
    return {
      ok: true,
      role: 'primary',
      message: 'Đã kích hoạt máy chủ LG G7 ThinQ trở thành Máy Chủ Chính (Active Primary).'
    };
  }

  demoteToStandby() {
    this.state.role = 'standby';
    this.state.isPromoted = false;
    this.saveState();
    return {
      ok: true,
      role: 'standby',
      message: 'Đã chuyển máy chủ LG G7 ThinQ về chế độ Máy Chủ Dự Phòng Thường Trực (Hot Standby Failover).'
    };
  }
}

let instance = null;

function getFailoverSync(config, pool) {
  if (!instance) {
    instance = new FailoverSyncManager(config, pool);
  }
  return instance;
}

module.exports = {
  FailoverSyncManager,
  getFailoverSync
};
