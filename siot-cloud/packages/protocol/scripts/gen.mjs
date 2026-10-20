// schema/*.json → src/generated/*.d.ts (json-schema-to-typescript). 생성 결과는 커밋한다.
// 파일 간 $ref(siot-device.json) 는 tsType 으로 바꾸고 import 를 붙여 타입 중복을 막는다.
// --check: 생성 결과가 커밋본과 다르면 실패(CI 용).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const EXTERNAL = {
  'siot-device.json': { type: 'SiotDevice', from: './siot-device.js' },
  'siot-device.json#/$defs/DeviceType': { type: 'DeviceType', from: './siot-device.js' },
  'siot-device.json#/$defs/DeviceData': { type: 'DeviceData', from: './siot-device.js' },
};
const FILES = ['siot-device', 'relay-v2', 'peer-v1', 'public-v1-control'];

function replaceExternal(node, used) {
  if (Array.isArray(node)) return node.map((n) => replaceExternal(n, used));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string' && EXTERNAL[node.$ref]) {
    const ext = EXTERNAL[node.$ref];
    used.add(ext);
    const { $ref: _r, ...rest } = node;
    return { ...rest, tsType: ext.type };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = k === 'x-direction' ? v : replaceExternal(v, used);
  return out;
}

mkdirSync(join(root, 'src/generated'), { recursive: true });
let stale = 0;
for (const name of FILES) {
  const schema = JSON.parse(readFileSync(join(root, 'schema', `${name}.json`), 'utf8'));
  const used = new Set();
  const prepared = replaceExternal(schema, used);
  delete prepared.$id;
  let ts = await compile(prepared, prepared.title, {
    bannerComment: `/* 자동 생성 파일 — 직접 고치지 말 것. 원본: packages/protocol/schema/${name}.json, 생성: npm run gen */`,
    unreachableDefinitions: true,
    additionalProperties: false,
    strictIndexSignatures: true,
    format: true,
    style: { singleQuote: true, printWidth: 120 },
  });
  const imports = [...new Map([...used].map((u) => [u.type, u])).values()];
  if (imports.length) {
    const byFrom = Map.groupBy(imports, (u) => u.from);
    const lines = [...byFrom].map(([from, us]) => `import type { ${us.map((u) => u.type).sort().join(', ')} } from '${from}';`);
    ts = ts.replace(/\*\/\n/, `*/\n\n${lines.join('\n')}\n`);
  }
  const target = join(root, 'src/generated', `${name}.d.ts`);
  if (check) {
    let cur = '';
    try { cur = readFileSync(target, 'utf8'); } catch { /* missing */ }
    if (cur !== ts) { console.error(`stale: ${target}`); stale++; }
  } else {
    writeFileSync(target, ts);
    console.log(`wrote ${target}`);
  }
}
if (stale) process.exit(1);
