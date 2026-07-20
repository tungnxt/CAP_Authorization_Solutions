# Task 3 — Design & Build Spec: App "Manage-Role" (App-managed AuthZ)

**Dự án:** CISD3 · **Runtime:** CAP **Node.js** · **DB:** SAP HANA Cloud (dev: SQLite) · **UI:** SAP Fiori elements
**Vai trò tài liệu:** đây là **spec để build**. Dùng cho team dev review và cho công cụ sinh code (Claude Code) dựng app.
**Bối cảnh & lý do chọn mô hình:** xem **doc1** `Task3_Solutions_FunctionScope_DataScope.md`.
**Cách app khác đấu nối vào app này:** xem **doc3** `Task3_Integration_App_ManageRole_ToOtherApp.md`.
**Ngày:** 2026-07-20

> **Một câu:** App CAP này là **nguồn sự thật phân quyền**. Nó lưu *role* (function scope) và *org* (data scope) của từng user trong bảng riêng, cung cấp **màn hình quản trị** + **API** cho app khác, và tự enforce quyền bằng annotation CAP chuẩn nhờ middleware nạp `req.user.roles` + `req.user.attr` từ bảng.

---

## 0. Nguyên tắc bất biến (đọc trước khi code)

1. **Enforce khai báo (declarative).** Giữ `@requires` / `@restrict.to` / `@restrict.where`. Không viết logic lọc quyền rải rác trong handler nghiệp vụ.
2. **`req.user` là điểm bơm duy nhất.** Chỉ *một* middleware sau `auth()` nạp roles + attr. Không nơi nào khác sửa `req.user`.
3. **Default-deny.** Không có dòng phân quyền ⇒ không role, không thấy data.
4. **Khoá user = IAS user id ổn định (`sub`/UUID).** Tuyệt đối không dùng email làm khoá.
5. **Tách design-time vs run-time.** *Loại* role và *cái* nó bảo vệ = code (dev, cần deploy). *Ai* có role/org = dữ liệu (admin, tức thì).
6. **AdminService phải được bảo vệ bằng role `AppAdmin`.** Nếu hở, user tự nâng quyền.

---

## 1. Kiến trúc & cấu trúc project

```
manage-role/
├─ db/
│  ├─ schema.cds            # data model AuthZ (mục 2)
│  └─ data/                 # seed CSV (CompanyCodes, ProfitCenters, AppRoles)
├─ srv/
│  ├─ admin-service.cds     # AdminService: CRUD phân quyền + import user
│  ├─ admin-service.js      # handlers: importUsers, audit, validation
│  ├─ authz-api.cds         # AuthzService: API cho app khác (chi tiết ở doc3)
│  ├─ authz-api.js          # tính effective roles/org
│  ├─ lib/enrich-user.js    # middleware nạp req.user (mục 3) — tái dùng được
│  └─ server.js             # đăng ký middleware
├─ app/                     # Fiori elements (mục 6)
├─ test/                    # mục 7
├─ package.json             # cds.requires: auth(ias), db(hana), ias destination
├─ mta.yaml                 # deploy BTP
└─ xs-security.json         # chỉ scope AppAdmin bootstrap (mục 5)
```

Thành phần runtime:
```
auth (XSUAA/IAS) ─► [middleware enrich-user] ─► service dispatch
                         │ đọc bảng UserRoles → req.user.roles
                         │ đọc bảng UserOrg  → req.user.attr
                         ▼
     AdminService (@requires AppAdmin) · AuthzService (API) · Business entities
```

---

## 2. Data model (`db/schema.cds`)

```cds
namespace cisd3.authz;
using { managed, cuid } from '@sap/cds/common';

// 2.1 Cache user từ IAS. Khoá = IAS user id ổn định.
entity AppUsers : managed {
  key userId   : String(64);          // IAS UUID / token sub
  loginName    : String(120);
  email        : String(255);
  displayName  : String(255);
  active       : Boolean default true;
  roles        : Composition of many UserRoles on roles.user = $self;
  orgs         : Composition of many UserOrg   on orgs.user  = $self;
}

// 2.2 Catalog role chức năng. code = tên dùng trong @requires của mọi app.
entity AppRoles : managed {
  key code     : String(64);          // 'Approve_PR', 'Instructor', 'AppAdmin'
  appName      : String(64);          // 'UploadLOB' | 'ManageRole' | ...
  description  : String(255);
}

// 2.3 FUNCTION SCOPE — gán role cho user
entity UserRoles : managed {
  key user     : Association to AppUsers;
  key role     : Association to AppRoles;
  validFrom    : Date default $now;
  validTo      : Date;                // null = vô thời hạn
}

// 2.4 Catalog org
entity CompanyCodes : managed {
  key code     : String(4);           // 'GB14'
  name         : String(120);
  profitCenters: Composition of many ProfitCenters on profitCenters.companyCode = $self;
}
entity ProfitCenters : managed {
  key code     : String(4);           // '14AA'
  companyCode  : Association to CompanyCodes;   // prefix rule: '14xx' → GB14
  name         : String(120);
}

// 2.5 DATA SCOPE — gán org cho user. profitCenter NULL = toàn bộ PC của CC.
entity UserOrg : managed {
  key user         : Association to AppUsers;
  key companyCode  : Association to CompanyCodes;
  key profitCenter : Association to ProfitCenters null;
}

// 2.6 Audit
entity ChangeLog : cuid, managed {
  targetUser : String(64);
  action     : String(24);            // GRANT_ROLE / REVOKE_ROLE / ADD_ORG / REMOVE_ORG / IMPORT
  detail     : String(500);
  actor      : String(64);            // ai thực hiện
}
```

**Ràng buộc dữ liệu cần enforce (handler/validation):**
- `ProfitCenters.code[0:2]` phải khớp số của `companyCode.code` (prefix rule). Từ chối seed sai.
- `UserOrg.profitCenter` nếu có, phải thuộc đúng `companyCode` đã gán.
- Không cho tạo `UserRoles`/`UserOrg` trỏ tới `AppUsers` không tồn tại/không active.

---

## 3. Middleware nạp `req.user` (`srv/lib/enrich-user.js`)

```js
const cds = require('@sap/cds')

// Tái sử dụng được cho app khác (doc3): chỉ đổi nguồn dữ liệu (DB local vs API)
module.exports = function enrichUser () {
  return async function (_req, _res, next) {
    const u = cds.context?.user
    if (u && u.id) {
      try {
        const db = await cds.connect.to('db')
        const now = new Date().toISOString().slice(0,10)
        // FUNCTION SCOPE
        const roles = await db.run(
          SELECT.from('cisd3.authz.UserRoles')
            .columns('role_code')
            .where({ user_userId: u.id })
            .and(`(validTo is null or validTo >= '${now}')`))
        for (const r of roles) u.roles[r.role_code] = 1
        // DATA SCOPE
        const orgs = await db.run(
          SELECT.from('cisd3.authz.UserOrg')
            .columns('companyCode_code as cc', 'profitCenter_code as pc')
            .where({ user_userId: u.id }))
        u.attr.CompanyCode  = [...new Set(orgs.map(o => o.cc))]
        u.attr.ProfitCenter = orgs.filter(o => o.pc).map(o => o.pc)
      } catch (e) {
        // FAIL-CLOSED: lỗi tra quyền ⇒ không cấp thêm gì (giữ default-deny)
        cds.log('authz').error('enrich failed', e)
      }
    }
    next()
  }
}
```
```js
// srv/server.js
const cds = require('@sap/cds')
const enrichUser = require('./lib/enrich-user')
cds.middlewares.add(enrichUser(), { after: 'auth' })   // SAU auth, TRƯỚC dispatch
```

> `@requires`/`@restrict.to` đọc `u.roles` (qua `user.is()`); `@restrict.where` đọc `u.attr`. Runtime dịch `where` thành filter SQL (READ) + validate (CREATE/UPDATE).

---

## 4. Services

### 4.1 Business entity — annotation mẫu (`srv` của app nghiệp vụ)
```cds
service UploadLOBService @(requires: 'authenticated-user') {
  entity CompanyData @(restrict: [
    { grant: '*',              to: 'AppAdmin' },
    { grant: ['READ','WRITE'], where: 'CompanyCode = $user.CompanyCode
                                    and (ProfitCenter = $user.ProfitCenter
                                         or $user.ProfitCenter is null)' }
  ]) as projection on db.CompanyData;

  entity Approvals @(requires: 'Approve_PR') as projection on db.Approvals;
}
```

### 4.2 AdminService (`srv/admin-service.cds`)
```cds
using cisd3.authz as az from '../db/schema';
service AdminService @(requires: 'AppAdmin') {
  entity Users        as projection on az.AppUsers;
  entity Roles        as projection on az.AppRoles;
  entity UserRoles    as projection on az.UserRoles;
  entity CompanyCodes as projection on az.CompanyCodes;
  entity ProfitCenters as projection on az.ProfitCenters;
  entity UserOrg      as projection on az.UserOrg;
  @readonly entity ChangeLog as projection on az.ChangeLog;

  action importUsers() returns { imported: Integer };
}
```
Handlers (`admin-service.js`): thực thi validation mục 2, ghi `ChangeLog` cho mọi thay đổi, và `importUsers` (mục 5.2). Invalidate cache (mục 8) sau mỗi thay đổi quyền.

### 4.3 AuthzService (API cho app khác)
- Định nghĩa & hợp đồng chi tiết ở **doc3**. Tóm tắt: expose *effective* roles + org của một user cho các app tiêu thụ.

---

## 5. Bootstrap admin & `xs-security.json`

Bài toán con gà–quả trứng: admin gốc chưa có dòng trong bảng ⇒ không vào được AdminService.

- `xs-security.json` chỉ khai **một** scope/role-template `AppAdmin`:
```json
{
  "xsappname": "manage-role",
  "scopes":          [{ "name": "$XSAPPNAME.AppAdmin" }],
  "role-templates":  [{ "name": "AppAdmin", "scope-references": ["$XSAPPNAME.AppAdmin"] }],
  "role-collections":[{ "name": "AppAdmin", "role-template-references": ["$XSAPPNAME.AppAdmin"] }]
}
```
- BTP Admin gán Role Collection `AppAdmin` cho 1–2 người gốc (mapping DUY NHẤT còn ở BTP).
- Middleware bổ sung: nếu token đã mang scope `AppAdmin` (từ bootstrap) thì cũng set `u.roles.AppAdmin = 1`. Từ đó admin gốc quản mọi role/org khác qua UI.

### 5.2 Import user từ IAS (SCIM)
- API: `GET https://as8a3pb0k.accounts.ondemand.com/scim/Users` — **tối đa 100 bản ghi/lần**, lặp `startIndex`/`count`.
- Auth: OAuth2 client credentials (API client trong IAS, quyền Read Users) — cấu hình qua destination `ias`.
- Map `id`→`userId`, `userName`→`loginName`, `emails[0].value`→`email`, `displayName`, `active`. Chỉ cập nhật cache danh tính, **không** đụng phân quyền.
```js
this.on('importUsers', async () => {
  const ias = await cds.connect.to('ias'); let start=1, total=Infinity, n=0
  while (start <= total) {
    const page = await ias.get(`/scim/Users?startIndex=${start}&count=100`)
    total = page.totalResults
    await UPSERT.into('cisd3.authz.AppUsers').entries(page.Resources.map(u => ({
      userId:u.id, loginName:u.userName, email:u.emails?.[0]?.value,
      displayName:u.displayName, active:u.active })))
    n += page.Resources.length; start += 100
  }
  return { imported: n }
})
```

---

## 6. Fiori elements (UI quản trị)

- **Users** (List Report + Object Page): tìm kiếm; nút *Import from IAS*; Object Page có 2 section:
  - *Roles*: thêm/xoá `AppRoles` cho user.
  - *Org*: thêm/xoá Company Code; với mỗi CC chọn Profit Center cụ thể **hoặc** để trống = "toàn bộ PC".
- **Roles / CompanyCodes / ProfitCenters**: quản catalog (List Report).
- **ChangeLog**: read-only, xem lịch sử.
- Toàn bộ dưới `AdminService` ⇒ `@requires: 'AppAdmin'`.

---

## 7. Testing (bắt buộc trước nghiệm thu)

Case tối thiểu (data scope + function scope):

| # | Tình huống | Kỳ vọng |
|---|---|---|
| 1 | User GB14, PC `14AA,14AD` | Chỉ thấy CC=GB14 ∧ PC∈{14AA,14AD} |
| 2 | User GB14 chỉ-CC (UserOrg.pc=null) | Thấy mọi PC của GB14 |
| 3 | User đa-CC (GB14+FR16) | Thấy dữ liệu cả hai |
| 4 | User có role `Approve_PR` | Gọi được `Approvals`; user khác → 403 |
| 5 | User không có dòng phân quyền | Không role, không data (default-deny) |
| 6 | User thường gọi AdminService | 403 (chỉ `AppAdmin`) |
| 7 | Catalog check | Mọi tên trong `@requires` phải tồn tại trong `AppRoles` |
| 8 | Prefix rule | Seed ProfitCenter sai prefix → bị từ chối |

- Local dev dùng **mock auth** (`cds.requires.auth.users`) để giả lập user có/không role, có/không org.
- Test tự động (`cds.test`) cho các case 1–8; đặc biệt kiểm tra filter **đẩy xuống SQL** và áp cả trên `$count`/expand.

---

## 8. Phi chức năng

- **Cache** effective roles/org theo `userId` (in-memory nếu 1 instance; Redis nếu scale nhiều instance). **Invalidate** khi AdminService đổi quyền của user đó. TTL an toàn (vd 5–15 phút).
- **Fail-closed:** lỗi khi tra quyền ⇒ không cấp thêm quyền.
- **Audit:** mọi thay đổi vào `ChangeLog` (actor, target, action, detail).
- **Bảo mật khoá:** validate `u.id` là từ token đã xác thực (không nhận từ input).

---

## 9. Seed & Rollout GB14

1. Seed `CompanyCodes` (16 mã) + `ProfitCenters` (91 mã `14xx` cho GB14) từ bảng SPRO/`User_Org_Mapping`.
2. Seed `AppRoles` (role của UploadLOB + `AppAdmin`).
3. `importUsers()` từ IAS.
4. Nạp `UserOrg` cho 76 user GB14 (user cấp-CC để trống PC; user subset điền PC) từ `User_Org_Mapping.xlsx`.
5. Gán `UserRoles` theo nghiệp vụ.
6. Gán `AppAdmin` bootstrap ở BTP cho admin gốc.
7. Chạy test case 1–8.
8. **Adapt CC khác:** chỉ thêm seed CompanyCode/ProfitCenter + nạp UserOrg — **không đụng code**.

---

## 10. Quyết định còn mở (chốt trước khi build)

1. Bật `validFrom/validTo` (hiệu lực theo thời gian) ở v1 hay để sau?
2. Cache: in-memory hay Redis (phụ thuộc số instance khi deploy)?
3. `AppRoles` catalog: đồng bộ tay hay sinh tự động từ annotation lúc build (test 7)?
4. App này phục vụ nhiều app ngay từ v1 (bật AuthzService — doc3) hay chỉ UploadLOB trước?

---

## 11. Liên kết tài liệu
- **doc1** `Task3_Solutions_FunctionScope_DataScope.md` — solution & lý do chọn mô hình.
- **doc2 (tài liệu này)** — thiết kế & spec build App Manage-Role.
- **doc3** `Task3_Integration_App_ManageRole_ToOtherApp.md` — API & cách app khác cross-check.

> **Ghi chú kỹ thuật (đã đối chiếu tài liệu CAP/SAP):** nạp `req.user.roles`/`attr` qua middleware sau `auth()` (Custom Authentication / Customizing Users / `cds.middlewares`); `@requires`/`@restrict.where` cú pháp CAP chuẩn; SCIM `GET /scim/Users` phân trang tối đa 100 (Identity Directory API). Tên cột trong snippet SELECT cần khớp tên do CDS sinh khi build thực tế (vd `role_code`, `user_userId`).
