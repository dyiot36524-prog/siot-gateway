"use client";

// 하단 고정 탭바 네비게이션 — 모바일 우선, 데스크탑에서도 자연스럽게 표시.
import Link from "next/link";
import { usePathname } from "next/navigation";

// 탭 정의: 아이콘 이모지, 라벨, 경로.
const TABS = [
  { icon: "🏠", label: "홈", href: "/" },
  { icon: "➕", label: "기기추가", href: "/pairing" },
  { icon: "🔗", label: "연결", href: "/connect" },
] as const;

export function Nav() {
  const pathname = usePathname();

  return (
    // 화면 하단 고정 — 안전 영역(pb-safe) 포함, 반투명 배경 + 블러 처리.
    <nav
      className="fixed bottom-0 inset-x-0 z-10
        border-t border-black/10 dark:border-white/10
        bg-white/90 dark:bg-black/80 backdrop-blur
        pb-safe"
    >
      <ul className="flex">
        {TABS.map(({ icon, label, href }) => {
          // 홈 탭은 정확히 "/" 일 때만 활성, 나머지는 경로 시작 일치.
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);

          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                className={`flex flex-col items-center justify-center gap-0.5 py-2.5 text-center transition
                  ${active
                    ? "text-emerald-500"
                    : "text-black/50 dark:text-white/50"
                  }`}
              >
                {/* 탭 아이콘 */}
                <span className="text-xl leading-none">{icon}</span>
                {/* 탭 라벨 */}
                <span className="text-xs font-medium">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
