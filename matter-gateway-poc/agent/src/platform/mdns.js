// mDNS 광고 — siot-app lib/mdns.ts 와 동일: 이름 siot-<shortId>, 타입 _siot._tcp, host siot-<shortId>.local, TXT {id, app, url}
import { logger } from '../log.js';
const log = logger('mdns');

export async function startMdns(identity, port) {
  try {
    const { Bonjour } = await import('bonjour-service');
    const gatewayId = await identity.gatewayId();
    const shortId = gatewayId.slice(3, 11);
    const hostname = `siot-${shortId}.local`;
    const url = `http://${hostname}:${port}`;
    const bonjour = new Bonjour();
    bonjour.publish({ name: `siot-${shortId}`, type: 'siot', port, host: hostname, txt: { id: gatewayId, app: 'siot-gateway', url } });
    log.info(`advertising ${hostname}:${port} (_siot._tcp) gatewayId=${gatewayId}`);
    return () => bonjour.destroy();
  } catch (e) {
    log.warn(`mDNS 광고 실패 (무시): ${e.message}`);
    return () => {};
  }
}
