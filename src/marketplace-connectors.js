const crypto = require('node:crypto');

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizeStatus(channel, rawStatus) {
  const s = String(rawStatus || '').toUpperCase().trim();
  if (['CANCELLED', 'CANCELED', 'CANCEL', 'HUY', 'CLOSED', 'DEAD'].some(k => s.includes(k))) {
    return 'cancelled';
  }
  if (['RETURNED', 'REFUND', 'RETURN', 'TRA_HANG'].some(k => s.includes(k))) {
    return 'returned';
  }
  if (['COMPLETED', 'DELIVERED', 'SUCCESS', 'HOAN_TAT', 'FINISH'].some(k => s.includes(k))) {
    return 'completed';
  }
  if (['SHIPPED', 'DELIVERING', 'IN_TRANSIT', 'TRANSIT', 'DANG_GIAO'].some(k => s.includes(k))) {
    return 'shipped';
  }
  if (['PROCESSING', 'READY_TO_SHIP', 'PROCESSED', 'CONFIRMED', 'AWAITING_COLLECTION'].some(k => s.includes(k))) {
    return 'processing';
  }
  return 'pending';
}

// -----------------------------------------------------------------------------
// 1. SHOPEE OPEN PLATFORM V2 CONNECTOR
// -----------------------------------------------------------------------------
const shopeeConnector = {
  createSignature(partnerKey, partnerId, path, timestamp, accessToken = '', shopId = '') {
    const baseStr = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
    return crypto.createHmac('sha256', partnerKey).update(baseStr, 'utf8').digest('hex');
  },

  getAuthUrl({ partnerId, partnerKey, redirectUrl }) {
    if (!partnerId || !partnerKey) throw fail('Cần partnerId và partnerKey của Shopee.', 400);
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/shop/auth_partner';
    const sign = crypto.createHmac('sha256', partnerKey).update(`${partnerId}${path}${timestamp}`, 'utf8').digest('hex');
    const redirect = encodeURIComponent(redirectUrl || 'https://gaeru.com/api/marketplace/shopee/callback');
    return `https://partner.shopeemobile.com/api/v2/shop/auth_partner?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${redirect}`;
  },

  async exchangeToken({ partnerId, partnerKey, code, shopId }, { fetcher = fetch } = {}) {
    if (!partnerId || !partnerKey || !code || !shopId) throw fail('Thiếu tham số đổi token Shopee.', 400);
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/auth/token/get';
    const sign = crypto.createHmac('sha256', partnerKey).update(`${partnerId}${path}${timestamp}`, 'utf8').digest('hex');
    const url = `https://partner.shopeemobile.com${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;

    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, partner_id: Number(partnerId), shop_id: Number(shopId) }),
      signal: AbortSignal.timeout(12000)
    });

    if (!res.ok) throw fail(`Shopee token exchange failed HTTP ${res.status}`, 502);
    const json = await res.json();
    if (json.error) throw fail(`Shopee API error: ${json.message || json.error}`, 502);

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expireIn: json.expire_in,
      shopId: String(shopId)
    };
  },

  async fetchOrders({ partnerId, partnerKey, accessToken, shopId, timeFrom, timeTo, status }, { fetcher = fetch } = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/order/get_order_list';
    const sign = this.createSignature(partnerKey, partnerId, path, timestamp, accessToken, shopId);
    const url = `https://partner.shopeemobile.com${path}?partner_id=${partnerId}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}&time_range_field=create_time&time_from=${timeFrom || (timestamp - 86400 * 3)}&time_to=${timeTo || timestamp}&page_size=50${status ? `&order_status=${status}` : ''}`;

    const res = await fetcher(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`Shopee fetch orders failed HTTP ${res.status}`, 502);
    const json = await res.json();
    if (json.error) throw fail(`Shopee API error: ${json.message || json.error}`, 502);

    const orderList = json.response?.order_list || [];
    return orderList.map(o => ({
      externalOrderId: String(o.order_sn),
      orderDate: new Date((o.create_time || timestamp) * 1000).toISOString().slice(0, 10),
      rawStatus: o.order_status,
      status: normalizeStatus('shopee', o.order_status),
      items: (o.item_list || []).map(i => ({
        externalSku: i.model_sku || i.item_sku || String(i.item_id),
        productName: i.item_name,
        quantity: i.model_quantity_purchased || i.item_quantity || 1,
        unitPriceVnd: Math.round(Number(i.model_discounted_price || i.model_original_price || 0))
      })),
      totalAmountVnd: Math.round(Number(o.total_amount || 0))
    }));
  },

  async updateStock({ partnerId, partnerKey, accessToken, shopId, itemId, modelId, stock }, { fetcher = fetch } = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/product/update_stock';
    const sign = this.createSignature(partnerKey, partnerId, path, timestamp, accessToken, shopId);
    const url = `https://partner.shopeemobile.com${path}?partner_id=${partnerId}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

    const payload = {
      item_id: Number(itemId),
      stock_list: [{ model_id: modelId ? Number(modelId) : 0, normal_stock: Number(stock) }]
    };

    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw fail(`Shopee update stock failed HTTP ${res.status}`, 502);
    const json = await res.json();
    return { success: !json.error, response: json };
  },

  async shipOrder({ partnerId, partnerKey, accessToken, shopId, orderSn, dropoff = {} }, { fetcher = fetch } = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/logistics/ship_order';
    const sign = this.createSignature(partnerKey, partnerId, path, timestamp, accessToken, shopId);
    const url = `https://partner.shopeemobile.com${path}?partner_id=${partnerId}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

    const res = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_sn: orderSn, dropoff }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw fail(`Shopee ship order failed HTTP ${res.status}`, 502);
    const json = await res.json();
    if (json.error) throw fail(`Shopee API error: ${json.message || json.error}`, 502);
    return { success: true, response: json };
  },

  verifyWebhookSignature(signature, rawBody, partnerKey) {
    if (!signature || !partnerKey) return false;
    const computed = crypto.createHmac('sha256', partnerKey).update(rawBody, 'utf8').digest('hex');
    const bufA = Buffer.from(signature);
    const bufB = Buffer.from(computed);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }
};

// -----------------------------------------------------------------------------
// 2. TIKTOK SHOP OPEN API CONNECTOR
// -----------------------------------------------------------------------------
const tiktokConnector = {
  getAuthUrl({ appKey, redirectUrl }) {
    if (!appKey) throw fail('Cần appKey của TikTok Shop.', 400);
    const redirect = encodeURIComponent(redirectUrl || 'https://gaeru.com/api/marketplace/tiktok/callback');
    return `https://services.tiktokshops.us/open/authorize?app_key=${appKey}&state=gaeru_tiktok_state&redirect_uri=${redirect}`;
  },

  async exchangeToken({ appKey, appSecret, authCode }, { fetcher = fetch } = {}) {
    const url = `https://auth.tiktok-shops.com/api/v2/token/get?app_key=${appKey}&app_secret=${appSecret}&auth_code=${authCode}&grant_type=authorized_code`;
    const res = await fetcher(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw fail(`TikTok Shop token exchange failed HTTP ${res.status}`, 502);
    const json = await res.json();
    if (json.code !== 0) throw fail(`TikTok API error: ${json.message}`, 502);
    return {
      accessToken: json.data?.access_token,
      refreshToken: json.data?.refresh_token,
      shopCipher: json.data?.open_id_list?.[0] || 'DEFAULT_SHOP'
    };
  },

  async fetchOrders({ appKey, appSecret, accessToken, shopCipher, createTimeFrom, createTimeTo, orderStatus }, { fetcher = fetch } = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/order/202309/orders/search';
    const sign = crypto.createHmac('sha256', appSecret).update(`${appKey}${path}app_key${appKey}timestamp${timestamp}${appSecret}`, 'utf8').digest('hex');
    const url = `https://open-api.tiktokglobalshop.com${path}?app_key=${appKey}&sign=${sign}&timestamp=${timestamp}&shop_cipher=${shopCipher}`;

    const body = {
      page_size: 50,
      create_time_ge: createTimeFrom || (timestamp - 86400 * 3),
      create_time_lt: createTimeTo || timestamp
    };
    if (orderStatus) body.order_status = orderStatus;

    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tts-access-token': accessToken || ''
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) throw fail(`TikTok Shop fetch orders failed HTTP ${res.status}`, 502);
    const json = await res.json();
    if (json.code !== 0 && json.code !== 200) throw fail(`TikTok API error: ${json.message}`, 502);

    const orders = json.data?.orders || [];
    return orders.map(o => ({
      externalOrderId: String(o.id),
      orderDate: new Date((o.create_time || timestamp) * 1000).toISOString().slice(0, 10),
      rawStatus: o.status,
      status: normalizeStatus('tiktok', o.status),
      items: (o.line_items || []).map(i => ({
        externalSku: i.seller_sku || i.sku_id || String(i.product_id),
        productName: i.product_name,
        quantity: i.quantity || 1,
        unitPriceVnd: Math.round(Number(i.sale_price || 0))
      })),
      totalAmountVnd: Math.round(Number(o.payment?.total_amount || 0))
    }));
  },

  async updateStock({ appKey, appSecret, accessToken, shopCipher, productId, skuId, availableStock }, { fetcher = fetch } = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = `/product/202309/products/${productId}/stocks/update`;
    const sign = crypto.createHmac('sha256', appSecret).update(`${appKey}${path}app_key${appKey}timestamp${timestamp}${appSecret}`, 'utf8').digest('hex');
    const url = `https://open-api.tiktokglobalshop.com${path}?app_key=${appKey}&sign=${sign}&timestamp=${timestamp}&shop_cipher=${shopCipher}`;

    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tts-access-token': accessToken || ''
      },
      body: JSON.stringify({
        skus: [{ id: skuId, available_stock: Number(availableStock) }]
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw fail(`TikTok update stock failed HTTP ${res.status}`, 502);
    const json = await res.json();
    return { success: json.code === 0 || json.code === 200, response: json };
  },

  async shipOrder({ appKey, appSecret, accessToken, shopCipher, packageId }, { fetcher = fetch } = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const path = `/fulfillment/202309/packages/${packageId}/ship`;
    const sign = crypto.createHmac('sha256', appSecret).update(`${appKey}${path}app_key${appKey}timestamp${timestamp}${appSecret}`, 'utf8').digest('hex');
    const url = `https://open-api.tiktokglobalshop.com${path}?app_key=${appKey}&sign=${sign}&timestamp=${timestamp}&shop_cipher=${shopCipher}`;

    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tts-access-token': accessToken || ''
      },
      body: JSON.stringify({ pick_up_type: 1 }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw fail(`TikTok ship order failed HTTP ${res.status}`, 502);
    const json = await res.json();
    return { success: json.code === 0 || json.code === 200, response: json };
  },

  verifyWebhookSignature(signature, rawBody, appSecret) {
    if (!signature || !appSecret) return false;
    const computed = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
    const bufA = Buffer.from(signature);
    const bufB = Buffer.from(computed);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }
};

// -----------------------------------------------------------------------------
// 3. LAZADA OPEN PLATFORM CONNECTOR
// -----------------------------------------------------------------------------
const lazadaConnector = {
  createSignature(appSecret, path, params) {
    const keys = Object.keys(params).sort();
    let str = path;
    for (const k of keys) {
      str += `${k}${params[k]}`;
    }
    return crypto.createHmac('sha256', appSecret).update(str, 'utf8').digest('hex').toUpperCase();
  },

  getAuthUrl({ appKey, redirectUrl }) {
    if (!appKey) throw fail('Cần appKey của Lazada.', 400);
    const redirect = encodeURIComponent(redirectUrl || 'https://gaeru.com/api/marketplace/lazada/callback');
    return `https://auth.lazada.com/oauth/authorize?response_type=code&force_auth=true&redirect_uri=${redirect}&client_id=${appKey}`;
  },

  async exchangeToken({ appKey, appSecret, code }, { fetcher = fetch } = {}) {
    const timestamp = Date.now();
    const path = '/auth/token/create';
    const params = { app_key: appKey, code, sign_method: 'sha256', timestamp };
    const sign = this.createSignature(appSecret, path, params);
    const url = `https://auth.lazada.com/rest${path}?app_key=${appKey}&code=${code}&sign_method=sha256&timestamp=${timestamp}&sign=${sign}`;

    const res = await fetcher(url, { method: 'POST', signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw fail(`Lazada token exchange failed HTTP ${res.status}`, 502);
    const json = await res.json();
    if (json.code !== '0' && json.code !== 0) throw fail(`Lazada API error: ${json.message}`, 502);

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      sellerId: json.country_user_info?.[0]?.seller_id || 'DEFAULT_SELLER'
    };
  },

  async fetchOrders({ appKey, appSecret, accessToken, createdAfter, status }, { fetcher = fetch } = {}) {
    const timestamp = Date.now();
    const path = '/orders/get';
    const params = {
      app_key: appKey,
      access_token: accessToken,
      sign_method: 'sha256',
      timestamp,
      created_after: createdAfter || new Date(Date.now() - 86400 * 3 * 1000).toISOString(),
      limit: 50
    };
    if (status) params.status = status;
    params.sign = this.createSignature(appSecret, path, params);

    const query = new URLSearchParams(params).toString();
    const url = `https://api.lazada.vn/rest${path}?${query}`;

    const res = await fetcher(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw fail(`Lazada fetch orders failed HTTP ${res.status}`, 502);
    const json = await res.json();
    if (json.code !== '0' && json.code !== 0) throw fail(`Lazada API error: ${json.message}`, 502);

    const orders = json.data?.orders || [];
    return orders.map(o => ({
      externalOrderId: String(o.order_id),
      orderDate: new Date(o.created_at || Date.now()).toISOString().slice(0, 10),
      rawStatus: o.statuses?.[0] || 'pending',
      status: normalizeStatus('lazada', o.statuses?.[0] || 'pending'),
      items: (o.items || []).map(i => ({
        externalSku: i.sku || String(i.item_id),
        productName: i.name,
        quantity: i.quantity || 1,
        unitPriceVnd: Math.round(Number(i.item_price || 0))
      })),
      totalAmountVnd: Math.round(Number(o.price || 0))
    }));
  },

  async updateStock({ appKey, appSecret, accessToken, sku, quantity }, { fetcher = fetch } = {}) {
    const timestamp = Date.now();
    const path = '/product/price_quantity/update';
    const payloadXml = `<Request><Product><Skus><Sku><SellerSku>${sku}</SellerSku><Quantity>${quantity}</Quantity></Sku></Skus></Product></Request>`;
    const params = {
      app_key: appKey,
      access_token: accessToken,
      sign_method: 'sha256',
      timestamp,
      payload: payloadXml
    };
    params.sign = this.createSignature(appSecret, path, params);

    const res = await fetcher(`https://api.lazada.vn/rest${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw fail(`Lazada update stock failed HTTP ${res.status}`, 502);
    const json = await res.json();
    return { success: json.code === '0' || json.code === 0, response: json };
  },

  async readyToShip({ appKey, appSecret, accessToken, orderItemIds, deliveryType = 'dropship' }, { fetcher = fetch } = {}) {
    const timestamp = Date.now();
    const path = '/order/package/rts';
    const params = {
      app_key: appKey,
      access_token: accessToken,
      sign_method: 'sha256',
      timestamp,
      order_item_ids: JSON.stringify(orderItemIds),
      delivery_type: deliveryType
    };
    params.sign = this.createSignature(appSecret, path, params);

    const res = await fetcher(`https://api.lazada.vn/rest${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw fail(`Lazada ready to ship failed HTTP ${res.status}`, 502);
    const json = await res.json();
    return { success: json.code === '0' || json.code === 0, response: json };
  },

  verifyWebhookSignature(signature, rawBody, appSecret) {
    if (!signature || !appSecret) return false;
    const computed = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex').toUpperCase();
    const bufA = Buffer.from(signature.toUpperCase());
    const bufB = Buffer.from(computed);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }
};

const connectors = {
  shopee: shopeeConnector,
  tiktok: tiktokConnector,
  lazada: lazadaConnector
};

function getConnector(channel) {
  const connector = connectors[channel];
  if (!connector) throw fail(`Không hỗ trợ sàn thương mại điện tử: ${channel}`, 400);
  return connector;
}

module.exports = {
  normalizeStatus,
  getConnector,
  connectors,
  shopeeConnector,
  tiktokConnector,
  lazadaConnector
};
