"use client";

// 하단 고정 탭바 네비게이션 — 모바일 우선, 데스크탑에서도 자연스럽게 표시.
// 아이콘은 SVG(라인 아이콘). 이모지는 쓰지 않는다.
import Link from "next/link";
import { usePathname } from "next/navigation";

type IconProps = { className?: string };

// 공용 SVG 래퍼 — 색은 currentColor를 따라가므로 활성 탭 색이 그대로 적용된다.
function Svg({
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function HomeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </Svg>
  );
}

function AddIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8.5v7M8.5 12h7" />
    </Svg>
  );
}

function LinkIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10 13a5 5 0 0 0 7.07 0l2.5-2.5a5 5 0 1 0-7.07-7.07L11 5" />
      <path d="M14 11a5 5 0 0 0-7.07 0L4.43 13.5a5 5 0 1 0 7.07 7.07L13 19" />
    </Svg>
  );
}

const TABS = [
  { Icon: HomeIcon, label: "홈", href: "/" },
  { Icon: AddIcon, label: "기기추가", href: "/pairing" },
  { Icon: LinkIcon, label: "연결", href: "/connect" },
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
        {TABS.map(({ Icon, label, href }) => {
          // 홈 탭은 정확히 "/" 일 때만 활성, 나머지는 경로 시작 일치.
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);

          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                className={`flex flex-col items-center justify-center gap-1 py-2.5 text-center transition
                  ${active
                    ? "text-siot-500"
                    : "text-black/50 dark:text-white/50"
                  }`}
              >
                <Icon className="h-6 w-6" />
                <span className="text-xs font-medium">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
