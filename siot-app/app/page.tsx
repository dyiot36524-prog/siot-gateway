// 시옷앱 메인 화면 — 기기 목록·제어를 시옷 브랜딩으로 표시. (단계 4)
// HA "Home Assistant" 흔적 없음. 사용자는 시옷앱 UI만 본다.
import Image from "next/image";
import { DeviceGrid } from "@/components/device-grid";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <h1 className="sr-only">시옷앱 게이트웨이</h1>
      <header className="mb-8 flex items-center gap-3">
        {/* 테두리 없이 로고만. 다크모드에선 흰 버전 로고로 자동 교체. */}
        <Image
          src="/logo.png"
          alt="AIOT 게이트웨이"
          width={2240}
          height={828}
          priority
          className="h-8 w-auto dark:hidden"
        />
        <Image
          src="/logo-light.png"
          alt="AIOT 게이트웨이"
          width={2240}
          height={828}
          priority
          className="hidden h-8 w-auto dark:block"
        />
        <p className="text-sm font-medium text-black/50 dark:text-white/40">
          게이트웨이
        </p>
      </header>

      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-black/40 dark:text-white/40">
          내 기기
        </h2>
        <DeviceGrid />
      </section>
    </main>
  );
}
