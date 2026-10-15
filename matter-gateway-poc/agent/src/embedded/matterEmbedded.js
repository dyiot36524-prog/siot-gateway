// matter.js 라이브러리를 프로세스 안에 직접 임베드한 Matter 컨트롤러 백엔드.
// matterClient.js(WebSocket 백엔드)와 같은 메서드/이벤트 표면을 제공해 pairing/commands/index 가 그대로 동작한다.
//   이벤트: node_added, node_updated, node_removed, attribute_updated([nodeId, "ep/cl/at", value]), node_event
//   메서드: connect, close, startListening, getNodes, getNode, setThreadDataset, commissionWithCode,
//           openCommissioningWindow, removeNode, deviceCommand, readAttribute, serverInfo
// matter.js 0.17.x 의 CommissioningController/PairedNode API 기준 (@matter/nodejs-shell 구현과 동일한 호출).
import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Environment, StorageService, VendorId, FabricId } from '@matter/main';
import { NodeId, QrPairingCodeCodec, ManualPairingCodeCodec, DiscoveryCapabilitiesSchema } from '@matter/types';
import { GeneralCommissioning } from '@matter/types/clusters';
import { CommissioningController } from '@project-chip/matter.js';
import { NodeStates } from '@project-chip/matter.js/device';
import { logger } from '../log.js';
import { parseThreadDataset } from './threadDataset.js';

const log = logger('matter-embedded');
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const toNum = (v) => (typeof v === 'bigint' ? Number(v) : v);

export class MatterEmbedded extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir       matter.js 스토리지 + 자격증명 파일 위치
   * @param {boolean} o.ble          BLE 커미셔닝 활성화 (호스트 BlueZ/HCI 필요)
   * @param {number} [o.hciId]       BLE 어댑터 HCI 번호
   * @param {string} [o.netInterface] mDNS 인터페이스 (eth0 등)
   * @param {number} [o.vendorId]    0xFFF1 = 테스트 VID
   * @param {string} [o.fabricLabel]
   */
  constructor(o) {
    super();
    this.o = { vendorId: 0xfff1, fabricId: 1, fabricLabel: 'Gateway PoC', ...o };
    this.controller = null;
    this.nodes = new Map();          // nodeId(number) -> PairedNode
    this.serverInfo = null;
    this.credFile = path.join(this.o.dataDir, 'credentials.json');
    this.creds = {};
  }

  async connect() {
    await mkdir(this.o.dataDir, { recursive: true });
    try { this.creds = JSON.parse(await readFile(this.credFile, 'utf8')); } catch { this.creds = {}; }

    const env = Environment.default;
    env.vars.set('storage.path', path.join(this.o.dataDir, 'matter'));
    if (this.o.netInterface) env.vars.set('mdns.networkinterface', this.o.netInterface);
    if (this.o.ble) {
      env.vars.set('ble.enable', true);
      if (this.o.hciId !== undefined) env.vars.set('ble.hci.id', this.o.hciId);
      await import('@matter/nodejs-ble');   // ble.enable 가 켜진 상태에서 import 되어야 Ble 구현이 등록됨
    }
    await env.get(StorageService).open('gateway');

    this.controller = new CommissioningController({
      environment: { environment: env, id: 'gateway' },
      autoConnect: false,
      adminFabricLabel: this.o.fabricLabel,
      adminVendorId: VendorId(this.o.vendorId),
      adminFabricId: FabricId(BigInt(this.o.fabricId)),
      enableOtaProvider: false,
      basicInformation: { productName: 'Gateway PoC' },
    });
    await this.controller.start();
    this.#refreshServerInfo();
    log.info(`controller started; commissioned nodes: ${this.controller.getCommissionedNodes().length}`);
    return this.serverInfo;
  }

  #refreshServerInfo() {
    this.serverInfo = {
      backend: 'embedded',
      sdk_version: 'matter.js 0.17.x',
      fabric_id: this.o.fabricId,
      vendor_id: this.o.vendorId,
      thread_credentials_set: Boolean(this.creds.thread?.operationalDataset),
      thread_network_name: this.creds.thread?.networkName ?? null,
      wifi_credentials_set: Boolean(this.creds.wifi?.ssid),
      bluetooth_enabled: Boolean(this.o.ble),
      controller_node_id: toNum(this.controller?.nodeId),
    };
    this.emit('server_info_updated', this.serverInfo);
  }

  async close() { await this.controller?.close(); }

  // ---- 노드 연결/구독 ----
  async startListening() {
    const nodes = await this.controller.connect({
      autoSubscribe: true,
      attributeChangedCallback: (nodeId, data) => this.#onAttribute(nodeId, data),
      eventTriggeredCallback: (nodeId, data) => this.emit('node_event', this.#eventPayload(nodeId, data)),
      stateInformationCallback: (nodeId, state) => this.#onState(nodeId, state),
    });
    const snapshots = [];
    for (const node of nodes) {
      if (!node.initialized) { try { await node.events.initialized; } catch (e) { log.warn(`node ${node.nodeId} init wait failed: ${e.message}`); } }
      this.#track(node);
      snapshots.push(await this.#snapshot(node));
    }
    return snapshots;
  }

  #track(node) {
    const id = toNum(node.nodeId);
    if (this.nodes.has(id)) return;
    this.nodes.set(id, node);
    node.events.structureChanged.on(() => this.#snapshot(node).then((s) => this.emit('node_updated', s)).catch(() => {}));
    node.events.decommissioned.on(() => { this.nodes.delete(id); this.emit('node_removed', id); });
  }

  #onAttribute(nodeId, { path: p, value }) {
    this.emit('attribute_updated', [toNum(nodeId), `${p.endpointId}/${p.clusterId}/${p.attributeId}`, value]);
  }

  #onState(nodeId, state) {
    const node = this.nodes.get(toNum(nodeId));
    if (!node) return;
    log.debug(`node ${nodeId} state ${state}`);
    this.#snapshot(node).then((s) => this.emit('node_updated', s)).catch(() => {});
  }

  #eventPayload(nodeId, { path: p, events }) {
    return { node_id: toNum(nodeId), endpoint_id: p.endpointId, cluster_id: p.clusterId, event_id: p.eventId, event_name: p.eventName, data: events };
  }

  /** PairedNode → python-matter-server 호환 스냅샷 {node_id, available, attributes:{"ep/cl/at": value}} */
  async #snapshot(node) {
    const attributes = {};
    const visit = async (endpoint) => {
      const ep = endpoint.number ?? 0;
      for (const client of endpoint.getAllClusterClients()) {
        for (const attr of Object.values(client.attributes)) {
          if (!attr || attr.id === undefined) continue;
          try {
            const v = await attr.get(false);             // 캐시에서 읽기 (원격 요청 없음)
            if (v !== undefined) attributes[`${ep}/${client.id}/${attr.id}`] = v;
          } catch { /* 지원하지 않는 속성 */ }
        }
      }
      for (const child of endpoint.parts?.values?.() ?? []) await visit(child);
    };
    const root = node.getRootEndpoint();
    if (root) await visit(root);
    for (const dev of node.getDevices()) await visit(dev);
    return {
      node_id: toNum(node.nodeId),
      available: node.connectionState === NodeStates.Connected,
      date_commissioned: node.state?.commissioning?.commissionedAt ?? null,
      attributes,
    };
  }

  async getNodes() {
    const out = [];
    for (const node of this.nodes.values()) out.push(await this.#snapshot(node));
    return out;
  }
  async getNode(nodeId) { const n = this.nodes.get(Number(nodeId)); if (!n) throw new Error(`unknown node ${nodeId}`); return this.#snapshot(n); }

  // ---- 자격증명 ----
  async #saveCreds() {
    await mkdir(this.o.dataDir, { recursive: true });
    await writeFile(this.credFile, JSON.stringify(this.creds, null, 2));
  }
  async setThreadDataset(datasetHex, networkName) {
    const parsed = parseThreadDataset(datasetHex);
    this.creds.thread = { operationalDataset: datasetHex.trim(), networkName: networkName ?? parsed.networkName };
    await this.#saveCreds();
    this.#refreshServerInfo();
    return { network_name: this.creds.thread.networkName, channel: parsed.channel, pan_id: parsed.panId };
  }
  async setWifiCredentials(ssid, credentials) {
    this.creds.wifi = { ssid, credentials };
    await this.#saveCreds();
    this.#refreshServerInfo();
    return true;
  }

  // ---- 커미셔닝 ----
  /** code: "MT:..." QR 문자열 또는 11/21자리 수동 코드 */
  async commissionWithCode(code, { strictAttestation = false } = {}) {
    let passcode, identifierData, ble = false;
    if (code.startsWith('MT:')) {
      const [qr] = QrPairingCodeCodec.decode(code);
      passcode = qr.passcode;
      identifierData = { longDiscriminator: qr.discriminator };
      ble = Boolean(DiscoveryCapabilitiesSchema.decode(qr.discoveryCapabilities).ble);
    } else {
      const { shortDiscriminator, passcode: pc } = ManualPairingCodeCodec.decode(code.replace(/[-\s]/g, ''));
      passcode = pc; identifierData = { shortDiscriminator }; ble = true;    // 수동 코드는 BLE 여부를 모름 → 켜둠
    }
    if (ble && !this.o.ble) log.warn('code requests BLE discovery but BLE is disabled (MATTER_BLE=1 to enable)');

    const options = {
      passcode,
      discovery: { identifierData, discoveryCapabilities: { ble: ble && this.o.ble, onIpNetwork: true } },
      commissioning: {
        regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
        regulatoryCountryCode: 'KR',
        onAttestationFailure: (findings) => {
          for (const f of findings) log.warn(`attestation ${f.level}: ${f.type} ${f.message}`);
          return strictAttestation ? findings.every((f) => f.level !== 'error') : true;
        },
      },
      attributeChangedCallback: (nodeId, data) => this.#onAttribute(nodeId, data),
      eventTriggeredCallback: (nodeId, data) => this.emit('node_event', this.#eventPayload(nodeId, data)),
      stateInformationCallback: (nodeId, state) => this.#onState(nodeId, state),
    };
    if (this.creds.thread) options.commissioning.threadNetwork = this.creds.thread;
    if (this.creds.wifi) options.commissioning.wifiNetwork = { wifiSsid: this.creds.wifi.ssid, wifiCredentials: this.creds.wifi.credentials };

    log.info(`commissioning discriminator=${JSON.stringify(identifierData)} ble=${options.discovery.discoveryCapabilities.ble}`);
    const nodeId = await this.controller.commissionNode(options);
    const node = await this.controller.connectNode(nodeId, options);
    if (!node.initialized) await node.events.initialized;
    this.#track(node);
    const snap = await this.#snapshot(node);
    this.emit('node_added', snap);
    return snap;
  }

  async openCommissioningWindow(nodeId, timeout = 300) {
    const node = this.#node(nodeId);
    const r = await node.openEnhancedCommissioningWindow(timeout);
    return { setup_manual_code: r.manualPairingCode, setup_qr_code: r.qrPairingCode, timeout };
  }

  async removeNode(nodeId) {
    await this.controller.removeNode(NodeId(BigInt(nodeId)), true);
    this.nodes.delete(Number(nodeId));
    this.emit('node_removed', Number(nodeId));
  }

  // ---- 상호작용 ----
  async deviceCommand(nodeId, endpointId, clusterId, commandName, payload = {}) {
    const node = this.#node(nodeId);
    const client = node.getDeviceById(endpointId)?.getClusterClientById(clusterId)
      ?? (endpointId === 0 ? node.getRootEndpoint()?.getClusterClientById(clusterId) : undefined);
    if (!client) throw new Error(`cluster ${nodeId}/${endpointId}/${clusterId} not found`);
    const fn = client.commands[lowerFirst(commandName)] ?? client.commands[commandName];
    if (!fn) throw new Error(`command ${commandName} not supported on ${nodeId}/${endpointId}/${clusterId}`);
    const result = await fn(Object.keys(payload).length ? payload : undefined);
    return result ?? null;
  }

  async readAttribute(nodeId, attributePath, fromRemote = true) {
    const [ep, cl, at] = attributePath.split('/').map(Number);
    const node = this.#node(nodeId);
    const endpoint = ep === 0 ? node.getRootEndpoint() : node.getDeviceById(ep);
    const client = endpoint?.getClusterClientById(cl);
    const attr = client && Object.values(client.attributes).find((a) => a?.id === at);
    if (!attr) throw new Error(`attribute ${attributePath} not found`);
    return attr.get(fromRemote);
  }

  async pingNode(nodeId) { return { node_id: Number(nodeId), connected: this.#node(nodeId).isConnected }; }
  async interviewNode(nodeId) { const n = this.#node(nodeId); await n.reconnect(); return this.#snapshot(n); }

  #node(nodeId) { const n = this.nodes.get(Number(nodeId)); if (!n) throw new Error(`unknown node ${nodeId}`); return n; }

  /** WS 백엔드의 request() 와 모양 맞춤 (CLI raw 용) */
  async request(command, args = {}) {
    const map = {
      get_nodes: () => this.getNodes(), get_node: () => this.getNode(args.node_id),
      set_thread_dataset: () => this.setThreadDataset(args.dataset, args.network_name),
      set_wifi_credentials: () => this.setWifiCredentials(args.ssid, args.credentials),
      commission_with_code: () => this.commissionWithCode(args.code),
      open_commissioning_window: () => this.openCommissioningWindow(args.node_id, args.timeout),
      remove_node: () => this.removeNode(args.node_id),
      device_command: () => this.deviceCommand(args.node_id, args.endpoint_id, args.cluster_id, args.command_name, args.payload),
      read_attribute: () => this.readAttribute(args.node_id, args.attribute_path),
      server_info: () => this.serverInfo,
    };
    if (!map[command]) throw new Error(`unsupported command ${command} on embedded backend`);
    return map[command]();
  }
}
