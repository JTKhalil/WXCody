import { ble } from "../../services/ble";
import { FrameType } from "../../services/proto_bin";

function le32(v: number): Uint8Array {
  const x = v >>> 0;
  return new Uint8Array([x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff]);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

Page({
  data: {
    connected: false,
    deviceId: "",
    url: "",
    firmwareName: "未选择",
    firmwareReady: false,
    total: 0,
    sent: 0,
    percent: 0,
    retries: 0,
    busy: false,
    status: "-",
    log: "",
  },

  _uiT: 0 as any,
  _uiDirty: false,
  _pending: null as any,
  _progressT: 0 as any,

  onLoad() {
    // Reuse same BLE client as connect page; user should connect first.
    // Still open adapter to allow direct usage here.
    ble.openAdapter().catch(() => { });
    this.syncState();
    this.scheduleUiRefresh(true);

    ble.onConnectionStateChange(() => {
      this.syncState();
      this.scheduleUiRefresh(true);
    });
  },

  onUrlInput(e: any) {
    this.setData({ url: (e?.detail?.value || "").trim() });
  },

  syncState() {
    this.setData({
      connected: ble.state.connected,
      deviceId: ble.state.deviceId || "",
    });
  },

  scheduleUiRefresh(force = false) {
    this._uiDirty = true;
    if (this._uiT && !force) return;
    if (this._uiT) clearTimeout(this._uiT);
    this._uiT = setTimeout(() => {
      this._uiT = 0;
      if (!this._uiDirty && !force) return;
      this._uiDirty = false;
      this.setData({ log: ble.getLogsText({ maxChars: 4000 }) });
    }, 80);
  },

  pushUi(partial: any, force = false) {
    this._pending = { ...(this._pending || {}), ...(partial || {}) };
    if (force) {
      const x = this._pending;
      this._pending = null;
      if (this._progressT) {
        clearTimeout(this._progressT);
        this._progressT = 0;
      }
      if (x) this.setData(x);
      return;
    }
    // 节流进度更新：避免每包 setData
    if (this._progressT) return;
    this._progressT = setTimeout(() => {
      this._progressT = 0;
      const x = this._pending;
      this._pending = null;
      if (x) this.setData(x);
    }, 80);
  },

  async onChooseFile() {
    try {
      const res = await p<WechatMiniprogram.ChooseMessageFileSuccessCallbackResult>((resolve, reject) => {
        wx.chooseMessageFile({
          count: 1,
          type: "file",
          extension: ["bin"],
          success: resolve,
          fail: (e) => reject(new Error(e?.errMsg || "chooseMessageFile failed")),
        });
      });
      const f = (res.tempFiles || [])[0];
      if (!f?.path) throw new Error("no file selected");
      await this.loadFirmwareFromPath(f.path, f.name || "firmware.bin");
    } catch (e: any) {
      this.setData({ status: "选择文件失败：" + (e?.message || String(e)) });
    }
    this.scheduleUiRefresh(true);
  },

  async onDownloadUrl() {
    try {
      const url = (this.data.url || "").trim();
      if (!url) throw new Error("URL 为空");
      this.setData({ status: "下载中...", busy: true });

      const dl = await p<WechatMiniprogram.DownloadFileSuccessCallbackResult>((resolve, reject) => {
        wx.downloadFile({
          url,
          success: resolve,
          fail: (e) => reject(new Error(e?.errMsg || "downloadFile failed")),
        });
      });
      if (dl.statusCode !== 200) throw new Error("download statusCode=" + dl.statusCode);
      if (!dl.tempFilePath) throw new Error("no tempFilePath");

      await this.loadFirmwareFromPath(dl.tempFilePath, "firmware.bin");
    } catch (e: any) {
      this.setData({ status: "下载失败：" + (e?.message || String(e)) });
    } finally {
      this.setData({ busy: false });
    }
    this.scheduleUiRefresh(true);
  },

  async loadFirmwareFromPath(path: string, name: string) {
    const fs = wx.getFileSystemManager();
    const ab = await p<ArrayBuffer>((resolve, reject) => {
      fs.readFile({
        filePath: path,
        success: (r: any) => resolve(r.data as ArrayBuffer),
        fail: (e: any) => reject(new Error(e?.errMsg || "readFile failed")),
      });
    });
    const bytes = new Uint8Array(ab);
    if (!bytes.length) throw new Error("文件为空");

    (this as any)._fw = bytes; // stash in page instance
    this.setData({
      firmwareName: name,
      firmwareReady: true,
      total: bytes.length,
      sent: 0,
      percent: 0,
      retries: 0,
      status: "就绪",
    });
    ble.log(`固件已加载：${name} (${bytes.length} bytes)`);
    this.scheduleUiRefresh(true);
  },

  async onStartOta() {
    const fw: Uint8Array | undefined = (this as any)._fw;
    if (!fw || !fw.length) {
      this.setData({ status: "未加载固件" });
      return;
    }
    if (!ble.state.connected) {
      this.setData({ status: "未连接设备，请先在连接页连接 Cody-*" });
      return;
    }

    const total = fw.length >>> 0;
    const chunkBytes = 150;

    this.setData({ busy: true, sent: 0, percent: 0, retries: 0, status: "发送 OTA_BEGIN..." });
    ble.log("OTA start");
    this.scheduleUiRefresh(true);

    try {
      let retryCount = 0;
      const beginRes = await ble.sendFrameStopAndWaitDetailed(FrameType.OtaBegin, le32(total), { timeoutMs: 1200, retries: 3 });
      retryCount += Math.max(0, beginRes.attempts - 1);
      this.pushUi({ retries: retryCount }, true);
      if (beginRes.errCode !== 0) throw new Error("OTA_BEGIN errCode=" + beginRes.errCode);

      let off = 0;
      while (off < total) {
        const n = Math.min(chunkBytes, total - off);
        const pl = concat(le32(off), fw.subarray(off, off + n));
        const r = await ble.sendFrameStopAndWaitDetailed(FrameType.OtaChunk, pl, { timeoutMs: 1200, retries: 6 });
        retryCount += Math.max(0, r.attempts - 1);
        this.pushUi({ retries: retryCount });
        if (r.errCode !== 0) throw new Error(`OTA_CHUNK errCode=${r.errCode} off=${off}`);

        off += n;
        const percent = Math.floor((off * 100) / total);
        this.pushUi({ sent: off, percent, status: `发送中... (${off}/${total})` });
      }

      this.pushUi({ status: "发送 OTA_FINISH..." }, true);
      const finRes = await ble.sendFrameStopAndWaitDetailed(FrameType.OtaFinish, le32(total), { timeoutMs: 1500, retries: 3 });
      retryCount += Math.max(0, finRes.attempts - 1);
      this.pushUi({ retries: retryCount }, true);
      if (finRes.errCode !== 0) throw new Error("OTA_FINISH errCode=" + finRes.errCode);

      this.setData({ status: "完成：等待设备重启（通常会断开连接）" });
      ble.log("OTA finish OK");
    } catch (e: any) {
      this.setData({ status: "失败：" + (e?.message || String(e)) });
      ble.log("OTA FAIL: " + (e?.message || String(e)));
    } finally {
      this.setData({ busy: false });
      this.scheduleUiRefresh(true);
    }
  },

  async onCopyLogs() {
    try {
      await ble.copyLogs({ maxChars: 20000 });
      this.setData({ status: "日志已复制" });
    } catch (e: any) {
      this.setData({ status: "复制失败" });
      ble.log("copyLogs FAIL: " + (e?.message || String(e)));
    }
    this.scheduleUiRefresh(true);
  },

  onClearLogs() {
    ble.clearLogs();
    this.scheduleUiRefresh(true);
  },
});

function p<T>(fn: (resolve: (v: T) => void, reject: (e: any) => void) => void): Promise<T> {
  return new Promise(fn);
}

