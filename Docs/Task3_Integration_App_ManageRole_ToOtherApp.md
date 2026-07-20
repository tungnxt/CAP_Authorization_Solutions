# Task 3 — Integration: App khác cross-check sang App "Manage-Role"

**Dự án:** CISD3 · **Runtime các app:** CAP (Node.js)
**Vai trò tài liệu:** định nghĩa **hợp đồng đấu nối** — làm sao các app nghiệp vụ (UploadLOB, …) lấy phân quyền (role + org) từ App Manage-Role rồi tự enforce.
**Bối cảnh/solution:** doc1 `Task3_Solutions_FunctionScope_DataScope.md` · **Nội bộ App Manage-Role:** doc2 `Task3_Design_App_ManageRole_FunctionScope_DataScope.md`.
**Ngày:** 2026-07-20

> **Một câu:** App Manage-Role là *nguồn sự thật*. App khác **không** tự lưu phân quyền — chúng **hỏi** effective role + org của user hiện tại, rồi enforce bằng annotation CAP chuẩn (`@requires` / `@restrict.where`) y như App Manage-Role tự làm.

---

## 1. Hai mô hình đấu nối

| | **Model A — Gọi API (khuyến nghị)** | **Model B — Dùng chung DB** |
|---|---|---|
| Cách lấy quyền | App gọi **AuthzService API** của Manage-Role | App đọc trực tiếp bảng AuthZ (chung HANA container) |
| Kết nối | HTTP + XSUAA (service-to-service) | HDI container sharing |
| Ưu | Tách rời rõ ràng, versioning, app độc lập triển khai | Đơn giản, không cần API, nhanh |
| Nhược | Có network hop (giảm bằng cache) | Ràng buộc chặt vào schema; khó tách khi nhiều app |
| Chọn khi | Nhiều app, muốn tách biệt (mặc định) | 1–2 app cùng dự án, cùng DB, muốn nhanh |

Phần còn lại của tài liệu tập trung **Model A**; Model B nêu ở mục 7.

---

## 2. Sơ đồ luồng (Model A)

```
User → (SSO/IAS) → App nghiệp vụ (vd UploadLOB)
                        │  request có token user đã xác thực
                        ▼
          [middleware enrich-user của app nghiệp vụ]
                        │  gọi AuthzService của Manage-Role
                        │  (chuyển tiếp danh tính user — mục 5)
                        ▼
             App Manage-Role · AuthzService
                        │  tính effective roles + org của user
                        ▼
          Trả { roles[], companyCodes[], profitCenters[] }
                        │
          App nghiệp vụ nạp vào req.user.roles / req.user.attr
                        ▼
          @requires / @restrict.where  → filter SQL đẩy xuống DB
```

Điểm mấu chốt: **app nghiệp vụ vẫn tự enforce** bằng annotation của chính nó; Manage-Role chỉ *cung cấp dữ liệu quyền*. Cơ chế enforce giống hệt doc2 mục 3 — chỉ khác **nguồn** dữ liệu là API thay vì DB local.

---

## 3. Hợp đồng API (AuthzService)

### 3.1 Endpoint
```
GET  /authz/effective            → quyền của user HIỆN TẠI (suy từ token, mục 5)
```
(Không nhận `userId` tuỳ ý từ client để tránh giả mạo — xem mục 5. Nếu cần tra hộ, dùng endpoint quản trị riêng, chỉ cho `AppAdmin`.)

### 3.2 Response (JSON, ổn định — có versioning)
```json
{
  "version": "1",
  "userId": "e3b0c442-...-IAS-UUID",
  "roles": ["Instructor", "Approve_PR"],
  "companyCodes": ["GB14"],
  "profitCenters": ["14AA", "14AD"],
  "companyCodesFull": ["GB14"],
  "generatedAt": "2026-07-20T10:00:00Z",
  "ttlSeconds": 600
}
```
- `profitCenters` rỗng + `companyCodesFull` chứa CC ⇒ user có **toàn bộ** profit center của các CC đó (quy tắc "cấp company code" — prefix rule).
- `ttlSeconds`: gợi ý thời gian consumer được cache.
- `version`: tăng khi đổi cấu trúc; consumer kiểm tra để không vỡ.

### 3.3 CDS (trong App Manage-Role — bổ sung cho doc2)
```cds
service AuthzService @(requires: 'authenticated-user') {
  function effective() returns {
    version: String; userId: String;
    roles: array of String;
    companyCodes: array of String;
    profitCenters: array of String;
    companyCodesFull: array of String;
    generatedAt: DateTime; ttlSeconds: Integer;
  };
}
```
Handler tính `effective()` = đọc `UserRoles` + `UserOrg` của `req.user.id` (dùng lại logic doc2 mục 3).

---

## 4. Phía app tiêu thụ — middleware (thay nguồn = API)

```js
// srv/lib/enrich-user-remote.js  (app nghiệp vụ, vd UploadLOB)
const cds = require('@sap/cds')
module.exports = function enrichUserRemote () {
  return async function (_req, _res, next) {
    const u = cds.context?.user
    if (u && u.id) {
      try {
        const authz = await cds.connect.to('manageRoleAuthz')   // destination tới AuthzService
        const cacheHit = cache.get(u.id)
        const eff = cacheHit ?? await authz.send('GET', '/authz/effective')  // token user được propagate
        if (!cacheHit) cache.set(u.id, eff, eff.ttlSeconds)
        for (const r of eff.roles) u.roles[r] = 1
        u.attr.CompanyCode  = eff.companyCodes
        u.attr.ProfitCenter = eff.profitCenters
      } catch (e) {
        cds.log('authz').error('remote enrich failed', e)   // FAIL-CLOSED: không cấp quyền
      }
    }
    next()
  }
}
```
```js
// srv/server.js (app nghiệp vụ)
cds.middlewares.add(require('./lib/enrich-user-remote')(), { after: 'auth' })
```
Sau đó service của app nghiệp vụ **giữ nguyên** `@requires`/`@restrict.where` như doc2 mục 4.1.

---

## 5. Truyền & tin cậy danh tính (điểm bảo mật quan trọng nhất)

**Nguyên tắc:** `userId` mà Manage-Role dùng để tra quyền phải đến từ **token đã xác thực**, không bao giờ từ tham số do client tự điền (chống một user tra/áp quyền của user khác).

- **Khuyến nghị — Principal propagation:** app nghiệp vụ và Manage-Role cùng trust IAS/XSUAA; token của end-user được **chuyển tiếp** (token exchange) sang AuthzService. Manage-Role suy `userId` từ token này (`req.user.id`) → không thể giả mạo.
- **Thay thế — Technical user + tham số:** nếu gọi bằng technical user (client credentials), thì phải là **endpoint quản trị riêng** (`/authz/effectiveFor(userId)`) chỉ cấp cho caller đáng tin (app đã đăng ký), và caller **chỉ** được truyền `userId` của chính request nó đang xử lý. Yếu hơn principal propagation → chỉ dùng khi bắt buộc.
- Đăng ký service-to-service qua **XSUAA** (scope riêng cho AuthzService); từ chối caller lạ.

---

## 6. Vận hành & độ tin cậy

- **Cache ở consumer** theo `userId` + `ttlSeconds` từ response → giảm network hop. Có thể subscribe sự kiện "quyền đổi" (nếu bật) để invalidate sớm; nếu không, chấp nhận trễ tối đa = TTL.
- **Timeout + fail-closed:** AuthzService không phản hồi ⇒ **không** cấp quyền (an toàn hơn cấp nhầm). Cân nhắc cache "stale-while-error" ngắn nếu cần độ sẵn sàng.
- **Idempotent, chỉ đọc:** `effective()` không side-effect → an toàn để cache/retry.
- **Versioning:** consumer kiểm `version`; Manage-Role giữ tương thích ngược khi thêm trường.

---

## 7. Model B — Dùng chung DB (khi phù hợp)

- App nghiệp vụ và Manage-Role **chung HDI container**; app nghiệp vụ dùng thẳng middleware `enrich-user.js` của doc2 (đọc bảng `UserRoles`/`UserOrg`).
- Ưu: bỏ network hop, không cần API. Nhược: mọi app dính chặt schema AuthZ; đổi schema phải phối hợp tất cả app → chỉ hợp khi ít app, cùng dự án.
- Nếu chọn Model B, **doc2 mục 3** là tất cả những gì consumer cần; tài liệu này (API) không bắt buộc.

---

## 8. Checklist tích hợp một app mới (Model A)

- [ ] Đăng ký destination `manageRoleAuthz` tới AuthzService (+ trust XSUAA service-to-service).
- [ ] Bật principal propagation (hoặc endpoint technical có kiểm soát — mục 5).
- [ ] Thêm middleware `enrich-user-remote` sau `auth()`.
- [ ] Đảm bảo tên role trong `@requires` của app **có trong catalog `AppRoles`** của Manage-Role (test khớp).
- [ ] Cấu hình cache + timeout + fail-closed.
- [ ] Test 8 case (doc2 mục 7) trên chính app nghiệp vụ.
- [ ] Xác nhận `@restrict.where` filter **đẩy xuống SQL** (cả `$count`/expand).

---

## 9. Liên kết tài liệu
- **doc1** `Task3_Solutions_FunctionScope_DataScope.md` — solution: ai quản gì.
- **doc2** `Task3_Design_App_ManageRole_FunctionScope_DataScope.md` — nội bộ App Manage-Role (build spec).
- **doc3 (tài liệu này)** — hợp đồng & cách app khác cross-check.

> **Ghi chú kỹ thuật:** middleware `after: 'auth'`, `@requires`/`@restrict.where`, principal propagation/token exchange giữa các app trên cùng trust XSUAA/IAS đều theo mô hình CAP/BTP chuẩn. Tên đường dẫn API, tên destination và cú pháp `authz.send()` cần khớp cấu hình thực tế khi build.
