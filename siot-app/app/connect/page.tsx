// 게이트웨이 연결 페이지 (서버 컴포넌트)
import Link from "next/link";
import { GatewayConnect } from "@/components/gateway-connect";

export default function ConnectPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8">
      {/* 홈 링크 */}
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-black/50 transition hover:text-black/80 dark:text-white/40 dark:hover:text-white/70"
      >
        ← 홈
      </Link>

      {/* 헤더 */}
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">게이트웨이 연결</h1>
        <p className="mt-1 text-sm text-black/50 dark:text-white/40">
          이 게이트웨이를 시옷플랫폼에 등록합니다
        </p>
      </header>

      {/* 연결 코드 생성 UI */}
      <GatewayConnect />
    </main>
  );
}
