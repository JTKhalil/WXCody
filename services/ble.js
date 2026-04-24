import { FrameParser, FrameType, buildAck, buildFrame, buildPing, isAckForPingOk } from "./proto_bin";

const SERVICE_UUID = "0000C0DE-0000-1000-8000-00805F9B34FB";
const RX_UUID = "0000C0D1-0000-1000-8000-00805F9B34FB";
const TX_UUID = "0000C0D2-0000-1000-8000-00805F9B34FB";

export class BleCodyClient {
  state = { adapterReady: false, scanning: false, connected: false };

  parser = new FrameParser();
  onFrameHandlers = [];
  onConnHandlers = [];
  onJsonHandlers = [];
  _jsonBuf = "";
  _jsonBytes = new Uint8Array(0);

  session = 1;
  seq = 1;

  _adapterInited = false;
  _writeQ = Promise.resolve();
  _readyQ = Promise.resolve();

  _logMaxLines = 500;
  _logLines = [];

  onFrame(cb) {
    this.onFrameHandlers.push(cb);
    return () => {
      const idx = this.onFrameHandlers.indexOf(cb);
      if (idx >= 0) this.onFrameHandlers.splice(idx, 1);
    };
  }

  onConnectionStateChange(cb) {
    this.onConnHandlers.push(cb);
    return () => {
      const idx = this.onConnHandlers.indexOf(cb);
      if (idx >= 0) this.onConnHandlers.splice(idx, 1);
    };
  }

  onJson(cb) {
    this.onJsonHandlers.push(cb);
    return () => {
      const idx = this.onJsonHandlers.indexOf(cb);
      if (idx >= 0) this.onJsonHandlers.splice(idx, 1);
    };
  }

  emitFrame(f) {
    for (const cb of this.onFrameHandlers) cb(f);
  }

  emitConn(connected) {
    for (const cb of this.onConnHandlers) cb(connected);
  }

  emitJson(obj) {
    for (const cb of this.onJsonHandlers) cb(obj);
  }

  log(line) {
    const ts = new Date();
    const stamp = `${ts.getHours().toString().padStart(2, "0")}:${ts.getMinutes().toString().padStart(2, "0")}:${ts
      .getSeconds()
      .toString()
      .padStart(2, "0")}.${ts.getMilliseconds().toString().padStart(3, "0")}`;
    this._logLines.unshift(`[${stamp}] ${line}`);
    if (this._logLines.length > this._logMaxLines) this._logLines.length = this._logMaxLines;
  }

  clearLogs() {
    this._logLines = [];
  }

  getLogs() {
    return [...this._logLines];
  }

  getLogsText(opts) {
    const maxChars = (opts && opts.maxChars) || 8000;
    let out = "";
    for (const line of this._logLines) {
      const next = line + "\n";
      if (out.length + next.length > maxChars) break;
      out += next;
    }
    return out.trimEnd();
  }

  async copyLogs(opts) {
    const text = this.getLogsText({ maxChars: (opts && opts.maxChars) || 20000 });
    await p((resolve, reject) => {
      wx.setClipboardData({
        data: text || "(空)",
        success: () => resolve(),
        fail: (e) => reject(new Error((e && e.errMsg) || "setClipboardData failed")),
      });
    });
  }

  async openAdapter() {
    // 注意：用户可能在系统里把蓝牙关闭了，但我们之前的 state.adapterReady 仍为 true。
    // 若此处直接 return，会导致后续扫描不报错、UI 也不会提示“请打开蓝牙”。
    if (this._adapterInited && this.state.adapterReady) {
      try {
        const st = await p((resolve, reject) => {
          wx.getBluetoothAdapterState({
            success: (s) => resolve(s),
            fail: (e) => reject(new Error((e && e.errMsg) || "getBluetoothAdapterState failed")),
          });
        });
        if (st && st.available) return;
      } catch (_) {}
      // 认为已不可用：强制走 openBluetoothAdapter 的失败路径，让上层能提示用户
      this.state.adapterReady = false;
    }
    await p((resolve, reject) => {
      wx.openBluetoothAdapter({
        success: () => resolve(),
        fail: (e) => reject(new Error((e && e.errMsg) || "openBluetoothAdapter failed")),
      });
    });
    this.state.adapterReady = true;
    this._adapterInited = true;

    // 跟踪系统蓝牙开关，便于上层判断“是否可用”
    try {
      wx.onBluetoothAdapterStateChange((st) => {
        this.state.adapterReady = !!(st && st.available);
      });
    } catch (_) {}

    wx.onBLECharacteristicValueChange((evt) => {
      if (!evt || !evt.value) return;
      const u8 = new Uint8Array(evt.value);
      // JSONL 可能被 BLE notify 分片：首包以 '{' 开头，后续包可能不是 '{'。
      // 为避免把二进制流误判为文本导致解码/JSON 缓冲暴涨，这里只在“确定是 JSONL/OK”时才喂给文本解析器。
      const hasJsonListeners = this.onJsonHandlers.length > 0;
      const hasFrameListeners = this.onFrameHandlers.length > 0;

      // JSONL（仅在确实有人消费时才做解码/拼包，避免 JS 线程被拖死）
      // 注意：JSONL 可能被分片 notify；判断是否继续消费要看“字节缓冲”是否非空，而不是旧的字符串缓冲。
      if (hasJsonListeners || (this._jsonBytes && this._jsonBytes.length > 0)) {
        const b0 = u8.length ? (u8[0] & 0xff) : 0;
        const looksJsonStart = (b0 === 0x7b /* '{' */);
        const looksOkStart = (b0 === 0x4f /* 'O' */);
        if ((this._jsonBytes && this._jsonBytes.length > 0) || looksJsonStart || looksOkStart) {
          this._consumeJsonl(u8);
        }
      }

      // 二进制帧（仅在确实有人消费时才做解析）
      if (!hasFrameListeners) return;
      const frames = this.parser.push(evt.value);
      for (const f of frames) this.emitFrame(f);
    });

    wx.onBLEConnectionStateChange((evt) => {
      const dev = (evt && evt.deviceId) || "";
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
      this.state.serviceId = undefined;
      this.state.rxCharId = undefined;
      this.state.txCharId = undefined;
      this.state.authed = false;
      this._jsonBuf = "";
      this._jsonBytes = new Uint8Array(0);
      this.log(`连接状态变化：已断开 deviceId=${dev}`);
      this.emitConn(false);
    });
  }

  async closeAdapter() {
    try {
      await p((resolve) => {
        wx.closeBluetoothAdapter({
          success: () => resolve(),
          fail: () => resolve(),
        });
      });
    } catch (_) {}
    this.state.adapterReady = false;
    this.state.scanning = false;
    this._adapterInited = false;
  }

  async auth(pass, opts) {
    const p = String(pass || "").trim();
    if (!p) throw new Error("password empty");
    const r = await this.sendJsonStopAndWait({ cmd: "auth", pass: p }, { timeoutMs: (opts && opts.timeoutMs) || 1200, retries: (opts && opts.retries) || 2 });
    if (!r || r.cmd !== "auth") throw new Error("auth: no response");
    if (r.status !== "ok") throw new Error("auth failed: " + ((r && r.msg) || "error"));
    this.state.authed = true;
    return true;
  }

  _consumeJsonl(bytes) {
    // 重要：对端会把一行 JSONL 分片 notify（可能在 UTF-8 多字节字符中间断包）。
    // 因此不能“每个 notify 先解码成字符串再拼接”，否则中文等会被解码破坏导致 JSON.parse 失败。
    // 改为：按字节拼接，遇到 '\n' 再整行解码。
    const incoming = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!incoming.length) return;
    if (!this._jsonBytes || !this._jsonBytes.length) {
      this._jsonBytes = incoming;
    } else {
      const out = new Uint8Array(this._jsonBytes.length + incoming.length);
      out.set(this._jsonBytes, 0);
      out.set(incoming, this._jsonBytes.length);
      this._jsonBytes = out;
    }

    if (this._jsonBytes.length > 256 * 1024) {
      this._jsonBytes = this._jsonBytes.subarray(this._jsonBytes.length - 128 * 1024);
      this.log("JSONL bytes trimmed");
    }

    while (true) {
      let nl = -1;
      for (let i = 0; i < this._jsonBytes.length; i++) {
        if (this._jsonBytes[i] === 0x0a) { nl = i; break; }
      }
      if (nl < 0) break;

      const lineBytes = this._jsonBytes.subarray(0, nl);
      this._jsonBytes = this._jsonBytes.subarray(nl + 1);

      const line = (utf8Decode(lineBytes) || "").trim();
      if (!line) continue;
      if (line === "OK") {
        this.log("[jsonl] OK");
        continue;
      }
      try {
        const obj = JSON.parse(line);
        this.emitJson(obj);
      } catch (e) {
        this.log("JSONL parse FAIL: " + String(e));
      }
    }
  }

  async scanAndConnectFirstCody(timeoutMs = 10000) {
    if (!this.state.adapterReady) await this.openAdapter();

    const found = await this.scanFirstMatch((d) => {
      const name = d.name || d.localName || "";
      return name.startsWith("Cody-");
    }, timeoutMs);

    await this.connect(found.deviceId);
    await this.discoverAndSubscribe();
  }

  async scanCodyDevices(listenMs = 5000) {
    if (!this.state.adapterReady) await this.openAdapter();
    this.state.scanning = true;
    const seen = new Map();
    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        this.state.scanning = false;
        try { wx.stopBluetoothDevicesDiscovery({ complete: () => {} }); } catch (_) {}
        try { wx.offBluetoothDeviceFound(onFound); } catch (_) {}
        clearTimeout(t);
        if (err) reject(err);
        else {
          const normName = (d) => {
            const advName = parseAdvLocalName(d && d.advertisData);
            return String(advName || d.localName || d.name || "").trim();
          };

          let out = Array.from(seen.values())
            .map((d) => {
              const displayName = normName(d);
              return { ...d, displayName };
            })
            .filter((d) => (d.displayName || "").startsWith("Cody-"))
            .sort((a, b) => ((b.RSSI || -999) - (a.RSSI || -999)));

          // 若微信返回的 displayName 仍然相同（常见：用 name 缓存），则附加 deviceId 后缀辅助区分
          const cnt = new Map();
          for (const d of out) cnt.set(d.displayName, (cnt.get(d.displayName) || 0) + 1);
          out = out.map((d) => {
            if ((cnt.get(d.displayName) || 0) <= 1) return d;
            const id = String(d.deviceId || "");
            const suf = id ? id.slice(-4).toUpperCase() : "";
            return { ...d, displayName: suf ? `${d.displayName}-${suf}` : d.displayName };
          });
          resolve(out);
        }
      };

      const onFound = (res) => {
        for (const d of (res && res.devices) || []) {
          if (!d.deviceId) continue;
          const prev = seen.get(d.deviceId) || {};
          // keep strongest RSSI and latest name
          const merged = { ...prev, ...d };
          if ((prev.RSSI || -999) > (d.RSSI || -999)) merged.RSSI = prev.RSSI;
          seen.set(d.deviceId, merged);
        }
      };

      wx.onBluetoothDeviceFound(onFound);
      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: true,
        success: () => {},
        fail: (e) => finish(new Error((e && e.errMsg) || "startBluetoothDevicesDiscovery failed")),
      });

      const t = setTimeout(() => finish(undefined), listenMs);
    });
  }

  async scanFirstMatch(match, timeoutMs) {
    this.state.scanning = true;
    const seen = new Map();

    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (err, dev) => {
        if (done) return;
        done = true;
        this.state.scanning = false;
        wx.stopBluetoothDevicesDiscovery({ complete: () => {} });
        wx.offBluetoothDeviceFound(onFound);
        clearTimeout(t);
        if (err) reject(err);
        else resolve(dev);
      };

      const onFound = (res) => {
        for (const d of (res && res.devices) || []) {
          if (!d.deviceId) continue;
          if (!seen.has(d.deviceId)) seen.set(d.deviceId, d);
          if (match(d)) finish(undefined, d);
        }
      };

      wx.onBluetoothDeviceFound(onFound);

      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: false,
        success: () => {},
        fail: (e) => finish(new Error((e && e.errMsg) || "startBluetoothDevicesDiscovery failed")),
      });

      const t = setTimeout(() => {
        const any = Array.from(seen.values())[0];
        if (any && match(any)) finish(undefined, any);
        else finish(new Error("scan timeout: no Cody-* device found"));
      }, timeoutMs);
    });
  }

  async connect(deviceId) {
    await p((resolve, reject) => {
      wx.createBLEConnection({
        deviceId,
        success: () => resolve(),
        fail: (e) => reject(new Error((e && e.errMsg) || "createBLEConnection failed")),
      });
    });
    this.state.connected = true;
    this.state.deviceId = deviceId;
  }

  async disconnect() {
    const deviceId = this.state.deviceId;
    if (!deviceId) return;
    try {
      await p((resolve) => {
        wx.closeBLEConnection({
          deviceId,
          success: () => resolve(),
          fail: () => resolve(),
        });
      });
    } catch (_) {}
    this.state.connected = false;
    this.state.scanning = false;
    this.state.serviceId = undefined;
    this.state.rxCharId = undefined;
    this.state.txCharId = undefined;
    this._jsonBuf = "";
    this._jsonBytes = new Uint8Array(0);
  }

  async reconnect() {
    const deviceId = must(this.state.deviceId, "no deviceId");
    if (!this.state.adapterReady) await this.openAdapter();
    await this.connect(deviceId);
    await this.discoverAndSubscribe();
  }

  async discoverAndSubscribe() {
    const deviceId = must(this.state.deviceId, "no deviceId");

    const services = await p((resolve, reject) => {
      wx.getBLEDeviceServices({
        deviceId,
        success: resolve,
        fail: (e) => reject(new Error((e && e.errMsg) || "getBLEDeviceServices failed")),
      });
    });

    const svc = (services.services || []).find((s) => normUuid(s.uuid) === normUuid(SERVICE_UUID));
    if (!svc) throw new Error("service not found: " + SERVICE_UUID);
    this.state.serviceId = svc.uuid;

    const chars = await p((resolve, reject) => {
      wx.getBLEDeviceCharacteristics({
        deviceId,
        serviceId: svc.uuid,
        success: resolve,
        fail: (e) => reject(new Error((e && e.errMsg) || "getBLEDeviceCharacteristics failed")),
      });
    });

    const rx = (chars.characteristics || []).find((c) => normUuid(c.uuid) === normUuid(RX_UUID));
    const tx = (chars.characteristics || []).find((c) => normUuid(c.uuid) === normUuid(TX_UUID));
    if (!rx) throw new Error("rx characteristic not found: " + RX_UUID);
    if (!tx) throw new Error("tx characteristic not found: " + TX_UUID);
    this.state.rxCharId = rx.uuid;
    this.state.txCharId = tx.uuid;
    // Track whether we can use WriteWithoutResponse for higher throughput (OTA/images).
    try {
      const p = rx.properties || {};
      this.state.rxWriteNoResp = !!(p.writeNoResponse || p.write_no_response || p.writeNR || p.write_nr);
    } catch (_) {
      this.state.rxWriteNoResp = false;
    }

    // Try to increase MTU (Android supported) to reduce fragmentation.
    // If unsupported, it will just fail silently.
    try {
      if (wx.canIUse && wx.canIUse("setBLEMTU")) {
        const desired = 185;
        await p((resolve) => {
          wx.setBLEMTU({
            deviceId,
            mtu: desired,
            success: (res) => {
              try { this.state.mtu = Number(res && res.mtu) || desired; } catch (_) { this.state.mtu = desired; }
              resolve();
            },
            fail: () => resolve(),
          });
        });
      }
    } catch (_) {}

    await p((resolve, reject) => {
      wx.notifyBLECharacteristicValueChange({
        deviceId,
        serviceId: svc.uuid,
        characteristicId: tx.uuid,
        state: true,
        success: () => resolve(),
        fail: (e) => reject(new Error((e && e.errMsg) || "notifyBLECharacteristicValueChange failed")),
      });
    });
  }

  async _ensureReady() {
    // 已经 ready
    if (this.state.serviceId && this.state.rxCharId && this.state.txCharId) return;
    // 未连接无法 ready
    if (!this.state.connected) return;
    if (!this.state.deviceId) return;
    // 需要发现服务/特征并开启 notify
    await this.discoverAndSubscribe();
  }

  async write(bytes, opts) {
    // 确保已 discover + subscribe（避免 console 页过早发送导致 no serviceId）
    this._readyQ = this._readyQ.then(async () => {
      await this._ensureReady();
    });
    await this._readyQ;

    this._writeQ = this._writeQ.then(async () => {
      const deviceId = must(this.state.deviceId, "no deviceId");
      const serviceId = must(this.state.serviceId, "no serviceId");
      const characteristicId = must(this.state.rxCharId, "no rxCharId");

      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const kind = (opts && opts.kind) || "bin";
      // JSON：必须分片（常见 20B 限制），否则可能只到半截导致 Cody 端无法解析 '\n' 行结束。
      // BIN：优先走“单次写完整帧”（更快）；若设备/机型不支持再回退分片。
      const perChunkDelayMs = kind === "json" ? 6 : 0;
      const wantNoResp = (kind === "bin") && !!this.state.rxWriteNoResp;
      const canWriteType = !!(wx.canIUse && wx.canIUse("writeBLECharacteristicValue.writeType"));

      const writeOnce = async (part) => {
        await p((resolve, reject) => {
          const args = {
            deviceId,
            serviceId,
            characteristicId,
            value: part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
            success: () => resolve(),
            fail: (e) => reject(new Error((e && e.errMsg) || "writeBLECharacteristicValue failed")),
          };
          if (wantNoResp && canWriteType) {
            args.writeType = "writeNoResponse";
          }
          wx.writeBLECharacteristicValue(args);
        });
      };

      if (kind === "bin") {
        // Fast path: write full frame in one call (older behavior).
        // If it fails (e.g. MTU too small), fall back to chunked writes.
        try {
          await writeOnce(u8);
          return;
        } catch (_) {
          // fall through to chunking
        }
      }

      // Chunking path (always used for JSON)
      const mtu = Number(this.state.mtu) || 0;
      const kChunk = (mtu >= 60) ? Math.min(180, Math.max(20, mtu - 3)) : 20;
      for (let off = 0; off < u8.length; off += kChunk) {
        const part = u8.subarray(off, Math.min(u8.length, off + kChunk));
        await writeOnce(part);
        if (perChunkDelayMs > 0 && off + kChunk < u8.length) {
          await new Promise((r) => setTimeout(r, perChunkDelayMs));
        }
      }
    });

    return this._writeQ;
  }

  async sendJson(obj) {
    const line = JSON.stringify(obj) + "\n";
    try {
      this.log("[tx json] " + line.trimEnd());
    } catch (_) {}
    await this.write(utf8Encode(line), { kind: "json" });
  }

  async sendJsonStopAndWait(obj, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 800;
    const retries = (opts && opts.retries) || 3;
    const expectCmd = obj && obj.cmd;
    if (!expectCmd) throw new Error("sendJsonStopAndWait: missing cmd");

    for (let attempt = 1; attempt <= retries; attempt++) {
      await this.sendJson(obj);
      const resp = await this.waitJsonOnce(expectCmd, timeoutMs);
      if (resp) return resp;
    }
    throw new Error("timeout: no JSON resp for cmd=" + expectCmd);
  }

  waitJsonOnce(expectCmd, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const cb = (obj) => {
        if (done) return;
        if (!obj || obj.cmd !== expectCmd) return;
        done = true;
        clearTimeout(t);
        cleanup();
        resolve(obj);
      };
      this.onJsonHandlers.push(cb);
      const cleanup = () => {
        const idx = this.onJsonHandlers.indexOf(cb);
        if (idx >= 0) this.onJsonHandlers.splice(idx, 1);
      };
      const t = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve(null);
      }, timeoutMs);
    });
  }

  nextSessionSeq() {
    const session = this.session & 0xff;
    const seq = this.seq & 0xff;
    this.seq = (this.seq + 1) & 0xff;
    return { session, seq };
  }

  async sendFrameStopAndWait(type, payload, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 800;
    const retries = (opts && opts.retries) || 3;
    const { session, seq } = this.nextSessionSeq();
    const frame = buildFrame(type, session, seq, payload);

    for (let attempt = 1; attempt <= retries; attempt++) {
      await this.write(frame, { kind: "bin" });
      const res = await this.waitAckGenericResult(session, seq, type, timeoutMs);
      if (res === 0) return;
      if (res !== null) throw new Error(`ACK errCode=${res} for type=0x${type.toString(16)}`);
    }
    throw new Error(`timeout: no ACK for type=0x${type.toString(16)}`);
  }

  async sendFrameStopAndWaitDetailed(type, payload, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 800;
    const retries = (opts && opts.retries) || 3;
    const { session, seq } = this.nextSessionSeq();
    const frame = buildFrame(type, session, seq, payload);

    for (let attempt = 1; attempt <= retries; attempt++) {
      await this.write(frame, { kind: "bin" });
      const res = await this.waitAckGenericResult(session, seq, type, timeoutMs);
      if (res === null) continue;
      return { attempts: attempt, errCode: res };
    }
    throw new Error(`timeout: no ACK for type=0x${type.toString(16)}`);
  }

  async sendFrameNoWaitDetailed(type, payload, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 1200;
    const { session, seq } = this.nextSessionSeq();
    const frame = buildFrame(type, session, seq, payload);
    const ackP = this.waitAckGenericResult(session, seq, type, timeoutMs);
    await this.write(frame, { kind: "bin" });
    return { session, seq, ackP };
  }

  async sendAck(session, seq, origType, errCode = 0) {
    await this.write(buildAck(session, seq, origType, errCode), { kind: "bin" });
  }

  async sendPingStopAndWait(opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 800;
    const retries = (opts && opts.retries) || 3;

    const session = this.session & 0xff;
    const seq = this.seq & 0xff;
    this.seq = (this.seq + 1) & 0xff;

    const frame = buildPing(session, seq);

    for (let attempt = 1; attempt <= retries; attempt++) {
      await this.write(frame, { kind: "bin" });
      const ok = await this.waitAckPing(session, seq, timeoutMs);
      if (ok) return;
    }
    throw new Error("PING timeout (no ACK after retries)");
  }

  waitAckPing(session, seq, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const cb = (f) => {
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

  waitAckGenericResult(session, seq, origType, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const cb = (f) => {
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

function normUuid(u) {
  return (u || "").toLowerCase();
}

function must(v, msg) {
  if (v === undefined || v === null) throw new Error(msg);
  return v;
}

function p(fn) {
  return new Promise(fn);
}

export const ble = new BleCodyClient();

function parseAdvLocalName(advertisData) {
  try {
    if (!advertisData) return "";
    const u8 = advertisData instanceof Uint8Array ? advertisData : new Uint8Array(advertisData);
    // AD structure: [len][type][data...]
    for (let i = 0; i < u8.length; ) {
      const len = u8[i++] & 0xff;
      if (!len) break;
      const end = Math.min(u8.length, i + len);
      const type = u8[i++] & 0xff;
      // 0x09: Complete Local Name, 0x08: Shortened Local Name
      if (type === 0x09 || type === 0x08) {
        const nameBytes = u8.subarray(i, end);
        return (utf8Decode(nameBytes) || "").trim();
      }
      i = end;
    }
  } catch (_) {}
  return "";
}

function utf8Encode(str) {
  try {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  } catch (_) {}
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c <= 0x7f) out.push(c);
    else if (c <= 0x7ff) {
      out.push(0xc0 | (c >> 6));
      out.push(0x80 | (c & 0x3f));
    } else if (c <= 0xffff) {
      out.push(0xe0 | (c >> 12));
      out.push(0x80 | ((c >> 6) & 0x3f));
      out.push(0x80 | (c & 0x3f));
    } else {
      out.push(0xf0 | (c >> 18));
      out.push(0x80 | ((c >> 12) & 0x3f));
      out.push(0x80 | ((c >> 6) & 0x3f));
      out.push(0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes) {
  try {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
  } catch (_) {}
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++] & 0xff;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      continue;
    }
    if ((b0 & 0xe0) === 0xc0) {
      const b1 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | b1);
      continue;
    }
    if ((b0 & 0xf0) === 0xe0) {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
      continue;
    }
    if ((b0 & 0xf8) === 0xf0) {
      const b1 = bytes[i++] & 0x3f;
      const b2 = bytes[i++] & 0x3f;
      const b3 = bytes[i++] & 0x3f;
      let cp = ((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3;
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + ((cp >> 10) & 0x3ff));
      out += String.fromCharCode(0xdc00 + (cp & 0x3ff));
      continue;
    }
  }
  return out;
}

// isTextLike removed: too easy to misclassify binary traffic

