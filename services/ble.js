import {
  FrameParser,
  FrameType,
  buildAck,
  buildFrame,
  buildHanddrawStrokePayload,
  buildHanddrawStrokeBatchPayload,
  buildPing,
  isAckForPingOk,
} from "./proto_bin";

const SERVICE_UUID = "0000C0DE-0000-1000-8000-00805F9B34FB";
const RX_UUID = "0000C0D1-0000-1000-8000-00805F9B34FB";
const TX_UUID = "0000C0D2-0000-1000-8000-00805F9B34FB";

function withTimeout(promise, timeoutMs, msg) {
  let t = 0;
  const timeoutP = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(msg || "timeout")), timeoutMs);
  });
  return Promise.race([promise, timeoutP]).finally(() => {
    if (t) clearTimeout(t);
  });
}

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
  /** 微信全局 BLE 监听只能注册一次；重复 on* 会导致同一断连事件触发多遍 emitConn / reLaunch */
  _wxBleCoreListenersBound = false;
  _writeQ = Promise.resolve();
  _readyQ = Promise.resolve();
  /** 手绘笔迹世代：清屏 bump 后，队列中旧世代的写入会被丢弃，避免清屏后仍画出未同步笔迹 */
  _handdrawStrokeGen = 0;
  /** 你画我猜：页面与 App.onHide 据此在退出/切后台时通知 Cody 收起倒计时与答案 */
  _handdrawGuessGameActive = false;

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
    // 全局兜底：蓝牙断开时回到连接页，避免停留在控制台/设置等页面造成“假在线”
    try {
      if (connected) return;
      this._handdrawGuessGameActive = false;
      const pages = (typeof getCurrentPages === "function") ? getCurrentPages() : [];
      const cur = pages && pages.length ? pages[pages.length - 1] : null;
      const route = (cur && cur.route) ? String(cur.route) : "";
      // 连接页/闪屏页不跳转，避免循环
      if (route === "pages/connect/connect" || route === "pages/splash/splash") return;
      wx.reLaunch({ url: "/pages/connect/connect" });
    } catch (_) {}
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

  getHanddrawStrokeGeneration() {
    return this._handdrawStrokeGen;
  }

  bumpHanddrawStrokeGeneration() {
    this._handdrawStrokeGen = (this._handdrawStrokeGen + 1) >>> 0;
  }

  setHanddrawGuessGameActive(v) {
    this._handdrawGuessGameActive = !!v;
  }

  /**
   * 小程序切后台或被关闭时（App.onHide）调用：若你画我猜进行中则通知设备结束，去掉倒计时与答案展示。
   */
  endHanddrawGuessGameIfAppBackground() {
    if (!this._handdrawGuessGameActive) return;
    this._handdrawGuessGameActive = false;
    if (!this.state.connected) return;
    const run = async () => {
      const dismiss = { cmd: "guess_game_end", reveal: false };
      try {
        await this.sendJsonStopAndWait(dismiss, { timeoutMs: 2200, retries: 2 });
      } catch (_) {
        try {
          await this.sendJson(dismiss);
        } catch (e2) {}
      }
    };
    run().catch(() => {});
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

    if (!this._wxBleCoreListenersBound) {
      this._wxBleCoreListenersBound = true;
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
    const timeoutMs = 8000;
    await withTimeout(
      p((resolve, reject) => {
        wx.createBLEConnection({
          deviceId,
          success: () => resolve(),
          fail: (e) => reject(new Error((e && e.errMsg) || "createBLEConnection failed")),
        });
      }),
      timeoutMs,
      "createBLEConnection timeout"
    );
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
    // 重要：断开后重置写队列，避免上一次 write 悬挂导致后续永远卡住
    this._writeQ = Promise.resolve();
    this._readyQ = Promise.resolve();
    this._handdrawStrokeGen = 0;
  }

  async reconnect() {
    const deviceId = must(this.state.deviceId, "no deviceId");
    if (!this.state.adapterReady) await this.openAdapter();
    await this.connect(deviceId);
    await this.discoverAndSubscribe();
  }

  async discoverAndSubscribe() {
    const deviceId = must(this.state.deviceId, "no deviceId");

    const stepTimeoutMs = 6000;
    const services = await withTimeout(
      p((resolve, reject) => {
        wx.getBLEDeviceServices({
          deviceId,
          success: resolve,
          fail: (e) => reject(new Error((e && e.errMsg) || "getBLEDeviceServices failed")),
        });
      }),
      stepTimeoutMs,
      "getBLEDeviceServices timeout"
    );

    const svc = (services.services || []).find((s) => normUuid(s.uuid) === normUuid(SERVICE_UUID));
    if (!svc) throw new Error("service not found: " + SERVICE_UUID);
    this.state.serviceId = svc.uuid;

    const chars = await withTimeout(
      p((resolve, reject) => {
        wx.getBLEDeviceCharacteristics({
          deviceId,
          serviceId: svc.uuid,
          success: resolve,
          fail: (e) => reject(new Error((e && e.errMsg) || "getBLEDeviceCharacteristics failed")),
        });
      }),
      stepTimeoutMs,
      "getBLEDeviceCharacteristics timeout"
    );

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
        const desired = 247;
        await withTimeout(
          p((resolve) => {
            wx.setBLEMTU({
              deviceId,
              mtu: desired,
              success: (res) => {
                try { this.state.mtu = Number(res && res.mtu) || desired; } catch (_) { this.state.mtu = desired; }
                resolve();
              },
              fail: () => resolve(),
            });
          }),
          2000,
          "setBLEMTU timeout"
        );
      }
    } catch (_) {}

    await withTimeout(
      p((resolve, reject) => {
        wx.notifyBLECharacteristicValueChange({
          deviceId,
          serviceId: svc.uuid,
          characteristicId: tx.uuid,
          state: true,
          success: () => resolve(),
          fail: (e) => reject(new Error((e && e.errMsg) || "notifyBLECharacteristicValueChange failed")),
        });
      }),
      stepTimeoutMs,
      "notifyBLECharacteristicValueChange timeout"
    );
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

    const strokeGen = opts && typeof opts.handdrawStrokeGen === "number" ? opts.handdrawStrokeGen : null;
    this._writeQ = this._writeQ.then(async () => {
      if (strokeGen !== null && strokeGen !== this._handdrawStrokeGen) {
        return;
      }
      const deviceId = must(this.state.deviceId, "no deviceId");
      const serviceId = must(this.state.serviceId, "no serviceId");
      const characteristicId = must(this.state.rxCharId, "no rxCharId");

      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const kind = (opts && opts.kind) || "bin";
      // JSON：必须分片（常见 20B 限制），否则可能只到半截导致 Cody 端无法解析 '\n' 行结束。
      // BIN：优先走“单次写完整帧”（更快）；若设备/机型不支持再回退分片。
      // draw_stroke 等高频命令可传 interChunkDelayMs: 0 降低跟笔延迟；默认 6ms 偏保守。
      let perChunkDelayMs = 0;
      if (kind === "json") {
        perChunkDelayMs =
          opts && typeof opts.interChunkDelayMs === "number" ? opts.interChunkDelayMs : 6;
      }
      const jsonFast =
        kind === "json" && opts && opts.writeNoResponse && !!this.state.rxWriteNoResp;
      const wantNoResp =
        !!this.state.rxWriteNoResp &&
        (kind === "bin" || jsonFast);
      const canWriteType = !!(wx.canIUse && wx.canIUse("writeBLECharacteristicValue.writeType"));

      const writeOnce = async (part) => {
        await withTimeout(
          p((resolve, reject) => {
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
          }),
          2500,
          "writeBLECharacteristicValue timeout"
        );
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
        if (strokeGen !== null && strokeGen !== this._handdrawStrokeGen) {
          return;
        }
        const part = u8.subarray(off, Math.min(u8.length, off + kChunk));
        await writeOnce(part);
        if (perChunkDelayMs > 0 && off + kChunk < u8.length) {
          await new Promise((r) => setTimeout(r, perChunkDelayMs));
        }
      }
    });

    return this._writeQ;
  }

  /**
   * 手绘线段：二进制单帧（~16B），优先于 JSON draw_stroke，减少分片与解析开销。
   */
  async sendHanddrawStrokeBin(seg, enqueueGen) {
    const x0 = Number(seg.x0) || 0;
    const y0 = Number(seg.y0) || 0;
    const x1 = Number(seg.x1) || 0;
    const y1 = Number(seg.y1) || 0;
    const c = Number(seg.c) & 0xffff;
    const w = Number(seg.w) || 4;
    const pl = buildHanddrawStrokePayload(x0, y0, x1, y1, c, w);
    const { session, seq } = this.nextSessionSeq();
    const frame = buildFrame(FrameType.HanddrawStroke, session, seq, pl);
    const gen = typeof enqueueGen === "number" ? enqueueGen : this._handdrawStrokeGen;
    await this.write(frame, { kind: "bin", handdrawStrokeGen: gen });
  }

  /** 多段合并一帧，减少 write 次数与主机调度延迟 */
  async sendHanddrawStrokeBatchBin(segs, enqueueGen) {
    const list = Array.isArray(segs) ? segs : [];
    if (!list.length) return;
    if (list.length === 1) {
      return this.sendHanddrawStrokeBin(list[0], enqueueGen);
    }
    const pl = buildHanddrawStrokeBatchPayload(list);
    const { session, seq } = this.nextSessionSeq();
    const frame = buildFrame(FrameType.HanddrawStrokeBatch, session, seq, pl);
    const gen = typeof enqueueGen === "number" ? enqueueGen : this._handdrawStrokeGen;
    await this.write(frame, { kind: "bin", handdrawStrokeGen: gen });
  }

  async sendJson(obj, opts) {
    const line = JSON.stringify(obj) + "\n";
    try {
      this.log("[tx json] " + line.trimEnd());
    } catch (_) {}
    const wopts = { kind: "json" };
    if (opts && typeof opts.interChunkDelayMs === "number") {
      wopts.interChunkDelayMs = opts.interChunkDelayMs;
    }
    if (opts && opts.writeNoResponse) {
      wopts.writeNoResponse = true;
    }
    if (opts && typeof opts.handdrawStrokeGen === "number") {
      wopts.handdrawStrokeGen = opts.handdrawStrokeGen;
    }
    await this.write(utf8Encode(line), wopts);
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

