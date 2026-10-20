import { render, screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { db } from '../mocks/db';

export const EMAIL = 'gisa@siot.dev';
export const PASSWORD = 'siot-demo-1234';

/** 로그인된 기사 + 경로에서 앱을 띄운다 */
export function renderApp(path = '/', { login = true, backoffMs = [30] }: { login?: boolean; backoffMs?: number[] } = {}) {
  const u = db.users.find((x) => x.email === EMAIL) ?? db.addUser(EMAIL, PASSWORD);
  if (login) db.session = u.email;
  history.replaceState(null, '', path);
  const user = userEvent.setup();
  const utils = render(<App clientOptions={{ backoffMs }} />);
  return { user, ...utils };
}

/** SSE 구독이 붙을 때까지 기다린다 */
export async function waitForStream(siteId: string) {
  await waitFor(() => expect(db.streamCount(siteId)).toBeGreaterThan(0));
}

export { screen };
