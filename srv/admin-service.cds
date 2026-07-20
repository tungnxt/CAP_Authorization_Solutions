using cisd3.authz as az from '../db/schema';

/**
 * AdminService — màn hình quản trị phân quyền.
 *
 * BẢO VỆ BẰNG 'AppAdmin'. Nếu hở, user tự nâng quyền cho chính mình.
 * AppAdmin đến từ token XSUAA (BTP Role Collection), KHÔNG từ bảng UserRoles
 * — bài toán con gà quả trứng: admin gốc chưa có dòng nào thì không vào được
 * UI để tự tạo dòng đó. Xem xs-security.json.
 */
service AdminService @(path: '/admin', requires: 'AppAdmin') {

  // Users KHÔNG bật draft: draft sẽ lan sang composition (UserRoles/UserOrg)
  // và bắt mọi ghi phải đi qua root entity — chặn cả API gán quyền trực tiếp.
  // Fiori Object Page vẫn dùng được ở chế độ non-draft (edit trực tiếp),
  // phù hợp với màn hình quản trị (thao tác ngắn, không cần soạn nháp).
  entity Users as projection on az.AppUsers;

  entity Roles as projection on az.AdminFinanceRole {
    *,
    // Màu trạng thái ở List Report: ACTIVE=xanh, DRAFT=vàng, DEPRECATED=xám
    case status
      when 'ACTIVE'     then 3
      when 'DRAFT'      then 2
      when 'DEPRECATED' then 0
      else 0
    end as statusCriticality : Integer
  };
  entity UserRoles as projection on az.UserRoles;
  entity UserOrg   as projection on az.UserOrg;

  @readonly entity CompanyCodes  as projection on az.CompanyCodes;
  @readonly entity ProfitCenters as projection on az.ProfitCenters;
  @readonly entity ChangeLog     as projection on az.ChangeLog;

  // Kill switch — xem cảnh báo ở db/schema.cds mục 7.
  // UI PHẢI confirm trước khi tắt (xem srv/admin-service.js).
  entity Config as projection on az.AuthzConfig;

  // Đồng bộ danh tính user từ IAS qua SCIM. Chỉ cập nhật cache danh tính,
  // KHÔNG đụng phân quyền.
  action importUsers() returns { imported : Integer };
}
