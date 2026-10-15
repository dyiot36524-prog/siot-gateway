import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThreadDataset } from '../src/embedded/threadDataset.js';

// 합성 데이터셋: channel(0) page0 ch15, panid(1) 0x1234, extpanid(2), networkname(3) "gw-poc", networkkey(5) 16바이트
const ds = '000300000f' + '01021234' + '0208' + '1111222233334444' + '0306' + Buffer.from('gw-poc').toString('hex') + '0510' + 'aa'.repeat(16);

test('parses network name and channel from operational dataset', () => {
  const p = parseThreadDataset(ds);
  assert.equal(p.networkName, 'gw-poc');
  assert.equal(p.channel, 15);
  assert.equal(p.panId, 0x1234);
  assert.equal(p.extPanId, '1111222233334444');
});

test('rejects dataset without network name', () => {
  assert.throws(() => parseThreadDataset('01021234'), /network name/);
});
