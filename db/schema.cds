namespace cisd3.authz;

using { managed, cuid } from '@sap/cds/common';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  App "Manage-Role" — nguồn sự thật phân quyền (function scope + data scope)
 *
 *  NGUYÊN TẮC BẤT BIẾN:
 *    Chỉ UserRoles quyết định "user có role gì".
 *    Chỉ UserOrg   quyết định "user thấy data nào".
 *    Mọi bảng/cột khác là metadata cho con người, KHÔNG chi phối enforcement.
 * ─────────────────────────────────────────────────────────────────────────────
 */


// ─── 1. Danh tính user (cache từ IAS qua SCIM) ───────────────────────────────
//  Khoá = IAS user id ổn định (sub/UUID). TUYỆT ĐỐI không dùng email làm khoá.
entity AppUsers : managed {
  key userId      : String(64);
      loginName   : String(120);
      email       : String(255);
      displayName : String(255);
      active      : Boolean default true;   // user còn hiệu lực trong IAS?
      roles       : Composition of many UserRoles on roles.user = $self;
      orgs        : Composition of many UserOrg   on orgs.user  = $self;
}


// ─── 2. Catalog role (BẢNG-FIRST) ────────────────────────────────────────────
//  Quy trình: định nghĩa role ở đây TRƯỚC → dev code @requires theo roleId này.
//  roleId dùng thẳng trong @requires/@restrict.to của mọi app tiêu thụ.
//
//  status chỉ chi phối UI (ẩn khỏi dropdown khi gán mới).
//  KHÔNG chi phối enforcement — quyền thực tế chỉ đến từ UserRoles.
entity AdminFinanceRole : managed {
  key roleId      : String(64);      // 'FIN_APP_ADMIN', 'FIN_APPROVE_L2', 'AppAdmin'
      description : String(255);     // một dòng ngắn, hiện ở dropdown
      note        : String(1000);    // ngữ cảnh nghiệp vụ: ai được gán, vì sao, chốt với ai
      status      : RoleStatus default 'DRAFT';
      assignments : Association to many UserRoles on assignments.role = $self;
}

type RoleStatus : String(12) enum {
  DRAFT;        // đã định nghĩa, dev chưa implement → chưa cho gán
  ACTIVE;       // đang dùng → hiện trong dropdown
  DEPRECATED;   // ngừng dùng → ẩn khỏi dropdown (gán cũ vẫn cần xoá thủ công)
}


// ─── 3. FUNCTION SCOPE — user nào có role nào ────────────────────────────────
//  Đây là NGUỒN SỰ THẬT DUY NHẤT cho @requires / @restrict.to.
entity UserRoles : managed {
  key user      : Association to AppUsers        not null;
  key role      : Association to AdminFinanceRole not null;
      validFrom : Date;    // v1: KHÔNG enforce (xem note bên dưới)
      validTo   : Date;    // v1: KHÔNG enforce — cột tồn tại để bật sau, không cần ALTER TABLE
}


// ─── 4. Catalog org (master data từ S/4) ─────────────────────────────────────
//  Nguồn: T001 (company code), CEPC (profit center), TKA02 (controlling area).
entity CompanyCodes : managed {
  key code            : String(4);    // 'GB14'  — T001.bukrs
      name            : String(120);  //          T001.butxt
      city            : String(60);   //          T001.ort01
      country         : String(3);    //          T001.land1
      currency        : String(5);    //          T001.waers
      controllingArea : String(4);    // 'GBV3'  — TKA02.kokrs
      profitCenters   : Composition of many ProfitCenters
                          on profitCenters.companyCode = $self;
}

//  Key S/4 gốc: (mandt, prctr, datbi, kokrs) — profit center có time-dependency.
//  Ở đây FLATTEN về bản ghi đang hiệu lực (datbi = 9999-12-31):
//  app phân quyền không cần lịch sử PC.
//
//  companyCode lấy từ CEPC.khinr (Hierarchy Area) — nguồn CHÍNH.
//  Lý do không dùng đường CC→TKA02.kokrs→CEPC: controlling area là quan hệ
//  1-nhiều (USV3 có 9 company code) ⇒ 264/471 PC mơ hồ, gây data leak chéo CC.
//  khinr xác định duy nhất 471/471 PC và khớp 100% với TKA02 trên GB14.
//  controllingArea giữ lại làm cột KIỂM CHỨNG (đối chiếu với CompanyCodes).
entity ProfitCenters : managed {
  key code            : String(4);    // '14AA'  — CEPC.prctr
      name            : String(120);  //          CEPC.ktext / Name
      companyCode     : Association to CompanyCodes;   // từ CEPC.khinr
      controllingArea : String(4);    // 'GBV3'  — CEPC.kokrs (cross-check)
}


// ─── 5. DATA SCOPE — user nào thấy org nào ───────────────────────────────────
//  profitCenter NULL = user có TOÀN BỘ profit center của company code đó.
//
//  Dùng cuid làm key kỹ thuật (KHÔNG dùng (user, companyCode, profitCenter)
//  làm composite key): key trên HANA bắt buộc NOT NULL, mà ngữ nghĩa
//  "profitCenter NULL = toàn bộ PC" là trung tâm của design.
//  Tính duy nhất enforce ở handler, không ở DB.
entity UserOrg : cuid, managed {
  user         : Association to AppUsers     not null;
  companyCode  : Association to CompanyCodes not null;
  profitCenter : Association to ProfitCenters;   // NULL = toàn bộ PC của CC
}


// ─── 6. Audit ────────────────────────────────────────────────────────────────
entity ChangeLog : cuid, managed {
  targetUser : String(64);    // user bị tác động
  action     : String(32);    // GRANT_ROLE / REVOKE_ROLE / ADD_ORG / REMOVE_ORG
                              // / IMPORT_USERS / AUTHZ_MODE_CHANGED
  detail     : String(1000);
  actor      : String(64);    // ai thực hiện
}


// ─── 7. Kill switch (cấp hệ thống) ───────────────────────────────────────────
//  KHÁC HẲN AdminFinanceRole.status:
//    - status          → phạm vi MỘT role, chỉ ảnh hưởng UI
//    - appManagedAuthz → phạm vi TOÀN HỆ THỐNG, ảnh hưởng enforcement thật
//
//  appManagedAuthz = true  → enrich-user nạp role/org từ bảng (chế độ app-managed)
//  appManagedAuthz = false → middleware no-op, req.user giữ nguyên từ token XSUAA
//                            ⇒ nhảy hẳn về phân quyền chuẩn SAP BTP
//
//  CẢNH BÁO: tắt cờ này khi xs-security.json chưa khai đủ scope/role-template
//  cho mọi role ⇒ TOÀN BỘ user mất quyền. UI phải confirm trước khi tắt.
//  Singleton: luôn chỉ có đúng 1 dòng, ID = 1.
entity AuthzConfig : managed {
  key ID              : Integer default 1;
      appManagedAuthz : Boolean default true;
      lastChangedNote : String(500);   // lý do bật/tắt — bắt buộc nhập khi tắt
}
