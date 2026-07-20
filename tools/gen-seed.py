#!/usr/bin/env python3
"""
Sinh seed CSV cho db/data/ từ master data S/4 (SourceDataS4Table/).

Nguồn & quy tắc map (đã verify trên data thật):
  CompanyCodes  ← T001  (bukrs, butxt, ort01, land1, waers)
                + TKA02 (kokrs — controlling area, join theo bukrs)
  ProfitCenters ← CEPC  (prctr, ktext/Name, kokrs)
                  companyCode ← CEPC.khinr (Hierarchy Area)  ★ nguồn CHÍNH
                  lọc datbi = 9999-12-31 (bản ghi đang hiệu lực)

Vì sao companyCode lấy từ khinr chứ không đi qua TKA02:
  Controlling area là quan hệ 1-nhiều. USV3 thuộc 9 company code,
  USK4 thuộc 2 ⇒ 264/471 PC (56%) không xác định được CC ⇒ data leak chéo CC.
  khinr xác định duy nhất 471/471 PC, và khớp 100% với TKA02 trên GB14 (96/96).
  Script tự đối chiếu 2 nguồn và cảnh báo nếu lệch.

Chạy:  python3 tools/gen-seed.py
"""
import csv
import os
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "SourceDataS4Table")
OUT = os.path.join(ROOT, "db", "data")
NS = "cisd3.authz"

ACTIVE_UNTIL = "9999"  # CEPC.datbi của bản ghi đang hiệu lực


def read(name):
    with open(os.path.join(SRC, name), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write(entity, fields, rows):
    path = os.path.join(OUT, f"{NS}-{entity}.csv")
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    print(f"  ✓ {NS}-{entity}.csv  ({len(rows)} rows)")
    return len(rows)


def main():
    os.makedirs(OUT, exist_ok=True)
    print("Đọc master data S/4 ...")
    t001 = read("T001.csv")
    tka02 = read("TKA02.csv")
    cepc = read("CEPC.csv")
    print(f"  T001={len(t001)}  TKA02={len(tka02)}  CEPC={len(cepc)}")

    # ── CompanyCodes ─────────────────────────────────────────────────────────
    # TKA02: bukrs → kokrs. Verify 1 CC chỉ thuộc 1 controlling area.
    cc2ko = {}
    for r in tka02:
        bukrs = r["Company Code"].strip()
        kokrs = r["Controlling Area"].strip()
        if not bukrs:
            continue
        if bukrs in cc2ko and cc2ko[bukrs] != kokrs:
            print(f"  ! CC {bukrs} thuộc nhiều controlling area: "
                  f"{cc2ko[bukrs]} vs {kokrs}")
        cc2ko[bukrs] = kokrs

    companies = []
    for r in t001:
        code = r["Company Code"].strip()
        if not code:
            continue
        companies.append({
            "code": code,
            "name": r["Company Name"].strip(),
            "city": r["City"].strip(),
            "country": r["Country/Region Key"].strip(),
            "currency": r["Currency"].strip(),
            "controllingArea": cc2ko.get(code, ""),
        })
    companies.sort(key=lambda x: x["code"])
    known_cc = {c["code"] for c in companies}

    # ── ProfitCenters ────────────────────────────────────────────────────────
    active = [r for r in cepc if r["Valid To"].strip().startswith(ACTIVE_UNTIL)]
    print(f"  CEPC: {len(active)}/{len(cepc)} dòng đang hiệu lực (datbi=9999-12-31)")

    # Đối chiếu 2 nguồn: khinr (chính) vs kokrs→CC (kiểm chứng)
    ko2cc = defaultdict(set)
    for cc, ko in cc2ko.items():
        ko2cc[ko].add(cc)

    pcs, seen = [], {}
    orphan, dup, conflict, ambiguous = [], [], [], 0
    for r in active:
        code = r["Profit Center"].strip()
        if not code:
            continue
        khinr = r["Hierarchy Area"].strip()
        kokrs = r["Controlling Area"].strip()

        if code in seen:
            dup.append(code)
            continue
        seen[code] = True

        # khinr phải là company code hợp lệ, nếu không → để NULL (không đoán)
        cc = khinr if khinr in known_cc else ""
        if khinr and not cc:
            orphan.append((code, khinr))

        # kiểm chứng chéo: CC suy từ khinr có nằm trong nhóm CC của kokrs không
        cands = ko2cc.get(kokrs, set())
        if len(cands) > 1:
            ambiguous += 1
        if cc and cands and cc not in cands:
            conflict.append((code, cc, kokrs, sorted(cands)))

        pcs.append({
            "code": code,
            "name": (r["Name"] or "").strip()[:120],
            "companyCode_code": cc,
            "controllingArea": kokrs,
        })
    pcs.sort(key=lambda x: x["code"])

    # ── AdminFinanceRole ─────────────────────────────────────────────────────
    # Bảng-first: role định nghĩa TRƯỚC, dev code @requires theo roleId này.
    roles = [
        {"roleId": "AppAdmin", "status": "ACTIVE",
         "description": "Quản trị phân quyền (app Manage-Role)",
         "note": "Bootstrap từ BTP Role Collection, KHÔNG gán qua bảng này. "
                 "Xem xs-security.json. Chỉ 1-2 người."},
        {"roleId": "FIN_APP_ADMIN", "status": "ACTIVE",
         "description": "Quản trị app Payment Approval",
         "note": "Ví dụ bảng-first: định nghĩa trước, dev Payment Approval "
                 "code @requires:'FIN_APP_ADMIN' theo roleId này."},
        {"roleId": "FIN_APPROVE_L2", "status": "ACTIVE",
         "description": "Duyệt payment cấp 2",
         "note": "Duyệt payment > 500tr. Chỉ trưởng phòng TC trở lên. "
                 "KHÔNG gán cho nhân viên."},
        {"roleId": "FIN_VIEWER", "status": "DRAFT",
         "description": "Xem báo cáo tài chính (chỉ đọc)",
         "note": "Đang chờ dev implement. DRAFT ⇒ chưa cho gán — "
                 "minh hoạ quy trình bảng-first."},
    ]

    # ── AuthzConfig (singleton) ──────────────────────────────────────────────
    cfg = [{"ID": "1", "appManagedAuthz": "true",
            "lastChangedNote": "Khoi tao: che do app-managed"}]

    # ── UserRoles: gán role mẫu (function scope) ────────────────────────────
    # userId = SCIM ID từ IAS ⇒ importUsers() sau này UPSERT khớp, không tạo trùng.
    # AppUsers seed ở db/data/cisd3.authz-AppUsers.csv — file này KHÔNG commit
    # (chứa PII thật), xem cisd3.authz-AppUsers.csv.example để biết format.
    # UUID dưới đây là MẪU. Chạy thật thì thay bằng SCIM ID từ IAS tenant của bạn.
    U_USER1 = "00000000-0000-4000-8000-000000000001"
    U_USER2 = "00000000-0000-4000-8000-000000000002"
    U_USER3 = "00000000-0000-4000-8000-000000000003"
    U_USER4 = "00000000-0000-4000-8000-000000000004"
    user_roles = [
        # user1: quản trị Payment Approval
        {"user_userId": U_USER1, "role_roleId": "FIN_APP_ADMIN"},
        # user3: duyệt cấp 2 (đa company code GB14+FR16)
        {"user_userId": U_USER3, "role_roleId": "FIN_APPROVE_L2"},
        # user2: có org GB14 nhưng KHÔNG role ⇒ thấy data, không gọi được action
        # user4: org US50, không role
        # user5, user6: KHÔNG role, KHÔNG org ⇒ default-deny (case 5)
    ]

    print("\nGhi seed vào db/data/ ...")
    write("CompanyCodes",
          ["code", "name", "city", "country", "currency", "controllingArea"],
          companies)
    write("ProfitCenters",
          ["code", "name", "companyCode_code", "controllingArea"], pcs)
    write("AdminFinanceRole",
          ["roleId", "description", "note", "status"], roles)
    write("AuthzConfig", ["ID", "appManagedAuthz", "lastChangedNote"], cfg)
    write("UserRoles", ["user_userId", "role_roleId"], user_roles)

    # ── Báo cáo chất lượng ───────────────────────────────────────────────────
    linked = sum(1 for p in pcs if p["companyCode_code"])
    print("\n── Kiểm tra chất lượng ──")
    print(f"  PC có companyCode : {linked}/{len(pcs)}")
    print(f"  PC mơ hồ nếu đi qua TKA02 : {ambiguous}/{len(pcs)}"
          f"  (lý do dùng khinr làm nguồn chính)")
    if orphan:
        print(f"  ! {len(orphan)} PC có khinr KHÔNG khớp company code nào "
              f"→ để NULL: {orphan[:5]}")
    if dup:
        print(f"  ! {len(dup)} mã PC trùng (đã bỏ bản sau): {dup[:5]}")
    if conflict:
        print(f"  ! {len(conflict)} PC LỆCH giữa khinr và controlling area:")
        for c in conflict[:5]:
            print(f"      PC={c[0]} khinr→{c[1]} nhưng kokrs {c[2]} thuộc {c[3]}")
    else:
        print("  ✓ Không có PC nào lệch giữa khinr và controlling area")

    gb14 = [p for p in pcs if p["companyCode_code"] == "GB14"]
    print(f"  GB14: {len(gb14)} profit center")
    if not gb14:
        print("  ! GB14 không có PC nào — kiểm tra lại nguồn data")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
