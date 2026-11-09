'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

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

    // Load persisted state if exists
    this.stateFilePath = path.join(__dirname, '..', '.failover-state.json');
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

  async syncFromPrimary() {
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

      // 1. Fetch public products from primary gaeru.com
      try {
        const prodRes = await fetch(`${this.primaryApiBase}/api/products`, {
          signal: AbortSignal.timeout(10000)
        });
        if (prodRes.ok) {
          const prodData = await prodRes.json();
          const products = Array.isArray(prodData) ? prodData : (prodData.products || []);
          if (this.pool && products.length > 0) {
            for (const p of products) {
              if (p.slug && p.name) {
                await this.pool.query(`
                  INSERT INTO products (slug, name, price, active, updated_at)
                  VALUES ($1, $2, $3, true, NOW())
                  ON CONFLICT (slug) DO UPDATE
                  SET name = EXCLUDED.name,
                      price = EXCLUDED.price,
                      updated_at = NOW();
                `, [p.slug, p.name, p.price || 0]).catch(() => {});
              }
            }
            stats.productsCount = products.length;
          }
        }
      } catch (errProd) {
        console.warn('[FailoverSync] Product sync notice:', errProd.message);
      }

      // 2. Fetch public store settings from primary gaeru.com
      try {
        const setRes = await fetch(`${this.primaryApiBase}/api/settings/public`, {
          signal: AbortSignal.timeout(8000)
        });
        if (setRes.ok) {
          const settings = await setRes.json();
          if (this.pool && typeof settings === 'object') {
            await this.pool.query(`
              INSERT INTO store_settings (key, value, updated_at)
              VALUES ('public_config', $1, NOW())
              ON CONFLICT (key) DO UPDATE
              SET value = EXCLUDED.value, updated_at = NOW();
            `, [JSON.stringify(settings)]).catch(() => {});
            stats.settingsSynced = true;
          }
        }
      } catch (errSet) {
        console.warn('[FailoverSync] Settings sync notice:', errSet.message);
      }

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
