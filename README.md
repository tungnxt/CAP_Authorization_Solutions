# Manage-Role — App-managed Authorization

Nguồn sự thật phân quyền cho các app CAP (CISD3): lưu **function scope** (role) và
**data scope** (company code / profit center) trong bảng, cung cấp màn hình quản trị
Fiori, và enforce bằng annotation CAP chuẩn nhờ middleware nạp `req.user`.

## Chạy local

```bash
npm install
npm test                  # 19 test — case 1-8 của doc2 mục 7
npx cds watch             # backend: http://localhost:4004/admin

# UI Fiori (terminal thứ hai)
cd app/managerole && npm install && npx ui5 serve --open index.html
```

## Deploy lên BTP (html5-repo) — ✅ đã chạy thật

App **đã deploy thành công** lên Cloud Foundry và truy cập được qua approuter.
Cấu trúc theo đúng mẫu `CAP_LOB`.

```bash
npm install
cd app/managerole && npm install && cd ../..
npm run build             # mbt build → mta_archives/archive.mtar
npm run deploy            # cf deploy
```

Sau khi deploy, gán Role Collection **`ManageRole_AppAdmin`** ở BTP Cockpit cho
1–2 admin gốc (mapping DUY NHẤT còn ở BTP — xem phần bootstrap bên dưới).

**Thành phần được tạo:**

| Module | Loại | Vai trò |
|---|---|---|
| `manage-role-srv` | nodejs | CAP backend, expose `/admin` |
| `manage-role-db-deployer` | hdb | Deploy HDI container |
| `manage-role-approuter` | approuter.nodejs | Vào app, xác thực XSUAA |
| `managerole` | html5 | UI5 app → zip → html5-repo |
| `manage-role-app-content` | application.content | Đẩy zip lên app-host |
| `manage-role-destination-content` | application.content | Nối destination |

| Resource | Service |
|---|---|
| `manage-role-auth` | xsuaa (application) |
| `manage-role-db` | hana (hdi-shared) |
| `manage-role-html5-repo-host` | html5-apps-repo (app-host) |
| `manage-role-html5-repo-runtime` | html5-apps-repo (app-runtime) |
| `manage-role-destination` | destination (lite) |

Local dùng **mock auth** (`package.json` → `cds.requires.auth.users`):

| User | Quyền | Dùng để test |
|---|---|---|
| `admin` | `AppAdmin` (từ "token") | Vào AdminService |
| `alice` | PC cụ thể 14AA, 14AD + role FIN_APP_ADMIN | Case 1, 4 |
| `bob` | GB14 cấp-CC (toàn bộ 96 PC) | Case 2 |
| `carol` | GB14 + FR16 | Case 3 |
| `dave` | Không có gì | Case 5 (default-deny) |

> Fixture role/org nằm trong `test/authz.test.js`. Chạy `cds watch` thì bảng
> `AppUsers`/`UserRoles`/`UserOrg` rỗng — seed qua AdminService hoặc `importUsers()`.

## Cơ chế (đọc trước khi sửa code)

```
Token (chỉ danh tính, KHÔNG có quyền)
  ↓ auth()            → req.user.id
  ↓ [enrich-user]     → đọc bảng, bơm u.roles + u.attr    ← srv/lib/enrich-user.js
  ↓ dispatch          → @requires / @restrict.where
  ↓ SQL               → WHERE companyCode_code = 'GB14'
```

CAP không phân biệt quyền đến từ token hay từ DB. Nên giữ nguyên cơ chế enforce
chuẩn, chỉ **đổi nguồn dữ liệu** → admin sửa qua Fiori, hiệu lực tức thì,
không cần deploy, không cần vào BTP Cockpit.

**Bất biến:**
1. Chỉ `UserRoles` quyết định "user có role gì"; chỉ `UserOrg` quyết định "thấy data nào".
   Mọi bảng/cột khác là metadata cho con người.
2. `req.user` chỉ được sửa ở **một** chỗ: `srv/lib/enrich-user.js`.
3. Default-deny. Không có dòng phân quyền ⇒ không role, không data.
4. Fail-closed. Lỗi tra quyền ⇒ không cấp thêm quyền.
5. Khoá user = IAS user id (`sub`/UUID). **Không** dùng email làm khoá.
6. Middleware chỉ **thêm** vào `u.roles`, không gán `u.roles = {}` —
   sẽ xoá mất `AppAdmin` bootstrap từ token và tự khoá mình ra ngoài app.

## Quy trình role (bảng-first)

Role định nghĩa trong bảng **TRƯỚC**, dev code `@requires` theo `roleId` đó.

```
1. Admin tạo role trong AdminFinanceRole   → status = DRAFT
2. Dev code @requires: 'FIN_APP_ADMIN'     → deploy app nghiệp vụ
3. Admin chuyển status                     → ACTIVE (giờ mới cho gán)
4. Admin gán cho user (UserRoles)          → hiệu lực TỨC THÌ
5. Ngừng dùng                              → DEPRECATED (ẩn khỏi dropdown)
```

`status` chỉ chi phối **UI** (chặn gán mới). **Không** chi phối enforcement —
quyền thực tế chỉ đến từ `UserRoles`. Muốn thu hồi quyền: **xoá** dòng `UserRoles`.

## Kill switch — `AuthzConfig.appManagedAuthz`

| | Phạm vi | Ảnh hưởng |
|---|---|---|
| `AdminFinanceRole.status` | Một role | Chỉ UI |
| `AuthzConfig.appManagedAuthz` | **Toàn hệ thống** | **Enforcement thật** |

- `true` → nạp role/org từ bảng (chế độ app-managed)
- `false` → middleware no-op, `req.user` giữ nguyên từ token XSUAA
  ⇒ nhảy hẳn về phân quyền chuẩn SAP BTP

**Trước khi tắt:** `xs-security.json` phải khai đủ scope/role-template cho **mọi**
role, và BTP Role Collection phải gán xong. Nếu không, toàn bộ user mất quyền.

App bắt buộc nhập lý do (`lastChangedNote`) và trả cảnh báo kèm **số dòng phân quyền
sẽ ngừng hiệu lực** trước khi cho tắt. Mọi thay đổi ghi `ChangeLog`.

## Master data (seed từ S/4)

| Entity | Nguồn | Số dòng |
|---|---|---|
| `CompanyCodes` | T001 + TKA02 (controlling area) | 87 |
| `ProfitCenters` | CEPC, lọc `datbi = 9999-12-31` | 471 |
| `AdminFinanceRole` | viết tay trong `gen-seed.py` | 4 |
| `AppUsers` | **viết tay**, gitignored — copy từ `.csv.example` — ⏳ chờ sync IAS | 6 |
| `UserOrg` | **viết tay**, gitignored — copy từ `.csv.example` | 6 |
| `UserRoles` | `gen-seed.py` | 2 |

Sinh lại: `python3 tools/gen-seed.py`
(`AppUsers` và `UserOrg` viết tay, script **không** ghi đè.)

### User mẫu

> ⚠️ **Seed user không nằm trong repo.** `cisd3.authz-AppUsers.csv` và
> `cisd3.authz-UserOrg.csv` chứa PII thật (email, tên, SCIM ID từ IAS tenant)
> nên đã được `.gitignore`. Trong repo chỉ có **`*.csv.example`** với dữ liệu mẫu.
>
> Khi clone: copy `.example` bỏ đuôi, rồi thay UUID bằng **SCIM ID thật** từ IAS
> tenant của bạn (`GET /scim/Users`). UUID trong `.example` và `gen-seed.py` là
> placeholder — không khớp user nào có thật.

`userId` = **SCIM ID** của IAS ⇒ khi chạy `importUsers()` thật, UPSERT sẽ khớp
đúng bản ghi, **không tạo trùng**. Đây là lý do không dùng email làm khoá.

| User | Org (data scope) | Role (function scope) | Minh hoạ |
|---|---|---|---|
| user1 | GB14 → PC `14AA`, `14AD` | `FIN_APP_ADMIN` | Case 1: PC cụ thể |
| user2 | GB14 (PC trống) | — | Case 2: cấp-CC ⇒ toàn bộ 96 PC |
| user3 | GB14 + FR16 | `FIN_APPROVE_L2` | Case 3: đa company code |
| user4 | US50 (PC trống) | — | 187 PC của US50 |
| user5 | — | — | Case 5: default-deny |
| user6 | — | — | Case 5: default-deny |

**`ProfitCenters.companyCode` lấy từ `CEPC.khinr` (Hierarchy Area), không đi qua
controlling area.** Lý do: controlling area là quan hệ 1-nhiều — `USV3` thuộc 9
company code, `USK4` thuộc 2 ⇒ **264/471 PC (56%) mơ hồ**, gây data leak chéo CC
(user US50 sẽ thấy PC của CA51 Canada). `khinr` xác định duy nhất 471/471 PC và
khớp 100% với đường TKA02 trên GB14 (96/96). Script tự đối chiếu 2 nguồn và cảnh
báo nếu lệch.

`CEPC` key gốc là `(mandt, prctr, datbi, kokrs)` — PC có time-dependency. Ở đây
**flatten** về bản đang hiệu lực: app phân quyền không cần lịch sử PC.

## Lưu ý HANA / HDI

- **Độ dài key đã chốt, không sửa về sau.** `code: String(4)` (mọi CC/PC đều đúng
  4 ký tự), `userId: String(64)`. Đổi độ dài cột key trên HANA = full table copy;
  có FK trỏ vào thì HDI từ chối.
- **`UserOrg` dùng `cuid`, không dùng composite key.** Key trên HANA bắt buộc
  NOT NULL, mà `profitCenter = NULL` ("toàn bộ PC của CC") là trung tâm của design.
  Tính duy nhất enforce ở handler.
- **`native_hana_associations: false`** — giảm deploy time, bỏ indirect dependency.
- Seed CSV: cột FK là **`companyCode_code`** (không phải `companyCode`).

## Cấu trúc

```
db/schema.cds                      data model AuthZ
db/data/                           seed CSV (sinh bởi tools/gen-seed.py)
srv/lib/enrich-user.js             ★ middleware nạp req.user
srv/server.js                      đăng ký middleware (after: 'auth')
srv/admin-service.{cds,js}         AdminService @path:'/admin' + validation + audit
srv/admin-service-annotations.cds  Fiori elements annotation
srv/demo-business-service.cds      DEMO: chứng minh @restrict lọc thật
app/managerole/                    UI5 app (Fiori elements, sap.fe.templates)
app/services.cds                   nạp annotation vào model
approuter/                         standalone approuter + xs-app.json
test/authz.test.js                 19 test (doc2 mục 7)
tools/gen-seed.py                  sinh seed từ SourceDataS4Table/
xs-security.json · mta.yaml        deploy BTP (html5-repo)
```

## Màn hình (Fiori elements)

Tất cả dưới `AdminService` ⇒ `@requires: 'AppAdmin'`.

| Route | Template | Chức năng |
|---|---|---|
| `/` | List Report + Object Page | **Users** — 2 section: Roles (function scope) + Org (data scope) |
| `/Roles` | List Report + Object Page | Catalog role, `status` có màu (ACTIVE xanh / DRAFT vàng) |
| `/ChangeLog` | List Report | Audit read-only |
| `/Config` | List Report + Object Page | Kill switch |

**Value help có lọc chéo:** khi gán Org, dropdown Profit Center **tự lọc theo
Company Code đã chọn** (`Common.ValueListParameterIn`) — chống gán PC của CC khác.
Verify được: `ProfitCenters?$filter=companyCode_code eq 'GB14'` → đúng 96 dòng.

## Trạng thái

| Hạng mục | Trạng thái |
|---|---|
| Schema + seed master data (CC/PC từ S/4) | ✅ Xong |
| Middleware `enrich-user.js` + enforcement `@restrict` | ✅ Xong |
| AdminService + validation + audit `ChangeLog` | ✅ Xong |
| UI5 Fiori elements (Users / Roles / ChangeLog / Config) | ✅ Xong |
| Kill switch `appManagedAuthz` | ✅ Xong |
| Test (19 case, doc2 mục 7) | ✅ Pass |
| Deploy BTP (approuter + html5-repo + HDI) | ✅ Đã chạy thật |
| **Đồng bộ user từ IAS (`importUsers`)** | ⏳ **Pending** |
| **Enforce `validFrom`/`validTo`** | ⏳ Pending |
| **Cache effective roles** | ⏳ Pending |
| **AuthzService API cho app khác (Model A)** | ⏳ Pending |
| **Popup confirm kill switch** | ⏳ Pending |

## Pending — việc còn lại

### 1. ⏳ Chưa call user từ IAS API (ưu tiên cao nhất)

Hiện `AppUsers` **seed tay** từ `db/data/cisd3.authz-AppUsers.csv` (6 dòng, SCIM ID
thật copy từ IAS). Action `importUsers()` **đã code xong** ([admin-service.js:132](srv/admin-service.js#L132))
— phân trang SCIM 100 bản ghi/lần, UPSERT theo `userId` — nhưng **chưa gọi được
IAS API thật** vì thiếu destination.

**Cần làm để bật:**
1. Tạo **API client** trong IAS Admin Console → Applications & Resources → API Clients,
   chọn quyền **Read Users** (OAuth2 client credentials).
2. Tạo destination tên **`ias`** trên BTP (Connectivity → Destinations):
   - `URL` = `https://<tenant>.accounts.ondemand.com`
   - `Authentication` = `OAuth2ClientCredentials`
   - `tokenServiceURL`, `clientId`, `clientSecret` từ bước 1
3. Khai `ias` vào `cds.requires` trong `package.json` + bind destination service ở `mta.yaml`.
4. Gọi `POST /admin/importUsers` → trả `{ imported: n }`, ghi `ChangeLog` action `IMPORT_USERS`.

Chưa có destination ⇒ action trả **501** kèm hướng dẫn (fail-closed, không crash).
Vì khoá là **SCIM ID** chứ không phải email, khi bật thật UPSERT sẽ khớp đúng 6 user
đang seed tay — **không tạo bản ghi trùng**.

### 2. ⏳ Chưa enforce `validFrom` / `validTo`

Cột đã có trong schema nhưng middleware **không đọc** ⇒ phân quyền hết hạn vẫn còn
hiệu lực. Bật sau chỉ cần sửa `enrich-user.js`, **không cần ALTER TABLE**.

### 3. ⏳ Chưa cache effective roles

Hiện mỗi request đều query bảng để dựng `req.user`; chỉ kill switch được cache (30s).
Khi scale nhiều instance nên thêm cache theo `userId` (cân nhắc Redis) — nhớ cơ chế
invalidate khi admin sửa quyền, vì cam kết hiện tại là **hiệu lực tức thì**.

### 4. ⏳ Chưa có AuthzService API (doc3)

Đang chạy **Model B** — app nghiệp vụ dùng chung HDI container và import thẳng
`enrich-user.js`. Nâng lên **Model A** (expose API riêng) **không cần đổi schema**.

### 5. ⏳ Chưa có popup confirm cho kill switch

Hiện là cảnh báo server (`req.warn`) → Fiori hiện message strip + **bắt buộc nhập
lý do**. Muốn dialog chặn "OK/Cancel" thật cần custom action + dialog trong UI.
