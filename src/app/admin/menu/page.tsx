import { requireAdminUser } from "@/lib/admin-guard";
import Link from "next/link";

const menuItems = [
  { label: "希望シフト管理", href: "/admin/shifts" },
  { label: "ギフト管理", href: "/admin/gifts" },
  { label: "来店ガチャ設定", href: "/admin/visit-gacha" },
  { label: "会員設定", href: "/admin/member-settings" },
  { label: "口コミパスワード", href: "/admin/review-password" },
  { label: "会員登録アンケート", href: "/admin/survey-settings" },
  { label: "QRコードを印刷", href: "/admin/print-qr" },
];

export default async function AdminMenuPage() {
  await requireAdminUser();

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-bold">メニュー</h1>
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {menuItems.map((item) => (
          <Link
            key={item.label}
            href={item.href}
            className="rounded-xl border border-[#dbe2ea] bg-white px-4 py-4 text-left font-semibold text-[#0f172a] shadow-sm"
          >
            {item.label}
          </Link>
        ))}
      </section>
    </div>
  );
}
