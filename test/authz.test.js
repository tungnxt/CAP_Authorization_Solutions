const cds = require('@sap/cds')
const { expect, GET, POST, PATCH } = cds.test(__dirname + '/..')

/**
 * Test case 1-8 theo doc2 mục 7.
 * Mục tiêu: chứng minh function scope + data scope thực sự enforce,
 * và enrich-user nạp đúng từ bảng (không phải từ token).
 */

const DEMO = '/odata/v4/demo-business'
const ADMIN = '/admin'

// Fixture: gán role/org vào bảng — KHÔNG gán qua token.
// Đây chính là điểm mấu chốt: quyền đến từ DB, hiệu lực tức thì.
async function seedFixture() {
  const { AppUsers, UserRoles, UserOrg, AdminFinanceRole } =
    cds.entities('cisd3.authz')

  await DELETE.from(UserOrg)
  await DELETE.from(UserRoles)
  await DELETE.from(AppUsers)

  await INSERT.into(AppUsers).entries([
    { userId: 'U-ALICE', loginName: 'alice', displayName: 'Alice', active: true },
    { userId: 'U-BOB',   loginName: 'bob',   displayName: 'Bob',   active: true },
    { userId: 'U-CAROL', loginName: 'carol', displayName: 'Carol', active: true },
    { userId: 'U-DAVE',  loginName: 'dave',  displayName: 'Dave',  active: true }
  ])

  // FIN_APP_ADMIN seed ở trạng thái DRAFT → chuyển ACTIVE để test gán.
  await UPDATE(AdminFinanceRole).set({ status: 'ACTIVE' })
    .where({ roleId: 'FIN_APP_ADMIN' })

  await INSERT.into(UserOrg).entries([
    // Case 1: Alice — GB14, chỉ 2 PC cụ thể
    { ID: cds.utils.uuid(), user_userId: 'U-ALICE',
      companyCode_code: 'GB14', profitCenter_code: '14AA' },
    { ID: cds.utils.uuid(), user_userId: 'U-ALICE',
      companyCode_code: 'GB14', profitCenter_code: '14AD' },
    // Case 2: Bob — GB14 cấp company code (PC null = toàn bộ PC)
    { ID: cds.utils.uuid(), user_userId: 'U-BOB',
      companyCode_code: 'GB14', profitCenter_code: null },
    // Case 3: Carol — đa company code
    { ID: cds.utils.uuid(), user_userId: 'U-CAROL',
      companyCode_code: 'GB14', profitCenter_code: null },
    { ID: cds.utils.uuid(), user_userId: 'U-CAROL',
      companyCode_code: 'FR16', profitCenter_code: null }
  ])

  // Case 4: chỉ Alice có role FIN_APP_ADMIN
  await INSERT.into(UserRoles).entries([
    { user_userId: 'U-ALICE', role_roleId: 'FIN_APP_ADMIN' }
  ])
  // Dave: KHÔNG có dòng nào — case 5 (default-deny)
}

beforeEach(seedFixture)

describe('Data scope (@restrict.where ← req.user.attr)', () => {

  it('case 1: user có PC cụ thể → chỉ thấy PC thuộc CC của mình', async () => {
    const { data } = await GET(`${DEMO}/MyProfitCenters`, { auth: { username: 'alice' } })
    expect(data.value.length).to.be.greaterThan(0)
    // Mọi dòng phải thuộc GB14 — không rò rỉ CC khác
    for (const pc of data.value) expect(pc.companyCode_code).to.equal('GB14')
  })

  it('case 2: user cấp-CC (PC null) → thấy TOÀN BỘ 96 PC của GB14', async () => {
    const { data } = await GET(`${DEMO}/MyProfitCenters`, { auth: { username: 'bob' } })
    expect(data.value.length).to.equal(96)
    for (const pc of data.value) expect(pc.companyCode_code).to.equal('GB14')
  })

  it('case 3: user đa-CC → thấy data của cả hai CC', async () => {
    const { data } = await GET(`${DEMO}/MyProfitCenters`, { auth: { username: 'carol' } })
    const ccs = new Set(data.value.map(p => p.companyCode_code))
    expect(ccs).to.include('GB14')
    expect(ccs).to.include('FR16')
    expect(ccs.size).to.equal(2)   // KHÔNG lọt CC thứ ba
  })

  it('case 5: user không có dòng phân quyền → không thấy gì (default-deny)', async () => {
    const { data } = await GET(`${DEMO}/MyProfitCenters`, { auth: { username: 'dave' } })
    expect(data.value.length).to.equal(0)
  })

  it('filter đẩy xuống SQL — áp cả trên $count', async () => {
    const { data } = await GET(
      `${DEMO}/MyProfitCenters/$count`, { auth: { username: 'bob' } })
    expect(Number(data)).to.equal(96)
  })
})

describe('Function scope (@requires ← req.user.roles)', () => {

  it('case 4: user có role → gọi được entity bảo vệ', async () => {
    const { data } = await GET(`${DEMO}/RestrictedData`, { auth: { username: 'alice' } })
    expect(data.value.length).to.be.greaterThan(0)
  })

  it('case 4b: user KHÔNG có role → 403', async () => {
    await expect(GET(`${DEMO}/RestrictedData`, { auth: { username: 'bob' } }))
      .to.be.rejectedWith(/403/)
  })

  it('case 6: user thường gọi AdminService → 403', async () => {
    await expect(GET(`${ADMIN}/Users`, { auth: { username: 'alice' } }))
      .to.be.rejectedWith(/403/)
  })

  it('case 6b: AppAdmin (từ token XSUAA) vào được AdminService', async () => {
    const { data } = await GET(`${ADMIN}/Roles`, { auth: { username: 'admin' } })
    expect(data.value.length).to.be.greaterThan(0)
  })
})

describe('Validation & catalog', () => {

  it('case 8: PC không thuộc CC đã gán → bị từ chối', async () => {
    // 14AA thuộc GB14, không thuộc FR16
    await expect(POST(`${ADMIN}/UserOrg`, {
      user_userId: 'U-DAVE', companyCode_code: 'FR16', profitCenter_code: '14AA'
    }, { auth: { username: 'admin' } })).to.be.rejectedWith(/GB14|không phải/)
  })

  it('role ở trạng thái DRAFT → không cho gán', async () => {
    const { AdminFinanceRole } = cds.entities('cisd3.authz')
    await UPDATE(AdminFinanceRole).set({ status: 'DRAFT' })
      .where({ roleId: 'FIN_APP_ADMIN' })
    await expect(POST(`${ADMIN}/UserRoles`, {
      user_userId: 'U-DAVE', role_roleId: 'FIN_APP_ADMIN'
    }, { auth: { username: 'admin' } })).to.be.rejectedWith(/DRAFT/)
  })

  it('gán role không tồn tại → bị từ chối', async () => {
    await expect(POST(`${ADMIN}/UserRoles`, {
      user_userId: 'U-DAVE', role_roleId: 'KHONG_TON_TAI'
    }, { auth: { username: 'admin' } })).to.be.rejectedWith(/không tồn tại/)
  })

  it('gán org cho user không tồn tại → bị từ chối', async () => {
    await expect(POST(`${ADMIN}/UserOrg`, {
      user_userId: 'U-KHONG-CO', companyCode_code: 'GB14'
    }, { auth: { username: 'admin' } })).to.be.rejectedWith(/không tồn tại/)
  })

  it('gán trùng org → 409', async () => {
    await expect(POST(`${ADMIN}/UserOrg`, {
      user_userId: 'U-BOB', companyCode_code: 'GB14', profitCenter_code: null
    }, { auth: { username: 'admin' } })).to.be.rejectedWith(/409|Đã tồn tại/)
  })
})

describe('Audit & kill switch', () => {

  it('gán role → ghi ChangeLog', async () => {
    await POST(`${ADMIN}/UserRoles`, {
      user_userId: 'U-DAVE', role_roleId: 'FIN_APP_ADMIN'
    }, { auth: { username: 'admin' } })
    const { ChangeLog } = cds.entities('cisd3.authz')
    const log = await SELECT.one.from(ChangeLog)
      .where({ targetUser: 'U-DAVE', action: 'GRANT_ROLE' })
    expect(log).to.exist
    expect(log.detail).to.contain('FIN_APP_ADMIN')
  })

  it('tắt kill switch KHÔNG kèm lý do → bị từ chối', async () => {
    await expect(PATCH(`${ADMIN}/Config(1)`, {
      appManagedAuthz: false
    }, { auth: { username: 'admin' } })).to.be.rejectedWith(/lý do|lastChangedNote/)
  })

  it('tắt kill switch → role từ bảng NGỪNG hiệu lực, về BTP native', async () => {
    // Trước khi tắt: Bob thấy 96 PC
    let res = await GET(`${DEMO}/MyProfitCenters`, { auth: { username: 'bob' } })
    expect(res.data.value.length).to.equal(96)

    await PATCH(`${ADMIN}/Config(1)`, {
      appManagedAuthz: false,
      lastChangedNote: 'Test: chuyển sang phân quyền BTP'
    }, { auth: { username: 'admin' } })

    // Sau khi tắt: không nạp attr từ bảng ⇒ không thấy gì
    res = await GET(`${DEMO}/MyProfitCenters`, { auth: { username: 'bob' } })
    expect(res.data.value.length).to.equal(0)

    // Khôi phục
    await PATCH(`${ADMIN}/Config(1)`, {
      appManagedAuthz: true, lastChangedNote: 'Khôi phục'
    }, { auth: { username: 'admin' } })
  })
})

describe('Master data (seed từ S/4)', () => {

  it('87 company code, 471 profit center, GB14 có 96 PC', async () => {
    const { CompanyCodes, ProfitCenters } = cds.entities('cisd3.authz')
    expect((await SELECT.from(CompanyCodes)).length).to.equal(87)
    expect((await SELECT.from(ProfitCenters)).length).to.equal(471)
    expect((await SELECT.from(ProfitCenters)
      .where({ companyCode_code: 'GB14' })).length).to.equal(96)
  })

  it('không PC nào mồ côi (mọi PC đều có company code hợp lệ)', async () => {
    const { ProfitCenters, CompanyCodes } = cds.entities('cisd3.authz')
    const pcs = await SELECT.from(ProfitCenters)
    const ccs = new Set((await SELECT.from(CompanyCodes)).map(c => c.code))
    const orphans = pcs.filter(p => !p.companyCode_code || !ccs.has(p.companyCode_code))
    expect(orphans.map(o => o.code)).to.deep.equal([])
  })
})
