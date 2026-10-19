import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { MatterClient } from '../src/matterClient.js';

// server_info 를 보내는 가짜 matterjs-server
function startServer(port = 0) {
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => ws.send(JSON.stringify({ event: 'server_info', data: { fabric_id: 1, port } })));
  return once(wss, 'listening').then(() => wss);
}
const stopServer = (wss) => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); });

test('keeps reconnecting after the server restarts even if the first retry is refused', async () => {
  let wss = await startServer();
  const port = wss.address().port;
  const client = new MatterClient(`ws://127.0.0.1:${port}/ws`);
  const info = await client.connect();
  assert.equal(info.fabric_id, 1);
  client.reconnectDelay = 100;            // open 시 1000ms 로 초기화되므로 연결 뒤에 설정. 100ms → 200ms → 400ms

  await stopServer(wss);                  // 서버 다운 → 1차 재접속(100ms 뒤)은 ECONNREFUSED 로 실패해야 함
  const reconnected = once(client, 'reconnected');
  await new Promise((r) => setTimeout(r, 150));
  wss = await startServer(port);          // 1차 실패 후 서버 복귀
  let timer;
  try {
    await Promise.race([
      reconnected,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('did not reconnect after failed retry')), 3000); }),
    ]);
    assert.equal(client.ws.readyState, 1);
  } finally {
    clearTimeout(timer);                  // 실패해도 소켓/타이머를 정리해 테스트 프로세스가 남지 않게
    client.close();
    await stopServer(wss);
  }
});

test('does not auto-reconnect when closed on purpose', async () => {
  const wss = await startServer();
  const client = new MatterClient(`ws://127.0.0.1:${wss.address().port}/ws`);
  await client.connect();
  client.reconnectDelay = 50;
  let reconnects = 0; client.on('reconnected', () => reconnects++);
  client.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(reconnects, 0);
  await stopServer(wss);
});
