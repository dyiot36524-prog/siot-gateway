// 시옷앱 메인 화면 — 기기 목록·제어를 시옷 브랜딩으로 표시. (단계 4)
// HA "Home Assistant" 흔적 없음. 사용자는 시옷앱 UI만 본다.
import { DeviceGrid } from "@/components/device-grid";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <header className="mb-8 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500 text-2xl font-black text-white shadow-sm">
          ㅅ
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">시옷앱</h1>
          <p className="text-sm text-black/50 dark:text-white/40">게이트웨이</p>
        </div>
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
