const cds = require('@sap/cds')
const enrichUser = require('./lib/enrich-user')

const log = cds.log('authz')

module.exports = class AdminService extends cds.ApplicationService {
  async init() {
    const { AppUsers, AdminFinanceRole, CompanyCodes, ProfitCenters,
            UserRoles, UserOrg, ChangeLog, AuthzConfig } =
      cds.entities('cisd3.authz')

    const audit = (req, action, targetUser, detail) =>
      INSERT.into(ChangeLog).entries({
        targetUser, action, detail, actor: req.user.id
      })

    // ── UserRoles: validate + audit ──────────────────────────────────────────
    this.before('CREATE', 'UserRoles', async req => {
      const { user_userId, role_roleId } = req.data
      if (!user_userId || !role_roleId)
        return req.reject(400, 'user và role là bắt buộc')

      const u = await SELECT.one.from(AppUsers).where({ userId: user_userId })
      if (!u) return req.reject(400, `User không tồn tại: ${user_userId}`)
      if (!u.active) return req.reject(400, `User không active: ${user_userId}`)

      const r = await SELECT.one.from(AdminFinanceRole)
        .where({ roleId: role_roleId })
      if (!r) return req.reject(400, `Role không tồn tại: ${role_roleId}`)
      // status chỉ chặn GÁN MỚI. Không chi phối enforcement của gán cũ.
      if (r.status !== 'ACTIVE')
        return req.reject(400,
          `Role ${role_roleId} đang ở trạng thái ${r.status}, chưa cho gán. ` +
          `Chuyển sang ACTIVE trước.`)

      const dup = await SELECT.one.from(UserRoles)
        .where({ user_userId, role_roleId })
      if (dup) return req.reject(409, `User đã có role ${role_roleId}`)
    })

    this.after('CREATE', 'UserRoles', async (data, req) => {
      await audit(req, 'GRANT_ROLE', data.user_userId, `role=${data.role_roleId}`)
    })

    this.after('DELETE', 'UserRoles', async (_, req) => {
      const k = req.params?.[0] ?? {}
      await audit(req, 'REVOKE_ROLE', k.user_userId, `role=${k.role_roleId}`)
    })

    // ── UserOrg: validate prefix rule + audit ────────────────────────────────
    this.before(['CREATE', 'UPDATE'], 'UserOrg', async req => {
      const { user_userId, companyCode_code, profitCenter_code } = req.data
      if (!user_userId || !companyCode_code)
        return req.reject(400, 'user và companyCode là bắt buộc')

      const u = await SELECT.one.from(AppUsers).where({ userId: user_userId })
      if (!u) return req.reject(400, `User không tồn tại: ${user_userId}`)
      if (!u.active) return req.reject(400, `User không active: ${user_userId}`)

      const cc = await SELECT.one.from(CompanyCodes)
        .where({ code: companyCode_code })
      if (!cc) return req.reject(400, `Company code không tồn tại: ${companyCode_code}`)

      // profitCenter NULL = toàn bộ PC của CC ⇒ hợp lệ, không cần kiểm thêm.
      if (profitCenter_code) {
        const pc = await SELECT.one.from(ProfitCenters)
          .where({ code: profitCenter_code })
        if (!pc)
          return req.reject(400, `Profit center không tồn tại: ${profitCenter_code}`)
        // PC phải thuộc đúng CC đã gán — nếu không, user thấy data của CC khác.
        if (pc.companyCode_code !== companyCode_code)
          return req.reject(400,
            `Profit center ${profitCenter_code} thuộc company code ` +
            `${pc.companyCode_code || '(chưa gán)'}, không phải ${companyCode_code}`)
      }

      // Chặn trùng: cùng user + CC + PC (kể cả PC null) — không có unique
      // constraint ở DB vì key là cuid.
      const where = { user_userId, companyCode_code }
      where.profitCenter_code = profitCenter_code || null
      const dup = await SELECT.one.from(UserOrg).where(where)
      if (dup && dup.ID !== req.data.ID)
        return req.reject(409,
          `Đã tồn tại phân quyền org này cho user (CC=${companyCode_code}` +
          `${profitCenter_code ? `, PC=${profitCenter_code}` : ', toàn bộ PC'})`)
    })

    this.after('CREATE', 'UserOrg', async (data, req) => {
      await audit(req, 'ADD_ORG', data.user_userId,
        `CC=${data.companyCode_code} PC=${data.profitCenter_code || '(toàn bộ)'}`)
    })

    // ── Kill switch: BẮT BUỘC confirm khi tắt ────────────────────────────────
    // Đây là thao tác ảnh hưởng TOÀN HỆ THỐNG: mọi user mất role từ bảng này.
    this.before('UPDATE', 'Config', async req => {
      const cur = await SELECT.one.from(AuthzConfig).where({ ID: req.data.ID ?? 1 })
      const turningOff = cur?.appManagedAuthz && req.data.appManagedAuthz === false
      if (!turningOff) return

      // Bắt nhập lý do — ép người tắt phải dừng lại và suy nghĩ.
      if (!req.data.lastChangedNote?.trim())
        return req.reject(400,
          'Phải nhập lý do (lastChangedNote) khi tắt chế độ app-managed.')

      // Đếm thiệt hại để hiện trong cảnh báo — con số thật, không nói chung chung.
      const [roleCount, orgCount] = await Promise.all([
        SELECT.one`count(*) as n`.from(UserRoles),
        SELECT.one`count(*) as n`.from(UserOrg)
      ])
      req.warn(200,
        `⚠ CẢNH BÁO QUAN TRỌNG — tắt chế độ app-managed authorization:\n` +
        `• ${roleCount.n} dòng phân quyền role và ${orgCount.n} dòng phân quyền org ` +
        `trong bảng này sẽ NGỪNG có hiệu lực ngay lập tức.\n` +
        `• Quyền sẽ CHỈ đến từ BTP Role Collection (XSUAA token).\n` +
        `• Nếu xs-security.json chưa khai đủ scope/role-template cho mọi role, ` +
        `TOÀN BỘ user sẽ mất quyền và không truy cập được app.\n` +
        `• Data scope (@restrict.where theo CompanyCode/ProfitCenter) sẽ không ` +
        `còn được nạp ⇒ các app tiêu thụ có thể không lọc được dữ liệu.\n` +
        `Chỉ tắt khi đã chuẩn bị xong phân quyền phía BTP.`)
    })

    this.after('UPDATE', 'Config', async (data, req) => {
      enrichUser.invalidate()   // áp dụng tức thì, không chờ cache TTL
      await audit(req, 'AUTHZ_MODE_CHANGED', '(system)',
        `appManagedAuthz=${data.appManagedAuthz} — ${data.lastChangedNote || ''}`)
      log.warn('AUTHZ MODE CHANGED', {
        appManagedAuthz: data.appManagedAuthz, actor: req.user.id
      })
    })

    // ── Import user từ IAS (SCIM) ────────────────────────────────────────────
    this.on('importUsers', async req => {
      let ias
      try {
        ias = await cds.connect.to('ias')
      } catch {
        return req.reject(501,
          'Destination "ias" chưa cấu hình. Cần OAuth2 client credentials ' +
          '(IAS API client, quyền Read Users).')
      }

      let start = 1, total = Infinity, imported = 0
      const PAGE = 100   // SCIM giới hạn 100 bản ghi/lần
      while (start <= total) {
        const page = await ias.get(`/scim/Users?startIndex=${start}&count=${PAGE}`)
        total = page.totalResults ?? 0
        const rows = (page.Resources ?? []).map(u => ({
          userId: u.id,
          loginName: u.userName,
          email: u.emails?.[0]?.value,
          displayName: u.displayName,
          active: u.active !== false
        }))
        if (rows.length) await UPSERT.into(AppUsers).entries(rows)
        imported += rows.length
        if (!rows.length) break
        start += PAGE
      }

      await audit(req, 'IMPORT_USERS', '(bulk)', `imported=${imported}`)
      return { imported }
    })

    return super.init()
  }
}
