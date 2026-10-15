// Thread Operational Dataset(hex TLV) 파서. 네트워크 이름(type 3)만 뽑아 matter.js 커미셔닝 옵션에 넣는다.
// TLV: [type:1][len:1][value:len] 반복. (len=0xFF 확장형은 데이터셋에서 쓰이지 않음)
export function parseThreadDataset(hex) {
  const clean = hex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2) throw new Error('invalid dataset hex');
  const buf = Buffer.from(clean, 'hex');
  const out = {};
  for (let i = 0; i + 2 <= buf.length;) {
    const type = buf[i], len = buf[i + 1];
    const value = buf.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    switch (type) {
      case 0: out.channel = value.readUInt16BE(1); break;          // [page:1][channel:2]
      case 1: out.panId = value.readUInt16BE(0); break;
      case 2: out.extPanId = value.toString('hex'); break;
      case 3: out.networkName = value.toString('utf8'); break;
      case 5: out.networkKey = '<set>'; break;
      default: break;
    }
  }
  if (!out.networkName) throw new Error('dataset has no network name TLV');
  return out;
}
