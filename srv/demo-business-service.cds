using cisd3.authz as az from '../db/schema';

/**
 * Service DEMO — mô phỏng app nghiệp vụ tiêu thụ (UploadLOB, Payment Approval...).
 *
 * MỤC ĐÍCH: chứng minh @restrict.where thực sự lọc dữ liệu theo req.user.attr
 * do enrich-user nạp — tức là toàn bộ chuỗi enforcement hoạt động.
 *
 * App nghiệp vụ thật sẽ có service riêng với annotation TƯƠNG TỰ; Manage-Role
 * chỉ cung cấp dữ liệu quyền, KHÔNG enforce hộ.
 *
 * Model B (chung HDI container): app nghiệp vụ dùng thẳng enrich-user.js này.
 */
service DemoBusinessService @(requires: 'authenticated-user') {

  // DATA SCOPE — hai tầng lọc, đúng ngữ nghĩa đã thiết kế:
  //   1. companyCode_code = $user.CompanyCode   → chỉ CC được cấp
  //   2. và ( user KHÔNG có PC cụ thể nào  → thấy toàn bộ PC của CC đó
  //          hoặc code = $user.ProfitCenter → chỉ đúng PC được cấp )
  //
  // $user.ProfitCenter rỗng ⇒ điều kiện (2) luôn đúng ⇒ "cấp company code".
  // Nếu chỉ lọc theo CC, user được cấp 2 PC cụ thể vẫn thấy TOÀN BỘ PC của CC
  // — đó là data leak trong phạm vi company code.
  @readonly
  entity MyProfitCenters @(restrict: [
    { grant: 'READ', to: 'AppAdmin' },
    { grant: 'READ', where: (
        companyCode.code = $user.CompanyCode
        and ( $user.ProfitCenter is null or code = $user.ProfitCenter )
      ) }
  ]) as projection on az.ProfitCenters;

  // FUNCTION SCOPE — chỉ user có role FIN_APP_ADMIN mới gọi được.
  @readonly
  entity RestrictedData @(requires: 'FIN_APP_ADMIN')
    as projection on az.CompanyCodes;
}
