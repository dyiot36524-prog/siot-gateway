// 기사 화면 흐름(E1·E2·E3·C3 ④ 단위 수준). 백엔드는 app-v1 계약을 흉내 낸 msw 목.
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { db, gwUuid, OTHER_ORG } from './mocks/db';
import { EMAIL, PASSWORD, renderApp, screen, waitForStream } from './test/helpers';
import { server } from './test/setup';

function seedSite(opts: { handedOver?: boolean; gws?: string[] } = {}) {
  const site = db.addSite('101동 1203호', { handedOver: !!opts.handedOver, ownerUserId: opts.handedOver ? 'usr_01JZ0000000000000000000099' : null });
  const gws = (opts.gws ?? ['aaaa0001', 'bbbb0002']).map((s) => db.addGateway(site.siteId, s));
  return { site, gws };
}

const pairingPosts = (gatewayId: string) => db.requests.filter((r) => r.method === 'POST' && r.path === `/app/v1/gateways/${gatewayId}/pairing`);

describe('로그인·세션', () => {
  it('로그인하면 세대 목록으로 간다', async () => {
    const { user } = renderApp('/', { login: false });
    await user.type(await screen.findByLabelText('이메일'), EMAIL);
    await user.type(screen.getByLabelText('비밀번호'), PASSWORD);
    await user.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('heading', { name: '세대' })).toBeInTheDocument();
    expect(location.pathname).toBe('/sites');
  });

  it('비밀번호가 틀리면 문구를 보여주고 머문다', async () => {
    const { user } = renderApp('/', { login: false });
    await user.type(await screen.findByLabelText('이메일'), EMAIL);
    await user.type(screen.getByLabelText('비밀번호'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('이메일 또는 비밀번호가 맞지 않습니다.');
    expect(location.pathname).toBe('/login');
  });

  it('세션 없음(401)이면 로그인 후 원래 화면(라벨 딥링크 포함)으로 돌아간다', async () => {
    const { site } = seedSite();
    db.addLabel('cccc0003', '1111222233334444');
    const gw = gwUuid('cccc0003');
    const { user } = renderApp(`/g/${gw}#1111-2222-3333-4444`, { login: false });
    await user.type(await screen.findByLabelText('이메일'), EMAIL);
    await user.type(screen.getByLabelText('비밀번호'), PASSWORD);
    await user.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText(/어느 세대에 연결할까요/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /101동 1203호/ }));
    expect(await screen.findByText('siot-cccc0003 연결됨')).toBeInTheDocument();
    expect(db.gateways.find((g) => g.gatewayId === gw)?.siteId).toBe(site.siteId);
  });

  it('네트워크 오류는 로그아웃하지 않고 오프라인 배지만 띄운다', async () => {
    // 앱을 새로 띄운 상황: 캐시된 사용자 + 서버에 닿지 않음
    const u = db.addUser(EMAIL, PASSWORD);
    localStorage.setItem('siot.me', JSON.stringify(u.me));
    server.use(
      http.get('/app/v1/me', () => HttpResponse.error()),
      http.get('/app/v1/sites', () => HttpResponse.error()),
    );
    renderApp('/sites');
    expect((await screen.findAllByText('오프라인 · 인터넷 연결을 기다리는 중')).length).toBeGreaterThan(0);
    expect(location.pathname).toBe('/sites');
    expect(screen.queryByLabelText('비밀번호')).not.toBeInTheDocument();
  });

  it('사용 중 세션이 만료되면(401) 로그인 화면으로 간다', async () => {
    const { site } = seedSite();
    renderApp(`/sites/${site.siteId}`);
    await waitForStream(site.siteId);
    db.session = null;
    db.dropStreams(site.siteId);
    expect(await screen.findByLabelText('비밀번호')).toBeInTheDocument();
    expect(location.pathname).toBe('/login');
  });

  it('로그아웃', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user } = renderApp('/sites');
    await user.click(await screen.findByRole('button', { name: '로그아웃' }));
    expect(await screen.findByLabelText('비밀번호')).toBeInTheDocument();
    expect(db.session).toBeNull();
  });
});

describe('역할별 라우트 (E1)', () => {
  it('거주자가 기사 화면을 열면 /forbidden', async () => {
    db.addUser('home@siot.dev', 'password-123', 'resident', null);
    db.session = 'home@siot.dev';
    renderApp('/sites', { login: false });
    expect(await screen.findByRole('heading', { name: '권한 없음' })).toBeInTheDocument();
    expect(location.pathname).toBe('/forbidden');
  });
  it('운영자는 / 에서 운영 자리로 간다', async () => {
    db.addUser('ops@siot.dev', 'password-123', 'operator', null);
    db.session = 'ops@siot.dev';
    renderApp('/', { login: false });
    expect(await screen.findByRole('heading', { name: '운영' })).toBeInTheDocument();
  });
});

describe('세대 생성', () => {
  it('이름·주소로 만들고 세대 화면으로 간다', async () => {
    const { user } = renderApp('/sites');
    await user.click(await screen.findByRole('button', { name: '+ 새 세대 만들기' }));
    await user.type(screen.getByLabelText('세대 이름'), '103동 702호');
    await user.type(screen.getByLabelText('주소 (선택)'), '서울 성동구');
    await user.click(screen.getByRole('button', { name: '만들기' }));
    expect(await screen.findByRole('heading', { name: '103동 702호' })).toBeInTheDocument();
    expect(db.sites).toHaveLength(1);
    expect(db.sites[0]).toMatchObject({ name: '103동 702호', address: '서울 성동구' });
    expect(screen.getByText(/아직 게이트웨이가 없습니다/)).toBeInTheDocument();
  });
});

describe('GW 바인딩 수동 입력과 오류 문구 (B2)', () => {
  async function claimManually(short: string, code: string) {
    const site = db.sites[0] ?? db.addSite('101동 1203호');
    const { user } = renderApp(`/sites/${site.siteId}/gateways/add`);
    await user.type(await screen.findByLabelText(/게이트웨이 이름/), `siot-${short}`);
    await user.type(screen.getByLabelText(/라벨 코드 16자/), code);
    await user.click(screen.getByRole('button', { name: '연결' }));
    return { site, user };
  }

  it('성공하면 연결됨 + 세대에 GW 가 붙는다', async () => {
    db.addLabel('3f9a2c71', '9c2e41ab77d05e18');
    const { site } = await claimManually('3f9a2c71', '9C2E41AB77D05E18');
    expect(await screen.findByText('siot-3f9a2c71 연결됨')).toBeInTheDocument();
    expect(db.requests.find((r) => r.path === '/app/v1/gateways/claim')?.body).toEqual({
      shortId: '3f9a2c71',
      claimSecret: '9c2e41ab77d05e18',
      siteId: site.siteId,
    });
    expect(db.gateways.find((g) => g.shortId === '3f9a2c71')?.siteId).toBe(site.siteId);
  });

  it('형식이 틀리면 보내지 않는다', async () => {
    await claimManually('3f9a2c7', '9C2E41AB');
    expect(await screen.findByText('8자리(0-9, a-f)를 입력하세요.')).toBeInTheDocument();
    expect(screen.getByText('4-4-4-4 형식 16자를 입력하세요.')).toBeInTheDocument();
    expect(db.requests.some((r) => r.path === '/app/v1/gateways/claim')).toBe(false);
  });

  it.each([
    ['400 INVALID_CLAIM_SECRET', () => db.addLabel('d0000001', 'ffffffffffffffff'), 'd0000001', '라벨 코드가 맞지 않습니다'],
    [
      '409 GATEWAY_ALREADY_BOUND',
      () => {
        db.addLabel('d0000002', '1111222233334444');
        db.addGateway(db.addSite('다른 세대').siteId, 'd0000002');
      },
      'd0000002',
      '이미 다른 세대에 연결된 게이트웨이',
    ],
    ['409 GATEWAY_NOT_PROVISIONED', () => db.addLabel('d0000003', '1111222233334444', { provisioned: false }), 'd0000003', '출고 등록되지 않은 게이트웨이'],
    ['403 GATEWAY_ORG_MISMATCH', () => db.addLabel('d0000004', '1111222233334444', { orgId: OTHER_ORG }), 'd0000004', '다른 업체에 출고된 게이트웨이'],
    ['423 CLAIM_WINDOW_CLOSED', () => db.addLabel('d0000005', '1111222233334444', { claimWindowClosed: true }), 'd0000005', '연결 가능 시간 지남'],
  ])('%s → 문구 + 다시 시도', async (_name, setup, short, title) => {
    db.addSite('101동 1203호');
    setup();
    const { user } = await claimManually(short, '1111-2222-3333-4444');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(title);
    const before = db.requests.filter((r) => r.path === '/app/v1/gateways/claim').length;
    await user.click(within(alert).getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(db.requests.filter((r) => r.path === '/app/v1/gateways/claim').length).toBe(before + 1));
  });
});

describe('페어링 큐 (GW 별 직렬·GW 끼리 병렬, E2)', () => {
  async function addCode(user: ReturnType<typeof renderApp>['user'], code: string) {
    const input = screen.getByLabelText('기기 코드');
    await user.clear(input);
    await user.type(input, code);
    await user.click(screen.getByRole('button', { name: '추가' }));
  }
  const queue = (letter: string) => screen.getByRole('region', { name: `GW ${letter} 대기열` });

  it('연속 입력하면 대기 적은 GW 로 나눠 넣고 두 GW 진행을 동시에 보여준다', async () => {
    const { site, gws } = seedSite();
    const [a, b] = gws as [(typeof gws)[0], (typeof gws)[0]];
    const { user } = renderApp(`/sites/${site.siteId}/pairing`);
    await waitForStream(site.siteId);
    await screen.findByRole('region', { name: 'GW A 대기열' });

    await addCode(user, '3497-011-2332');
    expect(await screen.findByText('GW A 대기열에 추가했습니다 (…2332).')).toBeInTheDocument();
    await addCode(user, '749701123365521327694');
    expect(await screen.findByText('GW B 대기열에 추가했습니다 (…7694).')).toBeInTheDocument();
    expect(pairingPosts(a.gatewayId)).toHaveLength(1);
    expect(pairingPosts(b.gatewayId)).toHaveLength(1);

    const [pa, pb] = db.pairings;
    act(() => {
      db.updatePairing(pa!.pairingSessionId, { status: 'running', stage: 'commissioning' });
      db.updatePairing(pb!.pairingSessionId, { status: 'running', stage: 'interviewing' });
    });
    expect(await within(queue('A')).findByText('기기 연결 중 (BLE·인증)')).toBeInTheDocument();
    expect(await within(queue('B')).findByText('기기 정보 읽는 중')).toBeInTheDocument();

    act(() => db.updatePairing(pb!.pairingSessionId, { status: 'done', stage: 'done' }));
    expect(await within(queue('B')).findByText('완료')).toBeInTheDocument();
    expect(within(queue('A')).getByText('기기 연결 중 (BLE·인증)')).toBeInTheDocument();
  });

  it('렌더 전에 연달아 들어온 코드도 두 GW 로 나눈다(빠른 연속 스캔)', async () => {
    const { site, gws } = seedSite();
    renderApp(`/sites/${site.siteId}/pairing`);
    await waitForStream(site.siteId);
    const input = await screen.findByLabelText('기기 코드');
    const form = screen.getByRole('form', { name: '코드 직접 입력' });
    act(() => {
      fireEvent.change(input, { target: { value: '34970112332' } });
      fireEvent.submit(form);
      fireEvent.change(input, { target: { value: '34970112340' } });
      fireEvent.submit(form);
    });
    await waitFor(() => expect(pairingPosts(gws[0]!.gatewayId)).toHaveLength(1));
    await waitFor(() => expect(pairingPosts(gws[1]!.gatewayId)).toHaveLength(1));
  });

  it('같은 GW 에 넣으면 직렬 대기 순서를 보여준다', async () => {
    const { site } = seedSite();
    const { user } = renderApp(`/sites/${site.siteId}/pairing`);
    await waitForStream(site.siteId);
    await user.click(await screen.findByRole('radio', { name: 'GW A' }));
    await addCode(user, '34970112332');
    await addCode(user, '34970112349');
    expect(await within(queue('A')).findByText('대기 중 · 앞에 1개')).toBeInTheDocument();
    expect(within(queue('B')).getByText('아직 없음')).toBeInTheDocument();
  });

  it('같은 코드를 두 번 넣지 않는다', async () => {
    const { site } = seedSite();
    const { user } = renderApp(`/sites/${site.siteId}/pairing`);
    await waitForStream(site.siteId);
    await screen.findByRole('region', { name: 'GW A 대기열' });
    await addCode(user, '34970112332');
    await screen.findByText(/GW A 대기열에 추가했습니다/);
    await addCode(user, '3497 011 2332');
    expect(await screen.findByText(/이미 GW A 대기열에 있는 코드입니다/)).toBeInTheDocument();
    expect(db.pairings).toHaveLength(1);
  });

  it('기기 코드가 아니면 안내한다', async () => {
    const { site } = seedSite();
    const { user } = renderApp(`/sites/${site.siteId}/pairing`);
    await screen.findByRole('region', { name: 'GW A 대기열' });
    await addCode(user, '12345');
    expect(await screen.findByRole('alert')).toHaveTextContent('기기 코드가 아닙니다');
  });

  it.each([
    ['CODE_INVALID', '코드 오류'],
    ['DEVICE_NOT_FOUND', '기기 안 잡힘'],
    ['THREAD_NOT_READY', 'Thread 미설정'],
    ['ATTESTATION_REJECTED', '인증 거부'],
    ['UNKNOWN', '기타 오류'],
  ])('실패 %s → "%s" + 재시도는 같은 GW 에 같은 코드로 다시 넣는다', async (errorCode, title) => {
    const { site, gws } = seedSite();
    const a = gws[0]!;
    const { user } = renderApp(`/sites/${site.siteId}/pairing`);
    await waitForStream(site.siteId);
    await screen.findByRole('region', { name: 'GW A 대기열' });
    await addCode(user, 'MT:Y.K9042C00KA0648G00');
    await screen.findByText(/GW A 대기열에 추가했습니다/);
    act(() => db.updatePairing(db.pairings[0]!.pairingSessionId, { status: 'failed', stage: 'failed', errorCode, error: 'boom' }));
    const alert = await within(queue('A')).findByRole('alert');
    expect(alert).toHaveTextContent(title);
    await user.click(within(alert).getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(pairingPosts(a.gatewayId)).toHaveLength(2));
    expect(pairingPosts(a.gatewayId)[1]!.body).toEqual({ code: 'MT:Y.K9042C00KA0648G00' });
    expect(await within(queue('A')).findByText('2번째 시도')).toBeInTheDocument();
  });

  it('대기 중 입력한 이름·위치를 완료 시 기기에 반영한다', async () => {
    const { site } = seedSite();
    const { user } = renderApp(`/sites/${site.siteId}/pairing`);
    await waitForStream(site.siteId);
    await screen.findByRole('region', { name: 'GW A 대기열' });
    await addCode(user, '34970112332');
    await screen.findByText(/GW A 대기열에 추가했습니다/);
    await user.click(within(queue('A')).getByRole('button', { name: '이름·위치 미리 입력' }));
    await user.type(within(queue('A')).getByLabelText('이름'), '현관 도어');
    await user.click(within(queue('A')).getByRole('button', { name: '현관' }));
    await user.click(within(queue('A')).getByRole('button', { name: '완료되면 적용' }));
    expect(await within(queue('A')).findByText('현관 도어 · 현관')).toBeInTheDocument();

    act(() => db.updatePairing(db.pairings[0]!.pairingSessionId, { status: 'done', stage: 'done' }));
    await waitFor(() => expect(db.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ name: '현관 도어', room: '현관' }));
    expect(db.devices.at(-1)).toMatchObject({ name: '현관 도어', room: '현관' });
  });

  it('서버에 없는 페어링 세션(404)은 다시 시도할 수 있게 풀어 준다', async () => {
    const { site, gws } = seedSite();
    localStorage.setItem(
      `siot.pairing.${site.siteId}`,
      JSON.stringify([
        { localId: 'x', gatewayId: gws[0]!.gatewayId, code: '34970112332', name: '', room: null, sessionId: 'pair_01JZ0000000000000000000ZZZ'.slice(0, 31), attempts: 1, applied: false, enqueueError: null, createdAt: 0 },
      ]),
    );
    const { user } = renderApp(`/sites/${site.siteId}/pairing`);
    const alert = await within(await screen.findByRole('region', { name: 'GW A 대기열' })).findByRole('alert');
    expect(alert).toHaveTextContent('페어링 기록을 찾을 수 없습니다');
    await user.click(within(alert).getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(pairingPosts(gws[0]!.gatewayId)).toHaveLength(1));
  });

  it('SSE 가 끊겨도 진행 상태를 폴링으로 따라간다', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { site } = seedSite();
      const { user } = renderApp(`/sites/${site.siteId}/pairing`, { backoffMs: [60_000] });
      await waitForStream(site.siteId);
      await screen.findByRole('region', { name: 'GW A 대기열' });
      await addCode(user, '34970112332');
      await screen.findByText(/GW A 대기열에 추가했습니다/);
      db.dropStreams(site.siteId);
      expect(await screen.findByText('실시간 연결 끊김 · 다시 연결 중')).toBeInTheDocument();
      db.updatePairing(db.pairings[0]!.pairingSessionId, { status: 'running', stage: 'interviewing' }); // 이벤트는 못 받음
      await act(() => vi.advanceTimersByTimeAsync(4500));
      expect(await within(queue('A')).findByText('기기 정보 읽는 중')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('전체 정상 체커 (E3)', () => {
  it('인계 전에는 "인계 미완료" 빨강', async () => {
    const { site, gws } = seedSite();
    db.addDevice(gws[0]!.gatewayId, '거실 플러그');
    renderApp(`/sites/${site.siteId}/check`);
    await waitForStream(site.siteId);
    expect(await screen.findByText('확인 필요')).toBeInTheDocument();
    expect(screen.getAllByText('인계 미완료').length).toBeGreaterThan(0);
    expect(screen.getByText('GW A (siot-aaaa0001) 온라인')).toBeInTheDocument();
    expect(screen.getByText('거실 플러그 온라인')).toBeInTheDocument();
  });

  it('GW B 가 꺼지면 "GW B 오프라인", 복구되면 다시 온라인', async () => {
    const { site, gws } = seedSite();
    db.addDevice(gws[1]!.gatewayId, '안방 플러그');
    renderApp(`/sites/${site.siteId}/check`);
    await waitForStream(site.siteId);
    await screen.findByText('GW B (siot-bbbb0002) 온라인');
    act(() => db.setGatewayOnline(gws[1]!.gatewayId, false));
    expect(await screen.findByText('GW B (siot-bbbb0002) 오프라인')).toBeInTheDocument();
    expect(screen.getByText('안방 플러그 오프라인')).toBeInTheDocument();
    act(() => db.setGatewayOnline(gws[1]!.gatewayId, true));
    expect(await screen.findByText('GW B (siot-bbbb0002) 온라인')).toBeInTheDocument();
  });

  it('모든 GW·기기 온라인 + 인계 완료면 "전체 정상"', async () => {
    const { site, gws } = seedSite({ handedOver: true });
    db.addDevice(gws[0]!.gatewayId, '거실 플러그');
    renderApp(`/sites/${site.siteId}/check`);
    expect(await screen.findByText('전체 정상')).toBeInTheDocument();
    expect(screen.getByText('인계 완료')).toBeInTheDocument();
  });

  it('진행 중 페어링이 있으면 참고 항목으로 보여준다', async () => {
    const { site, gws } = seedSite();
    db.addDevice(gws[0]!.gatewayId, '거실 플러그');
    localStorage.setItem(
      `siot.pairing.${site.siteId}`,
      JSON.stringify([{ localId: 'x', gatewayId: gws[0]!.gatewayId, code: '34970112332', name: '', room: null, sessionId: null, attempts: 1, applied: false, enqueueError: null, createdAt: 0 }]),
    );
    renderApp(`/sites/${site.siteId}/check`);
    expect(await screen.findByText('페어링 진행·대기 1개')).toBeInTheDocument();
  });
});

describe('오프라인 배지 (C3 ④)', () => {
  it('GW 오프라인 이벤트를 받으면 세대 화면에 바로 "오프라인" 배지', async () => {
    const { site, gws } = seedSite();
    renderApp(`/sites/${site.siteId}`);
    await waitForStream(site.siteId);
    const rowB = (await screen.findByText('GW B')).closest('li')!;
    expect(within(rowB as HTMLElement).getByText('온라인')).toBeInTheDocument();
    act(() => db.setGatewayOnline(gws[1]!.gatewayId, false));
    expect(await within(rowB as HTMLElement).findByText('오프라인')).toBeInTheDocument();
    expect(screen.getByText('1 오프라인')).toBeInTheDocument();
  });

  it('실시간 연결이 끊기면 배지만 띄우고(로그아웃 없음) 다시 붙으면 목록을 다시 읽는다', async () => {
    const { site, gws } = seedSite();
    renderApp(`/sites/${site.siteId}`, { backoffMs: [50] });
    await waitForStream(site.siteId);
    await screen.findByText('GW A');
    db.sseDown = true;
    db.dropStreams(site.siteId);
    expect(await screen.findByText('실시간 연결 끊김 · 다시 연결 중')).toBeInTheDocument();
    // 끊긴 동안 GW A 가 꺼짐(이벤트 유실)
    db.gateways.find((g) => g.gatewayId === gws[0]!.gatewayId)!.online = false;
    expect(location.pathname).toBe(`/sites/${site.siteId}`);
    db.sseDown = false;
    await waitFor(() => expect(screen.queryByText('실시간 연결 끊김 · 다시 연결 중')).not.toBeInTheDocument());
    const rowA = screen.getByText('GW A').closest('li') as HTMLElement;
    expect(await within(rowA).findByText('오프라인')).toBeInTheDocument();
    expect(screen.queryByLabelText('비밀번호')).not.toBeInTheDocument();
  });

  it('브라우저가 오프라인이면 상단 배지', async () => {
    renderApp('/sites');
    await screen.findByRole('heading', { name: '세대' });
    fireEvent(window, new Event('offline'));
    expect(await screen.findByText('오프라인 · 인터넷 연결을 기다리는 중')).toBeInTheDocument();
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(screen.queryByText('오프라인 · 인터넷 연결을 기다리는 중')).not.toBeInTheDocument());
  });
});
