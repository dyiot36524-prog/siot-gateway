// Next.js 계측(instrumentation) 진입점.
// 서버가 시작될 때 Next.js가 이 파일을 딱 한 번 실행한다(앱 라우터 기준).
// Edge 런타임에서는 실행되지 않으므로 NEXT_RUNTIME 가드로 Node.js 전용 코드를 격리한다.
// 참고: https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation

export async function register() {
  // Node.js 런타임에서만 실행 — Edge(Workers) 환경에서는 건너뜀.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // mDNS 광고 시작: 실패해도 서버를 죽이지 않는다(내부에서 try/catch 처리).
    const { startMdnsAdvertisement } = await import("./lib/mdns");
    await startMdnsAdvertisement();
  }
}
