import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "시옷앱 — 게이트웨이",
  description: "시옷앱: 현장 기기를 페어링·제어하는 게이트웨이",
};

// 테마 색상을 시옷 브랜드 주황(#f5a21c)으로 지정 (PWA/브라우저 UI 색).
export const viewport = {
  themeColor: "#f5a21c",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* suppressHydrationWarning: 브라우저 확장(ColorZilla 등)이 <body>에
          cz-shortcut-listen 같은 속성을 주입해 생기는 무해한 하이드레이션 경고 억제. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {/* 하단 탭바 높이(pb-20)만큼 패딩 — 고정 탭바에 콘텐츠가 가려지지 않도록. */}
        <div className="flex-1 pb-20">{children}</div>
        <Nav />
      </body>
    </html>
  );
}
