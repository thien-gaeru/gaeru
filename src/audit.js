const SECRET_KEY = /(?:password|passwd|secret|token|authorization|cookie|credential|privatekey|apikey|hash)/i;

function sanitizeAuditValue(value, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 4000);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (value === undefined || typeof value !== "object" || depth >= 8) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitizeAuditValue(entry, depth + 1));
  const sanitized = Object.create(null);
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    const compactKey = key.replace(/[^a-z0-9]/gi, "");
    if (SECRET_KEY.test(compactKey) || ["__proto__", "constructor", "prototype"].includes(key)) continue;
    sanitized[key.slice(0, 120)] = sanitizeAuditValue(entry, depth + 1);
  }
  return sanitized;
}

async function appendAudit(client, { actor, action, entityType, entityId = null, metadata, details, before = null, after = null }) {
  if (!actor?.username || !action || !entityType) throw new Error("Audit actor, action and entity type are required.");
  const result = await client.query(
    `INSERT INTO audit_events
       (actor_id, actor_username, actor_name, actor_role, actor_source, action, entity_type, entity_id, before_state, after_state, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      actor.id || null, String(actor.username).slice(0, 100), String(actor.fullName || actor.username).slice(0, 160),
      String(actor.role || "system").slice(0, 40), String(actor.source || "system").slice(0, 40),
      String(action).slice(0, 100), String(entityType).slice(0, 80), entityId == null ? null : String(entityId).slice(0, 160),
      sanitizeAuditValue(before), sanitizeAuditValue(after), sanitizeAuditValue(metadata ?? details ?? {})
    ]
  );
  return result.rows[0] || null;
}

module.exports = { appendAudit, sanitizeAuditValue };
