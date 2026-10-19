// [siot patch] @matter/nodejs-ble 0.17.9 dist/esm/NobleBleChannel.js 에 upstream main 의 BLE 연결 재시도 수정을 백포트한 사본.
// docker-compose.yml 이 matterjs-server 컨테이너의 같은 경로 위에 bind-mount 한다
// (ghcr.io/matter-js/matterjs-server:stable = 1.4.0, matter.js 0.17.9 전용. 원본 sha256 369bad03…cd3202).
// 배경: Pi 5 내장 BT(BCM4345C0) ↔ IKEA 기기(EFR32) 에서 LE 연결이 "Connection Failed to be Established(0x3e)" 로 절반쯤 실패하는데,
//   원본은 (1) connect 오류 시 재시도 없이 실패하고 (2) 이후 같은 peripheral 이 'error' 상태라며 재시도를 거부해
//   프로세스 재시작 전까지 페어링이 불가능했다. 변경점은 "[siot patch]" 주석 세 곳.
// matter.js 가 0.17.9 보다 새 버전으로 올라가면 이 마운트를 제거할 것 (upstream 에 이미 포함됨).
/**
 * @license
 * Copyright 2022-2026 Matter.js Authors
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  Bytes,
  ChannelType,
  Diagnostic,
  InternalError,
  Logger,
  Minutes,
  NetworkError,
  ServerAddress,
  Time,
  asError,
  createPromise
} from "@matter/general";
import {
  BleChannel,
  BleDisconnectedError,
  BleError,
  BtpCodec,
  BtpFlowError,
  BtpSessionHandler,
  MatterBle
} from "@matter/protocol";
import { nobleDisconnectReason } from "./NobleBleClient.js";
const logger = Logger.get("BleChannel");
function isNobleDisconnectError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.message.startsWith("Disconnected")) {
    return true;
  }
  const match = error.message.match(/^status:\s*(\d+)/);
  return match !== null && Number(match[1]) >= 2;
}
function nobleUuidToUuid(uuid) {
  uuid = uuid.toUpperCase();
  if (uuid.length !== 32) {
    return uuid;
  }
  const parts = [
    uuid.substring(0, 8),
    uuid.substring(8, 12),
    uuid.substring(12, 16),
    uuid.substring(16, 20),
    uuid.substring(20, 32)
  ];
  return parts.join("-");
}
class NobleBleCentralInterface {
  #bleScanner;
  #connectionsInProgress = /* @__PURE__ */ new Set();
  #connectionGuards = /* @__PURE__ */ new Set();
  #openChannels = /* @__PURE__ */ new Map();
  #onMatterMessageListener;
  #closed = false;
  constructor(bleScanner) {
    this.#bleScanner = bleScanner;
  }
  openChannel(address, _options) {
    return this.#openChannel(address, 1);
  }
  #openChannel(address, tryCount) {
    if (this.#closed) {
      throw new NetworkError("Network interface is closed");
    }
    return new Promise((resolve, reject) => {
      let resolvedOrRejected = false;
      function rejectOnce(error) {
        if (!resolvedOrRejected) {
          resolvedOrRejected = true;
          reject(asError(error));
        } else {
          logger.debug(`Already resolved or rejected, ignore error:`, error);
        }
      }
      function resolveOnce(value) {
        if (!resolvedOrRejected) {
          resolvedOrRejected = true;
          resolve(value);
        } else {
          logger.debug(`Already resolved or rejected, ignore success`);
        }
      }
      if (this.#onMatterMessageListener === void 0) {
        rejectOnce(
          new InternalError(`Network Interface was not added to the system yet, so can not connect it.`)
        );
        return;
      }
      if (!ServerAddress.isBle(address)) {
        rejectOnce(new InternalError(`Unsupported address type for BLE channel.`));
        return;
      }
      const { peripheralAddress } = address;
      if (tryCount > 3) {
        rejectOnce(new BleError(`Failed to connect to peripheral ${peripheralAddress} after ${tryCount - 1} attempts`));
        return;
      }
      const { peripheral, hasAdditionalAdvertisementData } = this.#bleScanner.getDiscoveredDevice(peripheralAddress);
      if (this.#openChannels.has(peripheralAddress)) {
        rejectOnce(
          new BleError(
            `Peripheral ${peripheralAddress} is already connected. Only one connection supported right now.`
          )
        );
        return;
      }
      if (this.#connectionsInProgress.has(peripheralAddress)) {
        rejectOnce(new BleError(`Connection to peripheral ${peripheralAddress} is already in progress.`));
        return;
      }
      this.#connectionsInProgress.add(peripheralAddress);
      // [siot patch] upstream(0.17.9) 은 peripheral.state === "error" 면 즉시 거부했다. noble 은 실패한 연결 시도 후
      // peripheral 을 'error' 로 남기지만 다시 connect 할 수 있으므로(upstream main 과 동일하게) 그대로 진행한다.
      let connectListener;
      const connectionGuard = {
        // Timeout when trying to connect to the device because sometimes connect fails and noble does
        // not emit an event. If device does not connect we do not try any longer and reject the promise
        // because a re-discovery is the best option to get teh device into a good state again
        connectTimeout: Time.getTimer("BLE connect timeout", Minutes(2), () => {
          logger.debug(`Timeout while connecting to peripheral ${peripheralAddress}`);
          peripheral.removeListener("connect", connectListener);
          peripheral.removeListener("disconnect", reTryHandler);
          clearConnectionGuard();
          this.#connectionsInProgress.delete(peripheralAddress);
          rejectOnce(new BleError(`Timeout while connecting to peripheral ${peripheralAddress}`));
        }),
        disconnectTimeout: Time.getTimer("BLE disconnect timeout", Minutes.one, () => {
          logger.debug(`Timeout while disconnecting to peripheral ${peripheralAddress}`);
          peripheral.removeListener("disconnect", reTryHandler);
          clearConnectionGuard();
          this.#connectionsInProgress.delete(peripheralAddress);
          rejectOnce(new BleError(`Timeout while disconnecting to peripheral ${peripheralAddress}`));
        }),
        // Timeout when trying to interview the device because sometimes when no response from device
        // comes noble does not resolve promises
        interviewTimeout: Time.getTimer("BLE interview timeout", Minutes.one, () => {
          logger.debug(`Timeout while interviewing peripheral ${peripheralAddress}`);
          peripheral.removeListener("disconnect", reTryHandler);
          clearConnectionGuard();
          this.#connectionsInProgress.delete(peripheralAddress);
          if (peripheral.state === "connected") {
            peripheral.disconnectAsync().catch((error) => logger.debug(`Ignored error while disconnecting`, error));
          }
          rejectOnce(new BleError(`Timeout while interviewing peripheral ${peripheralAddress}`));
        })
      };
      this.#connectionGuards.add(connectionGuard);
      const clearConnectionGuard = () => {
        const { connectTimeout, interviewTimeout, disconnectTimeout } = connectionGuard;
        connectTimeout?.stop();
        interviewTimeout?.stop();
        disconnectTimeout?.stop();
        this.#connectionGuards.delete(connectionGuard);
      };
      const reTryHandler = (errorOrReason) => {
        clearConnectionGuard();
        this.#connectionsInProgress.delete(peripheralAddress);
        peripheral.removeListener("connect", connectListener);
        peripheral.removeListener("disconnect", reTryHandler);
        if (errorOrReason instanceof Error) {
          logger.info(
            `Peripheral ${peripheralAddress} disconnected while trying to connect, try again`,
            errorOrReason
          );
        } else {
          logger.info(
            `Peripheral ${peripheralAddress} disconnected while trying to connect (reason ${nobleDisconnectReason(errorOrReason)}), try again`
          );
        }
        this.#openChannel(address, tryCount + 1).then(resolveOnce).catch(rejectOnce);
      };
      const connectHandler = async (error) => {
        connectionGuard.connectTimeout.stop();
        if (!this.#connectionGuards.has(connectionGuard)) {
          return;
        }
        if (error) {
          // [siot patch] 연결이 아예 성립하지 않으면 noble 은 'disconnect' 를 내지 않아 아래의 disconnect 기반 재시도가
          // 동작하지 않는다. upstream main 처럼 여기서 직접 재시도한다 (최대 tryCount 3).
          reTryHandler(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (this.#onMatterMessageListener === void 0) {
          clearConnectionGuard();
          this.#connectionsInProgress.delete(peripheralAddress);
          peripheral.removeListener("disconnect", reTryHandler);
          rejectOnce(new InternalError(`Network Interface was not added to the system yet or was cleared.`));
          return;
        }
        try {
          connectionGuard.interviewTimeout.start();
          const services = await peripheral.discoverServicesAsync([MatterBle.SERVICE_UUID_SHORT]);
          if (!this.#connectionGuards.has(connectionGuard)) {
            return;
          }
          logger.debug(
            `Peripheral ${peripheralAddress}: Found services: ${services.map((s) => s.uuid).join(", ")}`
          );
          for (const service of services) {
            logger.debug(`Peripheral ${peripheralAddress}: Handle service: ${service.uuid}`);
            if (!MatterBle.isServiceUuid(service.uuid)) continue;
            const characteristics = await service.discoverCharacteristicsAsync();
            if (!this.#connectionGuards.has(connectionGuard)) {
              return;
            }
            let characteristicC1ForWrite;
            let characteristicC2ForSubscribe;
            let additionalCommissioningRelatedData;
            for (const characteristic of characteristics) {
              logger.debug(
                `Peripheral ${peripheralAddress}: Handle characteristic:`,
                characteristic.uuid,
                characteristic.properties
              );
              switch (nobleUuidToUuid(characteristic.uuid)) {
                case MatterBle.C1_CHARACTERISTIC_UUID:
                  logger.debug(`Peripheral ${peripheralAddress}: Found C1 characteristic`);
                  characteristicC1ForWrite = characteristic;
                  break;
                case MatterBle.C2_CHARACTERISTIC_UUID:
                  logger.debug(`Peripheral ${peripheralAddress}: Found C2 characteristic`);
                  characteristicC2ForSubscribe = characteristic;
                  break;
                case MatterBle.C3_CHARACTERISTIC_UUID:
                  logger.debug(`Peripheral ${peripheralAddress}: Found C3 characteristic`);
                  if (hasAdditionalAdvertisementData) {
                    logger.debug(
                      `Peripheral ${peripheralAddress}: Reading additional commissioning related data`
                    );
                    const data = await characteristic.readAsync();
                    if (!this.#connectionGuards.has(connectionGuard)) {
                      return;
                    }
                    additionalCommissioningRelatedData = new Uint8Array(data);
                    logger.debug(`Peripheral ${peripheralAddress}: Additional data:`, data);
                  }
              }
            }
            if (!characteristicC1ForWrite || !characteristicC2ForSubscribe) {
              logger.debug(
                `Peripheral ${peripheralAddress}: Missing required Matter characteristics. Ignore.`
              );
              continue;
            }
            connectionGuard.interviewTimeout.stop();
            peripheral.removeListener("disconnect", reTryHandler);
            this.#openChannels.set(peripheralAddress, peripheral);
            peripheral.once("disconnect", () => this.#openChannels.delete(peripheralAddress));
            try {
              resolveOnce(
                await NobleBleChannel.create(
                  peripheral,
                  characteristicC1ForWrite,
                  characteristicC2ForSubscribe,
                  this.#onMatterMessageListener,
                  additionalCommissioningRelatedData
                )
              );
              clearConnectionGuard();
              this.#connectionsInProgress.delete(peripheralAddress);
              return;
            } catch (error2) {
              this.#connectionsInProgress.delete(peripheralAddress);
              this.#openChannels.delete(peripheralAddress);
              if (peripheral.state === "connected") {
                logger.debug(
                  `Disconnect because of initialization error of peripheral ${ServerAddress.urlFor(address)}`
                );
                await peripheral.disconnectAsync().catch(
                  (error3) => logger.debug(
                    `Peripheral ${peripheral.address}: Error while disconnecting`,
                    error3
                  )
                );
              }
              reTryHandler(error2);
              return;
            }
          }
        } catch (error2) {
          if (this.#connectionGuards.has(connectionGuard)) {
            reTryHandler(error2);
          }
          return;
        } finally {
          this.#connectionsInProgress.delete(peripheralAddress);
          clearConnectionGuard();
        }
        peripheral.removeListener("disconnect", reTryHandler);
        rejectOnce(
          new BleError(`Peripheral ${peripheralAddress} does not have the required Matter characteristics`)
        );
      };
      connectListener = (error) => {
        connectHandler(error).catch((handlerError) => {
          logger.warn(`Peripheral ${peripheralAddress}: Unexpected error in connect handler`, handlerError);
          clearConnectionGuard();
          this.#connectionsInProgress.delete(peripheralAddress);
          peripheral.removeListener("disconnect", reTryHandler);
          rejectOnce(handlerError);
        });
      };
      if (peripheral.state === "connected") {
        logger.debug(`Peripheral ${peripheralAddress}: Already connected`);
        connectHandler().catch((error) => {
          logger.warn(`Peripheral ${peripheralAddress}: Unexpected error in connect handler`, error);
          clearConnectionGuard();
          this.#connectionsInProgress.delete(peripheralAddress);
          peripheral.removeListener("disconnect", reTryHandler);
          rejectOnce(error);
        });
      } else if (peripheral.state === "disconnecting") {
        logger.debug(`Peripheral ${peripheralAddress}: Disconnect in progress`);
        connectionGuard.disconnectTimeout.start();
        tryCount--;
        peripheral.once("disconnect", reTryHandler);
      } else {
        if (peripheral.state === "connecting") {
          peripheral.cancelConnect();
        }
        connectionGuard.connectTimeout.start();
        peripheral.once("connect", connectListener);
        peripheral.once("disconnect", reTryHandler);
        logger.debug(`Peripheral ${peripheralAddress}: Connect to Peripheral now (try ${tryCount})`);
        peripheral.connectAsync().catch((error) => {
          if (!this.#connectionGuards.has(connectionGuard)) {
            return;
          }
          logger.info(`Peripheral ${peripheralAddress}: Error while connecting to peripheral`, error);
          reTryHandler(error);
        });
      }
    });
  }
  onData(listener) {
    this.#onMatterMessageListener = listener;
    return {
      close: async () => await this.close()
    };
  }
  async close() {
    this.#closed = true;
    for (const peripheral of this.#openChannels.values()) {
      if (peripheral.state === "connected") {
        logger.debug(`Peripheral ${peripheral.address}: Disconnect from peripheral while closing central`);
        peripheral.disconnectAsync().catch((error) => logger.warn(`Peripheral ${peripheral.address}: Error while disconnecting`, error));
      }
    }
    this.#openChannels.clear();
  }
  supports(type, _address) {
    if (type !== ChannelType.BLE) {
      return false;
    }
    return true;
  }
}
class NobleBleChannel extends BleChannel {
  constructor(peripheral, btpSession, cleanupDataListener) {
    super();
    this.peripheral = peripheral;
    this.btpSession = btpSession;
    this.#cleanupDataListener = cleanupDataListener;
    peripheral.once("disconnect", (reason) => {
      logger.debug(
        `Disconnected from peripheral ${peripheral.address} (reason ${nobleDisconnectReason(reason)}). Closing BTP session`
      );
      this.#connected = false;
      this.#cleanupDataListener();
      this.#terminateIterator();
      for (const listener of this.#closeListeners) {
        listener();
      }
      this.btpSession.close().catch((error) => {
        logger.debug(`Peripheral ${peripheral.address}: Error closing BTP session on disconnect`, error);
      });
      this.emitClosed();
    });
    this.btpSession.closed.on(() => this.emitClosed());
  }
  peripheral;
  btpSession;
  static async create(peripheral, characteristicC1ForWrite, characteristicC2ForSubscribe, onMatterMessageListener, _additionalCommissioningRelatedData) {
    const { address: peripheralAddress } = peripheral;
    const mtu = MatterBle.btpSegmentSizeFromAttMtu(peripheral.mtu ?? 0);
    logger.debug(
      `Peripheral ${peripheralAddress}: Using BTP segment size=${mtu} bytes (Peripheral ATT_MTU up to ${peripheral.mtu} bytes)`
    );
    const {
      promise: handshakeResponseReceivedPromise,
      resolver: handshakeResolver,
      rejecter: handshakeRejecter
    } = createPromise();
    const handshakeHandler = (data, isNotification) => {
      if (data[0] === 101 && data[1] === 108 && data.length === 6) {
        logger.info(
          `Peripheral ${peripheralAddress}: Received Matter handshake response: ${data.toString("hex")}.`
        );
        btpHandshakeTimeout.stop();
        handshakeResolver(data);
      } else {
        logger.debug(
          `Peripheral ${peripheralAddress}: Received first data on C2: ${data.toString("hex")} (isNotification: ${isNotification}) - No handshake response, ignoring`
        );
      }
    };
    const btpHandshakeTimeout = Time.getTimer("BLE handshake timeout", MatterBle.BTP_CONN_RSP_TIMEOUT, async () => {
      characteristicC2ForSubscribe.removeListener("data", handshakeHandler);
      if (peripheral.state === "connected") {
        await characteristicC2ForSubscribe.unsubscribeAsync().catch((error) => {
          if (!isNobleDisconnectError(error)) {
            logger.warn(`Peripheral ${peripheralAddress}: Error while unsubscribing`, error);
          }
        });
      }
      logger.debug(
        `Peripheral ${peripheralAddress}: Handshake Response not received. Disconnect from peripheral`
      );
      handshakeRejecter(new BleError(`Peripheral ${peripheralAddress}: Handshake Response not received`));
    }).start();
    const btpHandshakeRequest = BtpCodec.encodeBtpHandshakeRequest({
      versions: MatterBle.BTP_SUPPORTED_VERSIONS,
      attMtu: mtu,
      clientWindowSize: MatterBle.BTP_MAXIMUM_WINDOW_SIZE
    });
    logger.debug(
      `Peripheral ${peripheralAddress}: Sending BTP handshake request: ${Diagnostic.json(btpHandshakeRequest)}`
    );
    try {
      await characteristicC1ForWrite.writeAsync(Buffer.from(Bytes.of(btpHandshakeRequest)), false);
      characteristicC2ForSubscribe.on("data", handshakeHandler);
      logger.debug(`Peripheral ${peripheralAddress}: Subscribing to C2 characteristic`);
      await characteristicC2ForSubscribe.subscribeAsync();
    } catch (error) {
      btpHandshakeTimeout.stop();
      characteristicC2ForSubscribe.removeListener("data", handshakeHandler);
      if (isNobleDisconnectError(error)) {
        throw new BleDisconnectedError(error.message, { cause: error });
      }
      throw error;
    }
    const handshakeResponse = await handshakeResponseReceivedPromise;
    characteristicC2ForSubscribe.removeListener("data", handshakeHandler);
    const btpSession = await BtpSessionHandler.createAsCentral(
      new Uint8Array(handshakeResponse),
      // callback to write data to characteristic C1; translates noble's disconnect/transport
      // errors into BleDisconnectedError so BtpSessionHandler can handle them specifically
      async (data) => {
        try {
          return await characteristicC1ForWrite.writeAsync(Buffer.from(Bytes.of(data)), false);
        } catch (error) {
          if (isNobleDisconnectError(error)) {
            throw new BleDisconnectedError(error.message, { cause: error });
          }
          throw error;
        }
      },
      // callback to disconnect the BLE connection
      async () => {
        if (peripheral.state !== "connected" || !nobleChannel.connected) return;
        logger.debug(`Peripheral ${peripheralAddress}: Disconnect from peripheral because btp session closed`);
        characteristicC2ForSubscribe.unsubscribeAsync().catch((error) => {
          if (!isNobleDisconnectError(error)) {
            logger.debug(`Peripheral ${peripheralAddress}: Error while unsubscribing from C2`, error);
          }
        }).then(() => {
          if (peripheral.state !== "connected") {
            return;
          }
          return peripheral.disconnectAsync().then(
            () => logger.debug(`Peripheral ${peripheralAddress}: Disconnected from peripheral`),
            (error) => logger.debug(`Peripheral ${peripheralAddress}: Error while disconnecting`, error)
          );
        }).catch(
          (error) => logger.debug(`Peripheral ${peripheralAddress}: Error during disconnect cleanup`, error)
        );
      },
      // callback to forward decoded and de-assembled Matter messages
      async (data) => {
        if (onMatterMessageListener === void 0) {
          throw new InternalError(`No listener registered for Matter messages`);
        }
        nobleChannel.pushMessage(data);
        onMatterMessageListener(nobleChannel, data);
      }
    );
    const c2DataHandler = (data, isNotification) => {
      logger.debug(
        `Peripheral ${peripheralAddress}: received data on C2: ${data.toString("hex")} (isNotification: ${isNotification})`
      );
      btpSession.handleIncomingBleData(new Uint8Array(data)).catch((error) => {
        logger.info(`Peripheral ${peripheralAddress}: Error handling incoming BLE data`, error);
      });
    };
    characteristicC2ForSubscribe.on("data", c2DataHandler);
    const nobleChannel = new NobleBleChannel(peripheral, btpSession, () => {
      characteristicC2ForSubscribe.removeListener("data", c2DataHandler);
    });
    return nobleChannel;
  }
  #connected = true;
  #closeListeners = /* @__PURE__ */ new Set();
  #iteratorQueue = new Array();
  #iteratorWaiter;
  #iteratorDone = false;
  #cleanupDataListener;
  get connected() {
    return this.#connected && this.peripheral.state === "connected";
  }
  /**
   * Send a Matter message to the connected device - need to do BTP assembly first.
   *
   * @param data
   */
  async send(data) {
    if (!this.connected) {
      throw new BleDisconnectedError(
        `Peripheral ${this.peripheral.address}: Cannot send data because not connected to peripheral.`
      );
    }
    if (this.btpSession === void 0) {
      throw new BtpFlowError(
        `Peripheral ${this.peripheral.address}: Cannot send data, no BTP session initialized`
      );
    }
    await this.btpSession.sendMatterMessage(data);
  }
  // Channel<Bytes>
  get name() {
    return `${this.type}://${this.peripheral.address}`;
  }
  onClose(listener) {
    this.#closeListeners.add(listener);
    return {
      close: async () => {
        this.#closeListeners.delete(listener);
      }
    };
  }
  /** Called by the BTP session when a complete Matter message is assembled. */
  pushMessage(message) {
    if (this.#iteratorWaiter) {
      const resolve = this.#iteratorWaiter;
      this.#iteratorWaiter = void 0;
      resolve({ value: message, done: false });
    } else if (!this.#iteratorDone) {
      this.#iteratorQueue.push(message);
    }
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#iteratorQueue.length > 0) {
          return Promise.resolve({ value: this.#iteratorQueue.shift(), done: false });
        }
        if (this.#iteratorDone || !this.#connected) {
          return Promise.resolve({ value: void 0, done: true });
        }
        return new Promise((resolve) => {
          this.#iteratorWaiter = resolve;
        });
      }
    };
  }
  #terminateIterator() {
    if (!this.#iteratorDone) {
      this.#iteratorDone = true;
      this.#iteratorWaiter?.({ value: void 0, done: true });
      this.#iteratorWaiter = void 0;
    }
  }
  async close() {
    this.#cleanupDataListener();
    this.#terminateIterator();
    await this.btpSession.close();
    if (this.connected) {
      this.peripheral.disconnectAsync().catch((error) => {
        if (!isNobleDisconnectError(error)) {
          logger.warn(`Peripheral ${this.peripheral.address}: Error while disconnecting`, error);
        }
      });
    }
    this.emitClosed();
  }
}
export {
  NobleBleCentralInterface,
  NobleBleChannel
};
//# sourceMappingURL=NobleBleChannel.js.map
