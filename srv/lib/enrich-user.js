const cds = require('@sap/cds')

const log = cds.log('authz')

/**
 * Nạp function scope (roles) + data scope (org) vào req.user từ bảng DB.
 *
 * VÌ SAO CẦN: CAP enforce quyền bằng @requires/@restrict, đọc từ req.user —
 * mà req.user vốn dựng từ token XSUAA (role gán tay ở BTP Cockpit).
 * Middleware này đổi NGUỒN dữ liệu sang bảng DB (admin sửa qua Fiori, hiệu lực
 * tức thì) mà GIỮ NGUYÊN cơ chế enforce chuẩn của CAP.
 *
 * Đăng ký SAU auth() (cần u.id đã xác thực) và TRƯỚC dispatch (trước @restrict).
 *
 * FAIL-CLOSED: mọi lỗi ⇒ không cấp thêm quyền, KHÔNG next(err).
 * Lỗi tra quyền không được biến thành "user có quyền".
 */
module.exports = function enrichUser() {
  return async function (_req, _res, next) {
    const u = cds.context?.user
    if (!u?.id || u.id === 'anonymous') return next()

    try {
      const db = await cds.connect.to('db')

      // Kill switch: false ⇒ no-op, req.user giữ nguyên từ token XSUAA
      // ⇒ nhảy hẳn về phân quyền chuẩn SAP BTP.
      if (!(await isAppManaged(db))) return next()

      const { UserRoles, UserOrg } = cds.entities('cisd3.authz')

      // ── FUNCTION SCOPE ────────────────────────────────────────────────────
      // KHÔNG gán u.roles = {} — sẽ xoá mất AppAdmin bootstrap từ token XSUAA
      // và tự khoá mình ra khỏi AdminService. Chỉ THÊM vào.
      const roles = await db.run(
        SELECT.from(UserRoles).columns('role_roleId').where({ user_userId: u.id })
      )
      for (const r of roles) u.roles[r.role_roleId] = 1

      // ── DATA SCOPE ────────────────────────────────────────────────────────
      const orgs = await db.run(
        SELECT.from(UserOrg)
          .columns('companyCode_code as cc', 'profitCenter_code as pc')
          .where({ user_userId: u.id })
      )
      u.attr.CompanyCode = [...new Set(orgs.map(o => o.cc).filter(Boolean))]
      // pc rỗng ⇒ user có TOÀN BỘ profit center của các CC đó.
      u.attr.ProfitCenter = [...new Set(orgs.map(o => o.pc).filter(Boolean))]

      log.debug('enriched', u.id, {
        roles: Object.keys(u.roles),
        cc: u.attr.CompanyCode,
        pc: u.attr.ProfitCenter
      })
    } catch (e) {
      // FAIL-CLOSED: giữ nguyên quyền đã có từ token, không cấp thêm.
      log.error('enrich failed — fail-closed, no extra privileges granted', e)
    }
    next()
  }
}

/**
 * Đọc kill switch. Cache in-memory để không query mỗi request.
 * TTL ngắn: admin tắt cờ qua Fiori thì có hiệu lực trong vòng CACHE_TTL_MS.
 * Handler của AuthzConfig gọi invalidate() để áp dụng tức thì.
 */
const CACHE_TTL_MS = 30_000
let cache = { value: null, at: 0 }

async function isAppManaged(db) {
  const now = Date.now()
  if (cache.value !== null && now - cache.at < CACHE_TTL_MS) return cache.value

  const { AuthzConfig } = cds.entities('cisd3.authz')
  const cfg = await db.run(SELECT.one.from(AuthzConfig).where({ ID: 1 }))
  // Chưa có dòng config ⇒ mặc định app-managed (chế độ vận hành bình thường).
  const value = cfg ? !!cfg.appManagedAuthz : true
  cache = { value, at: now }
  return value
}

module.exports.invalidate = () => {
  cache = { value: null, at: 0 }
}
