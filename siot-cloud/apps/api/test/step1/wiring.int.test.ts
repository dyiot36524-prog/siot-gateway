// app.ts 조립: 실제 registerRelay(Step 2)와 cache·outbox·metrics 가 함께 뜨는지(스모크).
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { seedOrg, testConfig, useTestDb } from './helpers.js';

const t = useTestDb();

describe('buildApp wiring', () => {
  it('relay·public·appapi·webhooks·metrics 가 한 앱에 등록된다', async () => {
    await t.truncate();
    const app = await buildApp({ config: testConfig, db: t.db, logger: false, startWorkers: false, webDist: false, pingDb: async () => {} });
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false });
    for (const p of ['/gateway', '/v1/sites', '/app/v1/gateways/claim', '/app/v1/me', '/metrics', '/healthz']) expect(routes).toContain(p);
    expect(app.siot!.bus.isOnline('gw_00000000-0000-4000-8000-000000000000')).toBe(false);
    const orgId = await seedOrg(t.db);
    const k = await app.siot!.apiKeys.issue(orgId, { name: 'x', mode: 'test', scopes: ['devices:read'] });
    const r = await app.inject({ url: '/v1/sites', headers: { authorization: `Bearer ${k.key}` } });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/nope' })).json().error.code).toBe('NOT_FOUND');
    await app.close();
  });
});
