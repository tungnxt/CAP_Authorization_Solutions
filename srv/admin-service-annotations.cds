using AdminService from './admin-service';

// ─── Users: List Report + Object Page ────────────────────────────────────────
annotate AdminService.Users with @(
  UI: {
    SelectionFields: [ userId, loginName, email, active ],
    LineItem: [
      { Value: displayName, Label: 'Tên' },
      { Value: loginName,   Label: 'Login' },
      { Value: email,       Label: 'Email' },
      { Value: active,      Label: 'Active' }
    ],
    HeaderInfo: {
      TypeName: 'User', TypeNamePlural: 'Users',
      Title: { Value: displayName }, Description: { Value: email }
    },
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Thông tin',  Target: '@UI.FieldGroup#Main' },
      { $Type: 'UI.ReferenceFacet', Label: 'Roles (function scope)', Target: 'roles/@UI.LineItem' },
      { $Type: 'UI.ReferenceFacet', Label: 'Org (data scope)',       Target: 'orgs/@UI.LineItem' }
    ],
    FieldGroup#Main: {
      Data: [ { Value: userId }, { Value: loginName }, { Value: email },
              { Value: displayName }, { Value: active } ]
    }
  }
) {
  userId @title: 'IAS User ID' @readonly;
  active @title: 'Active';
}

// ─── UserRoles: section trong Object Page ────────────────────────────────────
annotate AdminService.UserRoles with @(
  UI.LineItem: [
    { Value: role_roleId,        Label: 'Role' },
    { Value: role.description,   Label: 'Mô tả' },
    { Value: role.note,          Label: 'Ghi chú nghiệp vụ' }
  ]
) {
  // Value help: chỉ hiện role ACTIVE (DRAFT/DEPRECATED bị ẩn khỏi gán mới)
  role @(
    title: 'Role',
    Common: {
      Text: role.description, TextArrangement: #TextFirst,
      ValueList: {
        CollectionPath: 'Roles',
        Parameters: [
          { $Type: 'Common.ValueListParameterInOut',
            LocalDataProperty: role_roleId, ValueListProperty: 'roleId' },
          { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'description' },
          { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'status' }
        ]
      }
    }
  );
}

// ─── UserOrg: section trong Object Page ──────────────────────────────────────
annotate AdminService.UserOrg with @(
  UI.LineItem: [
    { Value: companyCode_code,  Label: 'Company Code' },
    { Value: companyCode.name,  Label: 'Tên công ty' },
    { Value: profitCenter_code, Label: 'Profit Center' },
    { Value: profitCenter.name, Label: 'Tên PC' }
  ]
) {
  companyCode @(
    title: 'Company Code',
    Common: {
      Text: companyCode.name, TextArrangement: #TextFirst,
      ValueList: {
        CollectionPath: 'CompanyCodes',
        Parameters: [
          { $Type: 'Common.ValueListParameterInOut',
            LocalDataProperty: companyCode_code, ValueListProperty: 'code' },
          { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
        ]
      }
    }
  );
  // Để TRỐNG = user có toàn bộ profit center của company code đó.
  profitCenter @(
    title: 'Profit Center (trống = toàn bộ)',
    Common: {
      Text: profitCenter.name, TextArrangement: #TextFirst,
      ValueList: {
        CollectionPath: 'ProfitCenters',
        Parameters: [
          { $Type: 'Common.ValueListParameterInOut',
            LocalDataProperty: profitCenter_code, ValueListProperty: 'code' },
          // Lọc PC theo đúng company code đã chọn — tránh gán PC của CC khác
          { $Type: 'Common.ValueListParameterIn',
            LocalDataProperty: companyCode_code, ValueListProperty: 'companyCode_code' },
          { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' }
        ]
      }
    }
  );
}

// ─── Roles: catalog (bảng-first) ─────────────────────────────────────────────
annotate AdminService.Roles with @(
  UI: {
    SelectionFields: [ roleId, status ],
    LineItem: [
      { Value: roleId,      Label: 'Role ID' },
      { Value: description, Label: 'Mô tả' },
      { Value: status,      Label: 'Trạng thái',
        Criticality: statusCriticality },
      { Value: note,        Label: 'Ghi chú nghiệp vụ' }
    ],
    HeaderInfo: {
      TypeName: 'Role', TypeNamePlural: 'Roles',
      Title: { Value: roleId }, Description: { Value: description }
    },
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Định nghĩa', Target: '@UI.FieldGroup#Main' },
      { $Type: 'UI.ReferenceFacet', Label: 'Đang gán cho', Target: 'assignments/@UI.LineItem' }
    ],
    FieldGroup#Main: {
      Data: [ { Value: roleId }, { Value: description },
              { Value: status }, { Value: note } ]
    }
  }
) {
  roleId @title: 'Role ID (dùng trong @requires của app)';
  note   @title: 'Ghi chú nghiệp vụ' @UI.MultiLineText;
  status @title: 'Trạng thái';
}

// ─── Config: kill switch ─────────────────────────────────────────────────────
annotate AdminService.Config with @(
  UI: {
    HeaderInfo: { TypeName: 'Cấu hình phân quyền', TypeNamePlural: 'Cấu hình' },
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Chế độ phân quyền',
        Target: '@UI.FieldGroup#Mode' }
    ],
    FieldGroup#Mode: {
      Data: [ { Value: appManagedAuthz }, { Value: lastChangedNote } ]
    }
  }
) {
  appManagedAuthz @title: 'Bật phân quyền qua app (tắt = dùng BTP Role Collection)';
  lastChangedNote @title: 'Lý do thay đổi (bắt buộc khi tắt)' @UI.MultiLineText;
}

// ─── ChangeLog: read-only audit ──────────────────────────────────────────────
annotate AdminService.ChangeLog with @(
  UI: {
    SelectionFields: [ targetUser, action, actor ],
    LineItem: [
      { Value: createdAt,  Label: 'Thời điểm' },
      { Value: actor,      Label: 'Người thực hiện' },
      { Value: action,     Label: 'Hành động' },
      { Value: targetUser, Label: 'User bị tác động' },
      { Value: detail,     Label: 'Chi tiết' }
    ]
  }
);

annotate AdminService.CompanyCodes with @(
  UI.LineItem: [
    { Value: code, Label: 'Company Code' }, { Value: name, Label: 'Tên' },
    { Value: city, Label: 'Thành phố' }, { Value: country, Label: 'Quốc gia' },
    { Value: currency, Label: 'Tiền tệ' },
    { Value: controllingArea, Label: 'Controlling Area' }
  ]
);

annotate AdminService.ProfitCenters with @(
  UI: {
    SelectionFields: [ code, companyCode_code ],
    LineItem: [
      { Value: code, Label: 'Profit Center' }, { Value: name, Label: 'Tên' },
      { Value: companyCode_code, Label: 'Company Code' },
      { Value: controllingArea, Label: 'Controlling Area' }
    ]
  }
);
