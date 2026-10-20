import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { db } from '../mocks/db';
import { server } from '../test/setup';
import { ApiError, createAppApiClient, NetworkError, type SiteEvent, type StreamStatus } from './client';

function seed() {
  db.addUser('a@siot.dev', 'password-123');
  db.session = 'a@siot.dev';
  return db.addSite('101동');
}

describe('app-v1 클라이언트', () => {
  it('오류 본문을 ApiError(status, code) 로 바꾸고 401 이면 onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    const api = createAppApiClient('', { onUnauthorized });
    await expect(api.me()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('로그인 실패 401 은 onUnauthorized 를 부르지 않는다', async () => {
    const onUnauthorized = vi.fn();
    db.addUser('a@siot.dev', 'password-123');
    const api = createAppApiClient('', { onUnauthorized });
    const e = await api.login('a@siot.dev', 'wrong-pass').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('INVALID_CREDENTIALS');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('네트워크 실패는 NetworkError', async () => {
    server.use(http.get('/app/v1/me', () => HttpResponse.error()));
    await expect(createAppApiClient().me()).rejects.toBeInstanceOf(NetworkError);
  });

  it('SSE: 이벤트를 파싱하고 keepalive 주석은 무시한다', async () => {
    const site = seed();
    const api = createAppApiClient();
    const events: SiteEvent[] = [];
    const statuses: StreamStatus[] = [];
    const close = api.streamSiteEvents(site.siteId, (e) => events.push(e), (s) => statuses.push(s));
    await waitFor(() => expect(db.streamCount(site.siteId)).toBe(1));
    db.push(site.siteId, 'device_removed', { deviceId: 'dev_x' });
    db.push(site.siteId, 'unknown_kind', { a: 1 });
    db.push(site.siteId, 'gateway', { online: false, lastSeen: null, agentVersion: null, matterServerVersion: null, deviceCount: 0, lastErrorCode: null });
    await waitFor(() => expect(events).toHaveLength(2));
    expect(events[0]).toEqual({ event: 'device_removed', data: { deviceId: 'dev_x' } });
    expect(events[1]?.event).toBe('gateway');
    expect(statuses).toEqual(['connecting', 'open']);
    close();
  });

  it('SSE: 끊기면 reconnecting 후 다시 open', async () => {
    const site = seed();
    const api = createAppApiClient('', { backoffMs: [20] });
    const statuses: StreamStatus[] = [];
    const close = api.streamSiteEvents(site.siteId, () => {}, (s) => statuses.push(s));
    await waitFor(() => expect(db.streamCount(site.siteId)).toBe(1));
    db.dropStreams(site.siteId);
    await waitFor(() => expect(statuses.filter((s) => s === 'open')).toHaveLength(2));
    expect(statuses).toContain('reconnecting');
    close();
  });

  it('SSE: 서버가 조용하면(keepalive 없음) 무응답 감시로 다시 붙는다', async () => {
    const site = seed();
    const api = createAppApiClient('', { backoffMs: [10], streamIdleMs: 80 });
    const statuses: StreamStatus[] = [];
    const close = api.streamSiteEvents(site.siteId, () => {}, (s) => statuses.push(s));
    await waitFor(() => expect(statuses.filter((s) => s === 'open').length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    close();
  });

  it('SSE: 401 이면 멈추고 onUnauthorized', async () => {
    const site = seed();
    db.session = null;
    const onUnauthorized = vi.fn();
    const statuses: StreamStatus[] = [];
    const close = createAppApiClient('', { onUnauthorized }).streamSiteEvents(site.siteId, () => {}, (s) => statuses.push(s));
    await waitFor(() => expect(statuses).toContain('denied'));
    expect(onUnauthorized).toHaveBeenCalled();
    close();
  });
});
