// 기기 추가(페어링) 페이지 — 서버 컴포넌트. (모바일 우선)
import Link from "next/link";
import { PairingFlow } from "@/components/pairing-flow";

export default function PairingPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8">
      {/* 홈으로 돌아가는 링크 */}
      <Link
        href="/"
        className="inline-block text-sm text-black/50 hover:text-black/80 dark:text-white/40 dark:hover:text-white/70 mb-6"
      >
        ← 홈
      </Link>

      {/* 헤더 */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold">기기 추가</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/40">
          새 기기를 시옷앱에 페어링합니다
        </p>
      </div>

      {/* 페어링 플로우 (클라이언트 컴포넌트) */}
      <PairingFlow />
    </main>
  );
}
