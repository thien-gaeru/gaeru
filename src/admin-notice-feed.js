'use strict';

// Only trusted SQL fragments are assembled here. Account keys, versions, limits
// and offsets from a request always travel as query parameters.
function visibleSources(admin, config) {
  const can = permission => admin.permissions.includes(permission);
  const sources = [];
  if (can('orders.read') || can('invoice.approve')) sources.push(`
    SELECT 1,'misa-invoice-failed:'||q.id,NULL::text,q.updated_at,NULL::timestamptz,q.updated_at,0,
      'Lỗi phát hành hóa đơn MISA','Đơn '||o.order_number||' thất bại sau '||q.attempts||' lần thử ('||coalesce(q.last_error,'Lỗi kết nối MISA')||').','business','error'
    FROM misa_einvoice_retry_queue q JOIN orders o ON o.id=q.order_id WHERE q.status='failed'`);
  if (can('orders.read')) sources.push(`
    SELECT 2,'order:'||id,NULL::text,created_at,created_at,created_at,0,
      'Đơn hàng chờ xác nhận',order_number,'orders','info' FROM orders WHERE status='pending'`, `
    SELECT 3,'care:'||id,version::text,NULL::timestamptz,created_at,updated_at,0,
      'Hỗ trợ cần phản hồi',subject,'care','warning' FROM care_requests c
    WHERE status='submitted' OR (status='reviewing' AND
      (SELECT sender FROM care_messages WHERE care_id=c.id ORDER BY id DESC LIMIT 1)='customer')`, `
    SELECT 4,'warranty:'||id,version::text,NULL::timestamptz,created_at,created_at,0,
      'Đăng ký bảo hành chờ đối chiếu','Mở hồ sơ để kiểm tra chứng từ mua hàng.','warranty','info'
    FROM warranty_activations WHERE status='pending' AND automatic=false AND withdrawn_at IS NULL`);
  if (can('customers.read')) sources.push(`
    SELECT 5,'shopping-chat:'||id,version::text,NULL::timestamptz,created_at,updated_at,0,
      'Chat mua sắm cần phản hồi',product_name,'shopping-chat','warning'
    FROM shopping_chat_threads WHERE awaiting_admin AND status='open'`);
  if (can('inventory.read')) sources.push(`
    SELECT 6,'stock:'||v.id,v.stock_quantity::text,NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,v.stock_quantity,
      CASE WHEN v.stock_quantity=0 THEN 'Sản phẩm hết hàng' ELSE 'Sắp hết hàng' END,
      v.sku||' · Còn '||v.stock_quantity,'inventory','warning'
    FROM product_variants v JOIN products p ON p.id=v.product_id
    WHERE v.active AND p.active AND p.deleted_at IS NULL AND v.stock_quantity<=5`);
  if (can('settings.write')) {
    if (!config.TURNSTILE_SITE_KEY || !config.TURNSTILE_SECRET_KEY) sources.push(`
      SELECT 7,'config:turnstile','missing',NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,0,
        'Chưa bật CAPTCHA','Cần cấu hình Site key và Secret key Cloudflare Turnstile trên máy chủ.','settings','warning'`);
    if (!config.smtp) sources.push(`
      SELECT 7,'config:smtp','missing',NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,1,
        'Chưa cấu hình email','Email xác minh và khôi phục tài khoản chưa gửi được.','settings','warning'`);
  }
  if (!sources.length) return null;
  return `WITH source(group_no,key,raw_version,revision,created_at,sort_at,sort_number,title,detail,target,level) AS (
    ${sources.join(' UNION ALL ')}
  ), visible AS (
    SELECT source.*, coalesce(raw_version,to_char(revision AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS version
    FROM source
  )`;
}

// Earlier releases used String(Date) for order and invoice versions. Compare
// its second resolution and recorded numeric offset so old reads stay read.
function sameVersion(value) {
  return `(${value}=n.version OR CASE WHEN n.revision IS NOT NULL AND
    ${value} ~ '^[A-Za-z]{3} [A-Za-z]{3} [0-9]{2} [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT[+-][0-9]{4}'
    THEN left(${value},24)=to_char(n.revision AT TIME ZONE 'UTC' +
      (CASE substr(${value},29,1) WHEN '-' THEN -1 ELSE 1 END) *
      (substr(${value},30,2)::int * 60 + substr(${value},32,2)::int) * interval '1 minute',
      'Dy Mon DD YYYY HH24:MI:SS') ELSE false END)`;
}

async function noticePage(pool, admin, config, account, { page=1, pageSize=25 } = {}) {
  const visible = visibleSources(admin, config);
  const empty = { items:[], unread:0, total:0, pages:1, page:1, pageSize };
  if (!visible) return empty;
  const order = 'group_no, sort_number, sort_at DESC NULLS LAST, key';
  const { rows } = await pool.query(`${visible}, marked AS (
    SELECT n.*,coalesce(${sameVersion('r.seen_version')},false) AS is_read
    FROM visible n LEFT JOIN admin_notice_reads r ON r.account_key=$1 AND r.notice_key=n.key
  ), counts AS (
    SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT is_read)::int AS unread,
      greatest(1,ceil(count(*)::numeric/$2::int)::int) AS pages FROM marked
  ), bounds AS (SELECT counts.*, least($3::int,pages) AS page FROM counts),
  page_items AS (
    SELECT * FROM marked ORDER BY ${order} LIMIT $2::int OFFSET (SELECT (page-1)*$2::int FROM bounds)
  )
  SELECT bounds.*,coalesce((SELECT jsonb_agg(jsonb_build_object('key',key,'version',version,'title',title,
    'detail',detail,'target',target,'level',level,'createdAt',created_at,'read',is_read)
    ORDER BY ${order}) FROM page_items),'[]'::jsonb) AS items FROM bounds`, [account,pageSize,page]);
  return rows[0] ? { ...rows[0], pageSize } : empty;
}

async function readNotices(pool, admin, config, account, { all, key, version }) {
  const visible = visibleSources(admin, config);
  if (!visible) return Boolean(all);
  if (!all && (!key || !version)) return false;
  const filter = all ? '' : `WHERE n.key=$2 AND ${sameVersion('$3::text')}`;
  const result = await pool.query(`${visible}
    INSERT INTO admin_notice_reads(account_key,notice_key,seen_version)
    SELECT $1,n.key,n.version FROM visible n ${filter} ORDER BY n.key
    ON CONFLICT(account_key,notice_key) DO UPDATE SET seen_version=EXCLUDED.seen_version,seen_at=now()`,
    all ? [account] : [account,key,version]);
  return Boolean(all || (result.rowCount ?? result.affectedRows) > 0);
}

module.exports = { noticePage, readNotices };
