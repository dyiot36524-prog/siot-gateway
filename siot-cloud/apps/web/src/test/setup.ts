import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { resetDb } from '../mocks/db';
import { handlers } from '../mocks/handlers';

export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  resetDb();
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
