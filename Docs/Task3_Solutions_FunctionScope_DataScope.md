# Task 3 — Solution: Phân quyền cho App CAP (Function Scope & Data Scope)

**Dự án:** CISD3 — SAP BTP ↔ S/4HANA 2025 (khách: nhóm ITOCHU · môi trường TRAINING_DEV · tenant IAS `as8a3pb0k`)
**Tech stack:** CAP (Node.js) · SAP BTP (XSUAA) · IAS · IPS · SAP Build Work Zone · Azure AD (Entra) làm IdP xác thực
**Tiếp nối:** Task 1 (SSO/Trust), Task 2 (IPS sync user)
**Trạng thái:** 🟢 Solution đã chốt.
**Ngày cập nhật:** 2026-07-20

> **Phạm vi tài liệu này:** *chỉ mô tả solution đã chốt* — ai (IAS / BTP / App CAP) chịu trách nhiệm phần nào của phân quyền. **Không** đi vào chi tiết thiết kế/kỹ thuật.
> - Thiết kế & spec để build app → **`Task3_Design_App_ManageRole_FunctionScope_DataScope.md`** (doc2).
> - Cách các app khác đấu nối vào app phân quyền → **`Task3_Integration_App_ManageRole_ToOtherApp.md`** (doc3).

---

## 1. Bối cảnh

Chuỗi Task:
- **Task 1 — Authentication:** Azure AD (Entra) làm credential, IAS làm IdP, BTP/XSUAA nhận token. SSO end-to-end đã chạy.
- **Task 2 — User provisioning:** user được IPS đồng bộ Azure → IAS (shadow user).
- **Task 3 (tài liệu này) — Authorization:** chốt mô hình phân quyền đầy đủ cho các app CAP.

Ràng buộc thực tế định hình solution:
- **Không truy cập được Azure AD của khách** → org-value không thể lấy từ Azure.
- Trust hiện tại là **OIDC** (User Groups), đổ attribute qua OIDC phức tạp.
- Khách **ngại khối lượng việc của đội hạ tầng** và **ngại phân quyền bị quản ở nhiều nơi**.
- Cần **roll-out GB14 trước**, nhưng **adapt được cho company code khác** về sau.

---

## 2. Hai tầng phân quyền (mental model)

Luôn tách rõ **2 chiều độc lập**:

| Chiều | Trả lời | Ví dụ CISD3 |
|---|---|---|
| **Function Scope** (chức năng) | User **làm được gì**? (mở service, đọc/ghi, gọi action) | `Instructor` được upload; `Approve_PR` được duyệt |
| **Data Scope** (phạm vi dữ liệu) | User **thấy dữ liệu nào**? (theo company code / profit center) | GB14 chỉ thấy dữ liệu company code GB14 |

Nguyên tắc vàng: **không nhân hai chiều này thành role** (tránh bùng nổ số role). Function và Data được quản như **hai bảng độc lập**, gán cho user một cách rời nhau.

---

## 3. SOLUTION ĐÃ CHỐT — ai quản gì

Mô hình: **Application-managed Authorization** — một app CAP ("App Manage-Role") làm **nguồn sự thật duy nhất** cho cả Function lẫn Data Scope.

```
Azure AD (Entra)            [khách sở hữu — CHỈ credential]
   │  IPS
   ▼
IAS  as8a3pb0k              ①  authentication + user store
   │  OIDC token (user id ổn định)
   ▼
BTP / XSUAA                 ②  chỉ giữ 1 Role Collection BOOTSTRAP (AppAdmin)
   ▼
App CAP "Manage-Role"       ③  nguồn sự thật: Function + Data Scope
   ▲
   │  cross-check (API)
Các app nghiệp vụ khác      ④  hỏi quyền từ App Manage-Role  → xem doc3
```

### ① IAS — chỉ Authentication + User Store
- Xác thực user (SSO), chứa shadow user do IPS đồng bộ từ Azure.
- **KHÔNG** lưu org-value (không dùng custom attribute cho company code/profit center).
- **KHÔNG** cần map group nghiệp vụ sang role. Đội Basis chỉ còn việc **sync user**.

### ② BTP / XSUAA — tối thiểu
- Giữ nguyên trust/SSO đã dựng (Task 1).
- Về phân quyền, BTP chỉ còn **một** Role Collection **bootstrap** (`AppAdmin`) gán cho 1–2 admin gốc — để người đầu tiên đăng nhập được vào màn hình quản trị của App Manage-Role. Đây là **mapping duy nhất còn lại ở BTP**.

### ③ App CAP "Manage-Role" — trung tâm phân quyền
- **Nguồn sự thật** cho cả hai chiều, lưu trong bảng của app:
  - **Function Scope:** danh mục role + gán role cho user.
  - **Data Scope:** danh mục company code/profit center + gán org cho user.
- Có **màn hình quản trị** để Security Admin gán quyền (không cần đụng BTP/IAS).
- Import danh sách user từ IAS qua **SCIM API**.
- *Cách hoạt động chi tiết → doc2.*

### ④ Các app nghiệp vụ khác (UploadLOB, …)
- Không tự quản phân quyền; **cross-check sang App Manage-Role** để lấy role + org của user rồi enforce bằng annotation CAP chuẩn.
- *Cơ chế đấu nối → doc3.*

---

## 4. Chiều dữ liệu của Data Scope

- Data Scope chạy theo **Company Code + Profit Center**.
- **Chọn Profit Center, bỏ Business Area:** dữ liệu khách cho thấy mọi profit center dùng trong mapping đều nằm trong tập business area → BA là superset dư thừa; PC mịn hơn.
- **Phát hiện quan trọng — Profit Center prefix = số của Company Code (đúng 100%):** `14xx`→GB14, `16xx`→FR16, `20xx`→DE20, `24xx`→IT24, `33xx`→ZA33, `50xx`→US50…
  → Company Code **suy được từ** Profit Center; không cần "nhân chéo" hai chiều. User có toàn quyền một company code thì **không cần liệt kê từng profit center**.

---

## 5. Quy mô thực tế (từ `User_Org_Mapping.xlsx` + bảng S/4)

- **742 user**, chỉ **16 company code** thực sự được gán (nhóm ITOCHU), **239 profit center** distinct.
- **493/742 user chỉ có company code, không có profit center** → phần lớn chỉ cần lọc mức CC.
- **GB14: 76 user** (59 thuần GB14, 17 đa-CC), **91 profit center** mã `14xx`.

→ Quy mô **bị chặn**, không "quá nhiều" như lo ngại ban đầu; hoàn toàn quản được bằng bảng trong app.

---

## 6. Phương án đã cân nhắc & lý do chọn

| Phương án | Cơ chế | Vì sao **không** chọn làm chính |
|---|---|---|
| **XSUAA attribute** | org-value đi trong token, `@restrict.where` đọc `$user.attr` | Trust OIDC → đổ attribute qua claim phức tạp; đội hạ tầng phải đụng trust config nhiều lần |
| **AMS (IAS-based)** | policy DCL, AMS đọc attribute IAS | Hướng chuẩn SAP nhưng phải dựng thêm dịch vụ; vẫn phải nạp org-value vào IAS (giới hạn 10 ô custom attribute, đau với multi-value 91 PC) |
| **✅ App-managed (đã chọn)** | role + org trong bảng app; nạp `req.user` qua middleware; enforce bằng annotation CAP chuẩn | Một nơi quản cả 2 chiều; đội Basis nhẹ; không phụ thuộc Azure; không giới hạn attribute; UI quản trị thân thiện |

*(Chi tiết vì sao app-managed khả thi về kỹ thuật — enrich `req.user.roles`/`attr` — nằm ở doc2.)*

---

## 7. Trách nhiệm các bên

| Bên | Việc | Tần suất |
|---|---|---|
| Đội Basis | Sync user Azure→IAS (IPS) | Khi nhân sự đổi |
| BTP Admin | Gán 1 Role Collection `AppAdmin` bootstrap | 1 lần |
| Security Admin (trong App Manage-Role) | Gán role + org cho user qua màn hình | Hằng ngày |
| Developer CAP | Khai loại role & entity cần bảo vệ (annotation) | Khi có nghiệp vụ mới |

---

## 8. Đánh đổi & governance (nêu trung thực với khách)

**Được:** một nguồn sự thật + một màn hình; đội Basis nhẹ; không phụ thuộc Azure; không vướng giới hạn attribute IAS; adapt company code mới không cần đụng code.

**Mất / phải chấp nhận:**
- Bỏ cơ chế scope/token chuẩn SAP cho function → **app tự gánh tính đúng đắn** (phải test kỹ).
- Vẫn cần **1 mapping bootstrap** ở BTP cho admin gốc.
- Kém "native/audit chuẩn SAP" hơn AMS/XSUAA → cân với yêu cầu compliance của khách.
- Danh mục *loại* quyền (cái mỗi role bảo vệ) vẫn là design-time (developer) — *gán* cho ai mới là động.

> Nếu khách ưu tiên audit/governance chuẩn SAP hơn tự chủ, có thể lật lại hybrid (function trên token, data ở app) hoặc AMS — nhưng đây không phải hướng đã chốt.

---

## 9. Rollout GB14 & adapt company code khác

- **GB14 trước:** seed 91 profit center `14xx`, gán org cho 76 user, gán role theo nghiệp vụ.
- **Adapt CC khác:** chỉ thêm dữ liệu (company code / profit center / gán user) trong app — **không đụng code**. Nhờ prefix rule, mở rộng gần như thuần cấu hình dữ liệu.

*(Các bước rollout cụ thể → doc2 mục Rollout.)*

---

## 10. Liên kết tài liệu

| Doc | Nội dung |
|---|---|
| **doc1 (tài liệu này)** `Task3_Solutions_FunctionScope_DataScope.md` | Solution đã chốt — ai quản gì |
| **doc2** `Task3_Design_App_ManageRole_FunctionScope_DataScope.md` | Thiết kế & spec để build App Manage-Role (dùng cho dev / code) |
| **doc3** `Task3_Integration_App_ManageRole_ToOtherApp.md` | Cách các app khác cross-check sang App Manage-Role |

---

## Phụ lục — Đối chiếu PFCG/RAP (cho đội quen ABAP)

| Khái niệm ABAP | Trong solution app-managed |
|---|---|
| Global authorization (BDEF) | Function Scope: role trong App Manage-Role |
| Instance authorization / DCL lọc `BUKRS` | Data Scope: `@restrict.where` theo company code/profit center |
| Org level (AGR_1252) | Bảng gán org cho user trong app |
| Single/Composite Role gán user (PFCG) | Bảng gán role cho user trong app |
| SU01 user | User store IAS (cache trong app) |
