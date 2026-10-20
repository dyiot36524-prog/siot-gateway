// `--mode mock` 미리보기: window.fetch 를 msw 핸들러로 돌려 app-v1 을 흉내 내고 페어링을 타이머로 진행한다.
// 서비스 워커를 쓰지 않아 웹뷰·http 에서도 동작하고 PWA 워커와 부딪히지 않는다.
// 로그인: gisa@siot.dev / siot-demo-1234. 라벨: siot-3f9a2c71 + 9C2E-41AB-77D0-5E18 (QR 도 같은 값).
import { getResponse } from 'msw';
import { db } from './db';
import { handlers } from './handlers';

export async function startMockWorker() {
  db.auto = true;
  // 목 DB 는 새로고침마다 초기화되므로 지난 페어링 기록도 지운다
  for (const k of Object.keys(localStorage)) if (k.startsWith('siot.')) localStorage.removeItem(k);
  db.addUser('gisa@siot.dev', 'siot-demo-1234');
  const site = db.addSite('101동 1203호', { address: '서울 성동구 왕십리로 50' });
  db.addSite('102동 804호', { handedOver: true, ownerUserId: 'usr_01JZ0000000000000000000099' });
  const a = db.addGateway(site.siteId, '7c41e0b2');
  db.addDevice(a.gatewayId, '거실 플러그', { room: '거실' });
  db.addLabel('7c41e0b2', '0000000000000000');
  db.addLabel('3f9a2c71', '9c2e41ab77d05e18');
  db.addLabel('b0d5e811', 'aaaa1111bbbb2222', { orgId: 'org_01JZ0000000000000000000002' });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    return (await getResponse(handlers, request)) ?? realFetch(input, init);
  };
}
