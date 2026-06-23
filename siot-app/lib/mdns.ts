// mDNS 광고 모듈 — server-only.
// LAN 멀티캐스트로 이 게이트웨이를 _siot._tcp 서비스로 알린다.
// mDNS 실패는 서버를 죽이지 않는다 — try/catch로 완전히 격리.
//
// 주의: mDNS 멀티캐스트가 LAN에 닿으려면 애드온이 host_network 여야 함(config.yaml).
// host_network: true 가 없으면 컨테이너 내부 네트워크에만 전파되어 다른 장치에서 발견 불가.
import "server-only";
// 정적 import — Next standalone 파일 트레이서가 bonjour-service와 그 의존성을
// 자동으로 추적해 .next/standalone에 포함시키도록 한다(동적 import는 누락됨).
import { Bonjour } from "bonjour-service";
import { getOrCreateGatewayId } from "./gateway-identity";

// 중복 시작 방지 플래그 — 모듈은 한 번만 로드되므로 프로세스 수명 동안 유지된다.
let started = false;

/**
 * mDNS 서비스를 광고한다.
 * - 이미 시작됐으면 즉시 반환(중복 방지).
 * - 어떤 이유로든 실패해도 throw하지 않는다(서버 안정성 최우선).
 * - 광고 이름: siot-{gatewayId 앞 8자}, 타입: _siot._tcp, 포트: PORT 환경변수 또는 3000.
 */
export async function startMdnsAdvertisement(): Promise<void> {
  // 이미 광고 중이면 재시작하지 않는다.
  if (started) return;

  try {
    // 게이트웨이 고유 ID 취득 (없으면 새로 생성·저장됨).
    const gatewayId = await getOrCreateGatewayId();

    const port = Number(process.env.PORT ?? 3000);

    // _siot._tcp 로 LAN에 광고. txt 레코드에 id·app을 실어 발견 즉시 식별 가능하게 한다.
    new Bonjour().publish({
      name: `siot-${gatewayId.slice(3, 11)}`,
      type: "siot",
      port,
      txt: { id: gatewayId, app: "siot-gateway" },
    });

    started = true;
    console.log(
      `[mdns] mDNS 광고 시작: _siot._tcp 포트=${port} gatewayId=${gatewayId}`,
    );
  } catch (err) {
    // mDNS 실패는 게이트웨이 운영에 치명적이지 않으므로 로그만 남기고 계속.
    console.warn(
      "[mdns] mDNS 광고 실패 (무시, 서버 계속 실행):",
      err instanceof Error ? err.message : String(err),
    );
  }
}
