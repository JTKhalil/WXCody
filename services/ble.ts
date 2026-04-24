import { Frame, FrameParser, FrameType, buildAck, buildFrame, buildPing, isAckForPingOk } from "./proto_bin";

const SERVICE_UUID = "0000C0DE-0000-1000-8000-00805F9B34FB";
const RX_UUID = "0000C0D1-0000-1000-8000-00805F9B34FB";
const TX_UUID = "0000C0D2-0000-1000-8000-00805F9B34FB";

export type BleState = {
  adapterReady: boolean;
  scanning: boolean;
  connected: boolean;
  deviceId?: string;
  serviceId?: string;
  rxCharId?: string;
  txCharId?: string;
};

export class BleCodyClient {
  state: BleState = { adapterReady: false, scanning: false, connected: false };

  private parser = new FrameParser();
  private onFrameHandlers: Array<(f: Frame) => void> = [];
  private onConnHandlers: Array<(connected: boolean) => void> = [];

  private session = 1;
  private seq = 1;

  private _adapterInited = false;
  private _writeQ: Promise<void> = Promise.resolve();

  private _logMaxLines = 500;
  private _logLines: string[] = [];

  onFrame(cb: (f: Frame) => void) {
    this.onFrameHandlers.push(cb);
  }

  onConnectionStateChange(cb: (connected: boolean) => void) {
    this.onConnHandlers.push(cb);
  }

  private emitFrame(f: Frame) {
    for (const cb of this.onFrameHandlers) cb(f);
  }

  private emitConn(connected: boolean) {
    for (const cb of this.onConnHandlers) cb(connected);
  }

  log(line: string) {
    const ts = new Date();
    const stamp = `${ts.getHours().toString().padStart(2, "0")}:${ts.getMinutes().toString().padStart(2, "0")}:${ts.getSeconds().toString().padStart(2, "0")}.${ts.getMilliseconds().toString().padStart(3, "0")}`;
    this._logLines.unshift(`[${stamp}] ${line}`);
    if (this._logLines.length > this._logMaxLines) this._logLines.length = this._logMaxLines;
  }

  clearLogs() {
    this._logLines = [];
  }

  getLogs(): string[] {
    return [...this._logLines];
  }

  getLogsText(opts?: { maxChars?: number }): string {
    const maxChars = opts?.maxChars ?? 8000;
    let out = "";
    for (const line of this._logLines) {
      const next = line + "\n";
      if (out.length + next.length > maxChars) break;
      out += next;
    }
    return out.trimEnd();
  }

  async copyLogs(opts?: { maxChars?: number }): Promise<void> {
    const text = this.getLogsText({ maxChars: opts?.maxChars ?? 20000 });
    await p<void>((resolve, reject) => {
      wx.setClipboardData({
        data: text || "(空)",
        success: () => resolve(),
        fail: (e) => reject(new Error(e?.errMsg || "setClipboardData failed")),
      });
    });
  }

  async openAdapter(): Promise<void> {
    if (this._adapterInited && this.state.adapterReady) return;
    await p<void>((resolve, reject) => {
      wx.openBluetoothAdapter({
        success: () => resolve(),
        fail: (e) => reject(new Error(e?.errMsg || "openBluetoothAdapter failed")),
      });
    });
    this.state.adapterReady = true;
    this._adapterInited = true;

    wx.onBLECharacteristicValueChange((evt) => {
      if (!evt?.value) return;
      const frames = this.parser.push(evt.value);
      for (const f of frames) this.emitFrame(f);
    });

    wx.onBLEConnectionStateChange((evt) => {
      const dev = evt?.deviceId || "";
      if (!dev) return;
      if (this.state.deviceId && dev !== this.state.deviceId) return;

      if (evt.connected) {
        this.state.connected = true;
        if (!this.state.deviceId) this.state.deviceId = dev;
        this.log(`连接状态变化：已连接 deviceId=${dev}`);
        this.emitConn(true);
        return;
      }

      this.state.connected = false;
      this.state.scanning = false;
      // 保留 deviceId 便于“一键重连”，但清空服务与特征 UUID。
      this.state.serviceId = undefined;
      this.state.rxCharId = undefined;
      this.state.txCharId = undefined;
      this.log(`连接状态变化：已断开 deviceId=${dev}`);
      this.emitConn(false);
    });
  }

  async scanAndConnectFirstCody(timeoutMs = 10000): Promise<void> {
    if (!this.state.adapterReady) await this.openAdapter();

    const found = await this.scanFirstMatch((d) => {
      const name = d.name || d.localName || "";
      return name.startsWith("Cody-");
    }, timeoutMs);

    await this.connect(found.deviceId);
    await this.discoverAndSubscribe();
  }

  private async scanFirstMatch(match: (d: WechatMiniprogram.BlueToothDevice) => boolean, timeoutMs: number)
    : Promise<WechatMiniprogram.BlueToothDevice> {
    this.state.scanning = true;

    const seen = new Map<string, WechatMiniprogram.BlueToothDevice>();

    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (err?: Error, dev?: WechatMiniprogram.BlueToothDevice) => {
        if (done) return;
        done = true;
        this.state.scanning = false;
        wx.stopBluetoothDevicesDiscovery({ complete: () => { } });
        wx.offBluetoothDeviceFound(onFound as any);
        clearTimeout(t);
        if (err) reject(err);
        else resolve(dev!);
      };

      const onFound = (res: WechatMiniprogram.OnBluetoothDeviceFoundCallbackResult) => {
        for (const d of res.devices || []) {
          if (!d.deviceId) continue;
          if (!seen.has(d.deviceId)) seen.set(d.deviceId, d);
          if (match(d)) finish(undefined, d);
        }
      };

      wx.onBluetoothDeviceFound(onFound);

      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: false,
        success: () => { },
        fail: (e) => finish(new Error(e?.errMsg || "startBluetoothDevicesDiscovery failed")),
      });

      const t = setTimeout(() => {
        const any = Array.from(seen.values())[0];
        if (any && match(any)) finish(undefined, any);
        else finish(new Error("scan timeout: no Cody-* device found"));
      }, timeoutMs);
    });
  }

  async connect(deviceId: string): Promise<void> {
    await p<void>((resolve, reject) => {
      wx.createBLEConnection({
        deviceId,
        success: () => resolve(),
        fail: (e) => reject(new Error(e?.errMsg || "createBLEConnection failed")),
      });
    });
    this.state.connected = true;
    this.state.deviceId = deviceId;
  }

  async reconnect(): Promise<void> {
    const deviceId = must(this.state.deviceId, "no deviceId");
    if (!this.state.adapterReady) await this.openAdapter();
    await this.connect(deviceId);
    await this.discoverAndSubscribe();
  }

  async discoverAndSubscribe(): Promise<void> {
    const deviceId = must(this.state.deviceId, "no deviceId");

    const services = await p<WechatMiniprogram.GetBLEDeviceServicesSuccessCallbackResult>((resolve, reject) => {
      wx.getBLEDeviceServices({
        deviceId,
        success: resolve,
        fail: (e) => reject(new Error(e?.errMsg || "getBLEDeviceServices failed")),
      });
    });

    const svc = (services.services || []).find(s => normUuid(s.uuid) === normUuid(SERVICE_UUID));
    if (!svc) throw new Error("service not found: " + SERVICE_UUID);
    this.state.serviceId = svc.uuid;

    const chars = await p<WechatMiniprogram.GetBLEDeviceCharacteristicsSuccessCallbackResult>((resolve, reject) => {
      wx.getBLEDeviceCharacteristics({
        deviceId,
        serviceId: svc.uuid,
        success: resolve,
        fail: (e) => reject(new Error(e?.errMsg || "getBLEDeviceCharacteristics failed")),
      });
    });

    const rx = (chars.characteristics || []).find(c => normUuid(c.uuid) === normUuid(RX_UUID));
    const tx = (chars.characteristics || []).find(c => normUuid(c.uuid) === normUuid(TX_UUID));
    if (!rx) throw new Error("rx characteristic not found: " + RX_UUID);
    if (!tx) throw new Error("tx characteristic not found: " + TX_UUID);
    this.state.rxCharId = rx.uuid;
    this.state.txCharId = tx.uuid;

    await p<void>((resolve, reject) => {
      wx.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId: svc.uuid,
        characteristicId: tx.uuid,
        state: true,
        success: () => resolve(),
        fail: (e) => reject(new Error(e?.errMsg || "notifyBLECharacteristicValueChange failed")),
      });
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    // 所有 write 必须串行化（单飞），避免并发写导致随机失败/卡住。
    this._writeQ = this._writeQ.then(async () => {
      const deviceId = must(this.state.deviceId, "no deviceId");
      const serviceId = must(this.state.serviceId, "no serviceId");
      const characteristicId = must(this.state.rxCharId, "no rxCharId");

      await p<void>((resolve, reject) => {
        wx.writeBLECharacteristicValue({
          deviceId,
          serviceId,
          characteristicId,
          value: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          success: () => resolve(),
          fail: (e) => reject(new Error(e?.errMsg || "writeBLECharacteristicValue failed")),
        });
      });
    });

    return this._writeQ;
  }

  nextSessionSeq(): { session: number; seq: number } {
    const session = this.session & 0xff;
    const seq = this.seq & 0xff;
    this.seq = (this.seq + 1) & 0xff;
    return { session, seq };
  }

  async sendFrameStopAndWait(type: number, payload: Uint8Array, opts?: { timeoutMs?: number; retries?: number }): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 800;
    const retries = opts?.retries ?? 3;
    const { session, seq } = this.nextSessionSeq();
    const frame = buildFrame(type, session, seq, payload);

    for (let attempt = 1; attempt <= retries; attempt++) {
      await this.write(frame);
      const res = await this.waitAckGenericResult(session, seq, type, timeoutMs);
      if (res === 0) return;
      if (res !== null) throw new Error(`ACK errCode=${res} for type=0x${type.toString(16)}`);
    }
    throw new Error(`timeout: no ACK for type=0x${type.toString(16)}`);
  }

  async sendFrameStopAndWaitDetailed(
    type: number,
    payload: Uint8Array,
    opts?: { timeoutMs?: number; retries?: number }
  ): Promise<{ attempts: number; errCode: number }> {
    const timeoutMs = opts?.timeoutMs ?? 800;
    const retries = opts?.retries ?? 3;
    const { session, seq } = this.nextSessionSeq();
    const frame = buildFrame(type, session, seq, payload);

    for (let attempt = 1; attempt <= retries; attempt++) {
      await this.write(frame);
      const res = await this.waitAckGenericResult(session, seq, type, timeoutMs);
      if (res === null) continue;
      return { attempts: attempt, errCode: res };
    }
    throw new Error(`timeout: no ACK for type=0x${type.toString(16)}`);
  }

  async sendAck(session: number, seq: number, origType: number, errCode = 0): Promise<void> {
    await this.write(buildAck(session, seq, origType, errCode));
  }

  async sendPingStopAndWait(opts?: { timeoutMs?: number; retries?: number }): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 800;
    const retries = opts?.retries ?? 3;

    const session = this.session & 0xff;
    const seq = this.seq & 0xff;
    this.seq = (this.seq + 1) & 0xff;

    const frame = buildPing(session, seq);

    for (let attempt = 1; attempt <= retries; attempt++) {
      await this.write(frame);
      const ok = await this.waitAckPing(session, seq, timeoutMs);
      if (ok) return;
    }
    throw new Error("PING timeout (no ACK after retries)");
  }

  private waitAckPing(session: number, seq: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const cb = (f: Frame) => {
        if (done) return;
        if (f.session !== (session & 0xff)) return;
        if (f.seq !== (seq & 0xff)) return;
        if (!isAckForPingOk(f)) return;
        done = true;
        clearTimeout(t);
        cleanup();
        resolve(true);
      };

      this.onFrameHandlers.push(cb);

      const cleanup = () => {
        const idx = this.onFrameHandlers.indexOf(cb);
        if (idx >= 0) this.onFrameHandlers.splice(idx, 1);
      };

      const t = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve(false);
      }, timeoutMs);
    });
  }

  private waitAckGenericResult(session: number, seq: number, origType: number, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve) => {
      let done = false;
      const cb = (f: Frame) => {
        if (done) return;
        if (f.type !== FrameType.Ack) return;
        if (f.session !== (session & 0xff)) return;
        if (f.seq !== (seq & 0xff)) return;
        if (f.payload.length < 2) return;
        if (f.payload[0] !== (origType & 0xff)) return;
        done = true;
        clearTimeout(t);
        cleanup();
        resolve(f.payload[1] & 0xff);
      };

      this.onFrameHandlers.push(cb);

      const cleanup = () => {
        const idx = this.onFrameHandlers.indexOf(cb);
        if (idx >= 0) this.onFrameHandlers.splice(idx, 1);
      };

      const t = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve(null);
      }, timeoutMs);
    });
  }
}

function normUuid(u: string): string {
  return (u || "").toLowerCase();
}

function must<T>(v: T | undefined, msg: string): T {
  if (v === undefined || v === null) throw new Error(msg);
  return v;
}

function p<T>(fn: (resolve: (v: T) => void, reject: (e: any) => void) => void): Promise<T> {
  return new Promise(fn);
}

export const ble = new BleCodyClient();

