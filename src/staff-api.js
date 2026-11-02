const bcrypt = require("bcryptjs");
const { Router } = require("express");
const { z } = require("zod");
const { withTransaction } = require("./db");
const { requireCsrf } = require("./security");
const { requirePermission, publicRoles } = require("./staff-access");
const { appendAudit } = require("./audit");

const roles = ["admin", "manager", "sales", "warehouse", "accountant", "viewer"];
const passwordSchema = z.string().min(12).max(200).refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Mật khẩu tối đa 72 byte UTF-8.");
const staffCreateSchema = z.object({
  username: z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  fullName: z.string().trim().min(2).max(160), password: passwordSchema, role: z.enum(roles),
  departmentId: z.string().uuid().nullable().optional(), active: z.boolean().default(true)
}).strict();
const staffUpdateSchema = z.object({
  fullName: z.string().trim().min(2).max(160).optional(), role: z.enum(roles).optional(), active: z.boolean().optional(),
  password: passwordSchema.optional(), departmentId: z.string().uuid().nullable().optional(), version: z.number().int().min(1)
}).strict().refine((value) => Object.keys(value).some((key) => key !== "version"));
const departmentFields = {
  code: z.string().trim().min(2).max(40).transform((value) => value.toUpperCase()).pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]*$/)),
  name: z.string().trim().min(2).max(160), active: z.boolean()
};
const departmentCreateSchema = z.object({ ...departmentFields, active: departmentFields.active.default(true) }).strict();
const departmentUpdateSchema = z.object({
  code: departmentFields.code.optional(), name: departmentFields.name.optional(), active: departmentFields.active.optional(),
  version: z.number().int().min(1)
}).strict().refine((value) => Object.keys(value).some((key) => key !== "version"));

const staffColumns = `s.id, s.username, s.full_name AS "fullName", s.role, s.active,
  s.department_id AS "departmentId", d.name AS "departmentName", s.version,
  s.created_at AS "createdAt", s.updated_at AS "updatedAt"`;
const departmentColumns = `id, code, name, active, version, created_at AS "createdAt", updated_at AS "updatedAt"`;

function problem(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireId(req, res, next) {
  if (!z.string().uuid().safeParse(req.params.id).success) return res.status(400).json({ error: "Mã bản ghi không hợp lệ." });
  next();
}

function listQuery(query) {
  const q = String(query.q || "").trim();
  const page = Number(query.page || 1);
  if (q.length > 120 || !Number.isInteger(page) || page < 1 || page > 100000) throw problem(400, "Bộ lọc hoặc trang chưa hợp lệ.");
  return { q, page, pageSize: 25 };
}

function paginationFor(total, requestedPage, pageSize) {
  const pageCount = Math.ceil(total / pageSize);
  return { page: Math.min(requestedPage, Math.max(1, pageCount)), pageSize, total, pageCount };
}

function auditDateBoundary(value, endOfDay = false) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const calendarDate = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== value) throw problem(400, "Ngày lọc nhật ký chưa hợp lệ.");
    // A date selected by the Vietnamese business UI refers to a full day in Vietnam.
    const timestamp = Date.parse(`${value}T00:00:00.000+07:00`) + (endOfDay ? 86400000 : 0);
    return new Date(timestamp).toISOString();
  }
  if (!z.iso.datetime({ offset: true }).safeParse(value).success) throw problem(400, "Ngày lọc nhật ký chưa hợp lệ.");
  return new Date(value).toISOString();
}

function handleError(error, res, next) {
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === "23505") return res.status(409).json({ error: "Tên đăng nhập hoặc mã phòng ban đã được sử dụng." });
  if (error.code === "23503") return res.status(409).json({ error: "Phòng ban được chọn không còn khả dụng." });
  next(error);
}

async function requireActiveDepartment(client, departmentId) {
  if (!departmentId) return;
  const result = await client.query("SELECT id FROM departments WHERE id=$1 AND active=true FOR KEY SHARE", [departmentId]);
  if (!result.rows[0]) throw problem(409, "Chọn một phòng ban đang hoạt động.");
}

async function loadStaff(client, id) {
  const result = await client.query(`SELECT ${staffColumns} FROM staff_accounts s LEFT JOIN departments d ON d.id=s.department_id WHERE s.id=$1`, [id]);
  return result.rows[0];
}

function createStaffApi(pool, config) {
  const router = Router();

  router.get("/staff", requirePermission("staff.read"), async (req, res, next) => {
    try {
      const { q, page, pageSize } = listQuery(req.query);
      const role = String(req.query.role || "");
      const active = String(req.query.active || "");
      if ((role && !roles.includes(role)) || (active && !["true", "false"].includes(active))) throw problem(400, "Bộ lọc nhân viên chưa hợp lệ.");
      const values = [q, role, active];
      const where = `($1::text='' OR s.username ILIKE '%' || $1 || '%' OR s.full_name ILIKE '%' || $1 || '%')
        AND ($2::text='' OR s.role=$2) AND ($3::text='' OR s.active=($3='true'))`;
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM staff_accounts s WHERE ${where}`, values);
      const pagination = paginationFor(count.rows[0]?.total || 0, page, pageSize);
      const result = await pool.query(
        `SELECT ${staffColumns} FROM staff_accounts s LEFT JOIN departments d ON d.id=s.department_id
         WHERE ${where} ORDER BY s.full_name, s.id LIMIT $4 OFFSET $5`,
        [...values, pageSize, (pagination.page - 1) * pageSize]
      );
      res.json({ staff: result.rows, pagination, roles: publicRoles(), bootstrap: { username: config.ADMIN_USERNAME, role: "owner", managedByEnvironment: true } });
    } catch (error) { handleError(error, res, next); }
  });

  router.post("/staff", requirePermission("staff.write"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = staffCreateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin nhân viên chưa hợp lệ. Mật khẩu cần ít nhất 12 ký tự và tối đa 72 byte UTF-8.", details: parsed.error.issues });
      const input = parsed.data;
      if (input.username.toLowerCase() === config.ADMIN_USERNAME.toLowerCase()) throw problem(409, "Tên đăng nhập này dành cho tài khoản chủ doanh nghiệp.");
      const passwordHash = await bcrypt.hash(input.password, 12);
      const staff = await withTransaction(pool, async (client) => {
        await requireActiveDepartment(client, input.departmentId);
        const inserted = await client.query(
          `INSERT INTO staff_accounts (username, full_name, password_hash, role, department_id, active)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [input.username, input.fullName, passwordHash, input.role, input.departmentId || null, input.active]
        );
        const record = await loadStaff(client, inserted.rows[0].id);
        await appendAudit(client, { actor: req.admin, action: "staff.create", entityType: "staff", entityId: record.id, after: record });
        return record;
      });
      res.status(201).json({ staff });
    } catch (error) { handleError(error, res, next); }
  });

  router.patch("/staff/:id", requirePermission("staff.write"), requireId, requireCsrf, async (req, res, next) => {
    try {
      const parsed = staffUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Cập nhật nhân viên chưa hợp lệ. Gửi phiên bản hiện tại của bản ghi.", details: parsed.error.issues });
      const input = parsed.data;
      const passwordHash = input.password === undefined ? null : await bcrypt.hash(input.password, 12);
      const staff = await withTransaction(pool, async (client) => {
        const locked = await client.query(
          `SELECT id, full_name AS "fullName", role, active, department_id AS "departmentId", version
           FROM staff_accounts WHERE id=$1 FOR UPDATE`, [req.params.id]
        );
        const current = locked.rows[0];
        if (!current) throw problem(404, "Không tìm thấy nhân viên.");
        if (current.version !== input.version) throw problem(409, "Thông tin nhân viên đã thay đổi. Tải lại trước khi lưu.");
        if (input.departmentId !== undefined && input.departmentId !== current.departmentId) await requireActiveDepartment(client, input.departmentId);
        const revoke = (input.role !== undefined && input.role !== current.role)
          || (input.active !== undefined && input.active !== current.active) || passwordHash !== null;
        const before = await loadStaff(client, current.id);
        await client.query(
          `UPDATE staff_accounts SET full_name=$2, role=$3, active=$4, department_id=$5,
             password_hash=COALESCE($6,password_hash), auth_version=auth_version+$7, version=version+1, updated_at=now()
           WHERE id=$1`,
          [current.id, input.fullName ?? current.fullName, input.role ?? current.role, input.active ?? current.active,
            input.departmentId === undefined ? current.departmentId : input.departmentId, passwordHash, revoke ? 1 : 0]
        );
        const record = await loadStaff(client, current.id);
        await appendAudit(client, {
          actor: req.admin, action: "staff.update", entityType: "staff", entityId: record.id, before, after: record,
          metadata: { sessionsRevoked: revoke, changedFields: Object.keys(input).filter((key) => key !== "version") }
        });
        return record;
      });
      res.json({ staff });
    } catch (error) { handleError(error, res, next); }
  });

  router.get("/departments", requirePermission("staff.read"), async (req, res, next) => {
    try {
      const active = String(req.query.active || "");
      if (active && !["true", "false"].includes(active)) throw problem(400, "Bộ lọc phòng ban chưa hợp lệ.");
      const result = await pool.query(`SELECT ${departmentColumns} FROM departments WHERE ($1::text='' OR active=($1='true')) ORDER BY name, id`, [active]);
      res.json({ departments: result.rows });
    } catch (error) { handleError(error, res, next); }
  });

  router.post("/departments", requirePermission("staff.write"), requireCsrf, async (req, res, next) => {
    try {
      const parsed = departmentCreateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Thông tin phòng ban chưa hợp lệ.", details: parsed.error.issues });
      const input = parsed.data;
      const department = await withTransaction(pool, async (client) => {
        const result = await client.query(
          `INSERT INTO departments (code, name, active) VALUES ($1,$2,$3) RETURNING ${departmentColumns}`,
          [input.code, input.name, input.active]
        );
        const record = result.rows[0];
        await appendAudit(client, { actor: req.admin, action: "department.create", entityType: "department", entityId: record.id, after: record });
        return record;
      });
      res.status(201).json({ department });
    } catch (error) { handleError(error, res, next); }
  });

  router.patch("/departments/:id", requirePermission("staff.write"), requireId, requireCsrf, async (req, res, next) => {
    try {
      const parsed = departmentUpdateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Cập nhật phòng ban chưa hợp lệ. Gửi phiên bản hiện tại của bản ghi.", details: parsed.error.issues });
      const input = parsed.data;
      const department = await withTransaction(pool, async (client) => {
        const locked = await client.query(`SELECT ${departmentColumns} FROM departments WHERE id=$1 FOR UPDATE`, [req.params.id]);
        const current = locked.rows[0];
        if (!current) throw problem(404, "Không tìm thấy phòng ban.");
        if (current.version !== input.version) throw problem(409, "Phòng ban đã thay đổi. Tải lại trước khi lưu.");
        const result = await client.query(
          `UPDATE departments SET code=$2, name=$3, active=$4, version=version+1, updated_at=now()
           WHERE id=$1 RETURNING ${departmentColumns}`,
          [current.id, input.code ?? current.code, input.name ?? current.name, input.active ?? current.active]
        );
        const record = result.rows[0];
        await appendAudit(client, { actor: req.admin, action: "department.update", entityType: "department", entityId: record.id, before: current, after: record });
        return record;
      });
      res.json({ department });
    } catch (error) { handleError(error, res, next); }
  });

  router.get("/audit-logs", requirePermission("audit.read"), async (req, res, next) => {
    try {
      const { page, pageSize } = listQuery(req.query);
      const action = String(req.query.action || "");
      const entityType = String(req.query.entityType || "");
      const entityId = String(req.query.entityId || "");
      const actorId = String(req.query.actorId || "");
      const from = String(req.query.from || "");
      const to = String(req.query.to || "");
      if (action.length > 100 || entityType.length > 80 || entityId.length > 160 || (actorId && !z.string().uuid().safeParse(actorId).success)) throw problem(400, "Bộ lọc nhật ký chưa hợp lệ.");
      const fromBoundary = auditDateBoundary(from);
      const toExclusive = /^\d{4}-\d{2}-\d{2}$/.test(to);
      const toBoundary = auditDateBoundary(to, toExclusive);
      if (fromBoundary && toBoundary && (toExclusive ? fromBoundary >= toBoundary : fromBoundary > toBoundary)) throw problem(400, "Khoảng ngày lọc nhật ký chưa hợp lệ.");
      const values = [action, entityType, entityId, actorId || null, fromBoundary, toBoundary];
      const where = `($1::text='' OR action=$1) AND ($2::text='' OR entity_type=$2) AND ($3::text='' OR entity_id=$3)
        AND ($4::uuid IS NULL OR actor_id=$4) AND ($5::timestamptz IS NULL OR created_at >= $5)
        AND ($6::timestamptz IS NULL OR created_at ${toExclusive ? "<" : "<="} $6)`;
      const count = await pool.query(`SELECT COUNT(*)::int AS total FROM audit_events WHERE ${where}`, values);
      const pagination = paginationFor(count.rows[0]?.total || 0, page, pageSize);
      const result = await pool.query(
        `SELECT id, actor_id AS "actorId", actor_username AS "actorUsername", actor_name AS "actorName",
           actor_role AS "actorRole", actor_source AS "actorSource", action, entity_type AS "entityType", entity_id AS "entityId",
           before_state AS "before", after_state AS "after", metadata, created_at AS "createdAt"
         FROM audit_events WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $7 OFFSET $8`,
        [...values, pageSize, (pagination.page - 1) * pageSize]
      );
      res.json({ events: result.rows, pagination });
    } catch (error) { handleError(error, res, next); }
  });

  return router;
}

module.exports = { createStaffApi };
