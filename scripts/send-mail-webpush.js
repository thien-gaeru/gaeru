'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_ENV_PATH = path.join(ROOT_DIR, 'app.env');

if (fs.existsSync(APP_ENV_PATH)) {
  const lines = fs.readFileSync(APP_ENV_PATH, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const rawKey = trimmed.slice(0, eq).trim();
    if (!rawKey.startsWith('ENV_')) continue;
    const envKey = rawKey.slice(4);
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[envKey]) process.env[envKey] = val;
  }
}

require('dotenv').config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db');
const { sendWebPushNotification } = require('../src/web-push');
const { assertSafePushEndpoint } = require('../src/audit-fixes/push-url-guard');

const WEBPUSH_SQLITE_PATH = process.env.GAERU_WEBPUSH_SQLITE || '/opt/gaeru-webmail/data/webpush.sqlite';

function openWebmailPushDb() {
  const dir = path.dirname(WEBPUSH_SQLITE_PATH);
  if (!fs.existsSync(dir)) return null;
  const db = new DatabaseSync(WEBPUSH_SQLITE_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_username ON push_subscriptions(username);
  `);
  return db;
}

function normalizeUser(u) {
  return String(u || '').trim().toLowerCase().split('@')[0];
}

async function run() {
  const args = process.argv.slice(2);
  const vapid = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT || 'mailto:business@gaeru.com'
  };

  if (!vapid.publicKey || !vapid.privateKey) {
    throw new Error('Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY');
  }

  const testUserIdx = args.indexOf('--test-user');
  if (testUserIdx !== -1) {
    const testUser = normalizeUser(args[testUserIdx + 1] || 'business');
    const sqliteDb = openWebmailPushDb();
    let subs = [];
    if (sqliteDb) {
      const stmt = sqliteDb.prepare('SELECT endpoint, p256dh, auth, username FROM push_subscriptions WHERE username = ?');
      subs = stmt.all(testUser);
    }
    let sent = 0;
    for (const s of subs) {
      try {
        await assertSafePushEndpoint(s.endpoint);
        const res = await sendWebPushNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          {
            title: '✉️ GAERU Mail · Thông báo đẩy đã hoạt động',
            body: `Hộp thư ${testUser}@gaeru.com đã sẵn sàng nhận thông báo đẩy tức thì khi có email mới.`,
            target: 'webmail',
            url: 'https://mail.gaeru.com/?_task=mail&_mbox=INBOX',
            tag: `gaeru-mail-test-${Date.now()}`
          },
          vapid
        );
        if (res.gone && sqliteDb) {
          sqliteDb.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
        } else if (res.ok) {
          sent += 1;
        }
      } catch (_) {}
    }
    if (sqliteDb) sqliteDb.close();
    process.stdout.write(JSON.stringify({ ok: sent > 0, sent, user: testUser }) + '\n');
    return;
  }

  // Read JSON event from stdin (--from-stdin)
  const rawInput = fs.readFileSync(0, 'utf8').trim();
  if (!rawInput) return;
  const evt = JSON.parse(rawInput);
  const uid = String(evt.uid || Date.now());
  const mailboxUser = normalizeUser(evt.user || 'business');
  const recipient = String(evt.recipient || `${mailboxUser}@gaeru.com`).trim();
  const sender = String(evt.sender || '').trim();
  const subject = String(evt.subject || '(Không tiêu đề)').trim();

  const targetsByEndpoint = new Map();
  const sqliteDb = openWebmailPushDb();
  if (sqliteDb) {
    const stmt = sqliteDb.prepare(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE username = ? OR username IN ('business', 'admin', 'gaerutest')"
    );
    for (const row of stmt.all(mailboxUser)) {
      targetsByEndpoint.set(row.endpoint, {
        source: 'sqlite',
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth
      });
    }
  }

  let pool = null;
  try {
    const cfg = loadConfig(process.env);
    pool = createPool(cfg);
    await pool.query(
      `INSERT INTO inbound_mail_notifications (mail_uid, mailbox_user, recipient, sender, subject)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (mail_uid) DO NOTHING`,
      [uid.slice(0, 120), mailboxUser.slice(0, 120), recipient.slice(0, 255), sender.slice(0, 255), subject.slice(0, 500)]
    );
    await pool.query(
      `DELETE FROM inbound_mail_notifications
       WHERE id NOT IN (
         SELECT id FROM inbound_mail_notifications ORDER BY received_at DESC LIMIT 200
       )`
    );
    const pgSubs = await pool.query(
      `SELECT s.endpoint, s.p256dh, s.auth
       FROM admin_push_subscriptions s
       LEFT JOIN staff_accounts sa ON s.account_key = ('staff:' || sa.id::text)
       WHERE s.account_key = 'owner'
          OR (sa.active = true AND sa.role IN ('owner', 'admin'))`
    );
    for (const row of pgSubs.rows) {
      if (!targetsByEndpoint.has(row.endpoint)) {
        targetsByEndpoint.set(row.endpoint, {
          source: 'pg',
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth
        });
      }
    }
  } catch (_) {}

  const pushPayload = {
    title: `✉️ Thư mới · ${sender || recipient}`,
    body: `[${recipient}] ${subject}`,
    target: 'webmail',
    url: 'https://mail.gaeru.com/?_task=mail&_mbox=INBOX',
    tag: `gaeru-mail-${uid}`
  };

  let sent = 0;
  for (const sub of targetsByEndpoint.values()) {
    try {
      await assertSafePushEndpoint(sub.endpoint);
      const res = await sendWebPushNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        pushPayload,
        vapid
      );
      if (res.gone) {
        if (sqliteDb) {
          sqliteDb.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        }
        if (pool) {
          await pool.query('DELETE FROM admin_push_subscriptions WHERE endpoint = $1', [sub.endpoint]).catch(() => {});
        }
      } else if (res.ok) {
        sent += 1;
      }
    } catch (_) {}
  }

  if (sqliteDb) sqliteDb.close();
  if (pool) await pool.end().catch(() => {});
  process.stdout.write(JSON.stringify({ ok: true, uid, sent, subscribers: targetsByEndpoint.size }) + '\n');
}

run().catch((err) => {
  console.error('send-mail-webpush error:', err.message);
  process.exit(1);
});
