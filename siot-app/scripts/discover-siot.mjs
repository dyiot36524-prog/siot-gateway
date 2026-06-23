// 시옷 게이트웨이 mDNS 발견 도구.
// LAN에 광고 중인 _siot._tcp 서비스를 찾아 gatewayId·IP·포트를 출력한다.
// 실행: node scripts/discover-siot.mjs   (기본 8초 탐색)
import { Bonjour } from "bonjour-service";

const SECONDS = Number(process.argv[2] ?? 8);
// 인터페이스가 여러 개인 PC는 특정 IP에 고정해야 mDNS를 제대로 받는다.
// 예: node scripts/discover-siot.mjs 10 192.168.0.25
const IFACE = process.argv[3];
const bonjour = new Bonjour(IFACE ? { interface: IFACE } : undefined);
if (IFACE) console.log(`인터페이스 고정: ${IFACE}`);
const found = new Map();

console.log(`_siot._tcp 서비스 탐색 중... (${SECONDS}초)`);

const browser = bonjour.find({ type: "siot" }, (service) => {
  const id = service.txt?.id ?? "(없음)";
  if (found.has(id)) return;
  found.set(id, true);
  console.log("──────────────────────────────");
  console.log("발견:", service.name);
  console.log("  gatewayId:", id);
  console.log("  host     :", service.host);
  console.log("  IP       :", (service.addresses ?? []).join(", "));
  console.log("  port     :", service.port);
  console.log("  txt      :", JSON.stringify(service.txt));
});

setTimeout(() => {
  browser.stop();
  bonjour.destroy();
  console.log("──────────────────────────────");
  console.log(`탐색 종료 — 발견된 게이트웨이: ${found.size}개`);
  process.exit(0);
}, SECONDS * 1000);
