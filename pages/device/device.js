import { ble } from "../../services/ble";
import { FrameType } from "../../services/proto_bin";

const UPDATE_VERSION_URL = "https://raw.githubusercontent.com/JTKhalil/claudeRobot/main/version.txt";
const UPDATE_FIRMWARE_URL = "https://raw.githubusercontent.com/JTKhalil/claudeRobot/main/firmware.bin";

function le32(v) {
  const x = (v >>> 0);
  return new Uint8Array([x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff]);
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function parseVersionText(text) {
  const s = (text || "").replace(/\r/g, "").trim();
  if (!s) return { version: "", notes: "" };
  const lines = s.split("\n");
  const version = (lines[0] || "").trim();
  const notes = lines.slice(1).join("\n").trim();
  return { version, notes };
}

function cmpVer(a, b) {
  const pa = String(a || "").trim().split(".").map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
  const pb = String(b || "").trim().split(".").map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

async function fetchTextWithFallbacks(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 8000;
  const retries = (opts && opts.retries) || 2;
  const cacheBust = (u) => `${u}${u.includes("?") ? "&" : "?"}t=${Date.now()}`;

  const tryDownloadFile = async (u) => {
    const dl = await new Promise((resolve, reject) => {
      wx.downloadFile({
        url: u,
        timeout: timeoutMs,
        success: resolve,
        fail: (e) => reject(new Error((e && e.errMsg) || "downloadFile failed")),
      });
    });
    if (dl.statusCode !== 200 || !dl.tempFilePath) throw new Error(`downloadFile status=${dl.statusCode || 0}`);
    const fs = wx.getFileSystemManager();
    return await new Promise((resolve, reject) => {
      fs.readFile({
        filePath: dl.tempFilePath,
        encoding: "utf8",
        success: (x) => resolve(String(x && x.data ? x.data : "")),
        fail: (e) => reject(new Error((e && e.errMsg) || "readFile failed")),
      });
    });
  };

  const tryRequest = async (u) => {
    const res = await new Promise((resolve, reject) => {
      wx.request({
        url: u,
        method: "GET",
        timeout: timeoutMs,
        success: resolve,
        fail: (e) => reject(new Error((e && e.errMsg) || "request failed")),
      });
    });
    if ((res && res.statusCode) !== 200) throw new Error(`request status=${(res && res.statusCode) || 0}`);
    if (typeof res.data === "string") return res.data;
    return JSON.stringify(res.data || "");
  };

  const fallbacks = [
    url,
    url.replace("s://raw.githubusercontent.com/", "https://raw.github.com/"),
    url.replace("https://raw.githubusercontent.com/", "https://github.com/").replace("/main/", "/raw/main/"),
  ];

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    for (const u0 of fallbacks) {
      const u = cacheBust(u0);
      try {
        return await tryDownloadFile(u);
      } catch (e1) {
        lastErr = e1;
        try {
          return await tryRequest(u);
        } catch (e2) {
          lastErr = e2;
        }
      }
    }
  }
  throw lastErr || new Error("fetchText failed");
}

Page({
  data: {
    connected: false,
    codyName: "",
    brightness: 255,

    fsTotal: 0,
    fsUsed: 0,
    fsFree: 0,
    fsPercent: 0,

    fwCurrent: "",
    fwLatest: "",
    fwNotes: "",
    fwUpdateAvailable: false,
    fwBusy: false,
    fwBusyMode: "",
    fwPercent: 0,
    fwStatus: "",

    confirmOpen: false,
    confirmMsg: "",
    _confirmAction: "",
  },

  onLoad() {
    this._syncConn();
  },

  onShow() {
    this._syncConn();
  },

  _syncConn() {
    this.setData({ connected: !!ble.state.connected, codyName: ble.state.deviceName || "" });
  },

  async onReconnect() {
    try {
      await ble.reconnect();
    } catch (_) {}
    this._syncConn();
  },

  async onDisconnectBle() {
    try {
      await ble.disconnect();
    } catch (_) {}
    this._syncConn();
    try {
      wx.redirectTo({ url: "/pages/connect/connect" });
    } catch (_) {}
  },

  async onRefreshFs() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "fs_space" }, { timeoutMs: 1200, retries: 3 });
      const total = Number(r && r.total) || 0;
      const used = Number(r && r.used) || 0;
      const free = Number(r && r.free) || 0;
      const pct = total > 0 ? Math.round((used * 100) / total) : 0;
      this.setData({ fsTotal: total, fsUsed: used, fsFree: free, fsPercent: Math.max(0, Math.min(100, pct)) });
    } catch (_) {}
  },

  async onCheckUpdate() {
    if (!ble.state.connected) return;
    try {
      this.setData({ fwBusy: true, fwBusyMode: "check", fwPercent: 0, fwStatus: "读取本机版本..." });
      const r = await ble.sendJsonStopAndWait({ cmd: "ota_info" }, { timeoutMs: 1200, retries: 2 });
      const cur = (r && r.current) ? String(r.current) : "";
      this.setData({ fwCurrent: cur, fwStatus: "拉取远端版本..." });
      const text = await fetchTextWithFallbacks(UPDATE_VERSION_URL, { timeoutMs: 8000, retries: 2 });
      const pv = parseVersionText(text);
      const latest = pv.version || "";
      const notes = pv.notes || "";
      const up = (cur && latest) ? (cmpVer(latest, cur) > 0) : false;
      this.setData({
        fwLatest: latest || "-",
        fwNotes: notes,
        fwUpdateAvailable: up,
        fwStatus: up ? "发现新版本" : "已是最新",
      });
    } catch (_) {}
    finally {
      this.setData({ fwBusy: false, fwBusyMode: "" });
    }
  },

  async onUpgrade() {
    if (!ble.state.connected) return;
    if (!this.data.fwUpdateAvailable) return;
    try {
      this.setData({ fwBusy: true, fwBusyMode: "upgrade", fwPercent: 0, fwStatus: "下载固件中..." });
      const dl = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: UPDATE_FIRMWARE_URL,
          success: resolve,
          fail: (e) => reject(new Error((e && e.errMsg) || "downloadFile failed")),
        });
      });
      if (dl.statusCode !== 200 || !dl.tempFilePath) throw new Error("download firmware.bin failed");
      const fs = wx.getFileSystemManager();
      const ab = await new Promise((resolve, reject) => {
        fs.readFile({
          filePath: dl.tempFilePath,
          success: (x) => resolve(x.data),
          fail: (e) => reject(new Error((e && e.errMsg) || "readFile failed")),
        });
      });
      const fw = new Uint8Array(ab);
      if (!fw.length) throw new Error("firmware empty");

      this.setData({ fwStatus: "发送 OTA_BEGIN..." });
      const total = (fw.length >>> 0);
      const chunkBytes = 166;
      const beginRes = await ble.sendFrameStopAndWaitDetailed(FrameType.OtaBegin, le32(total), { timeoutMs: 1200, retries: 3 });
      if (beginRes.errCode !== 0) throw new Error("OTA_BEGIN errCode=" + beginRes.errCode);

      let off = 0;
      const windowN = 8;
      const pend = [];
      while (off < total) {
        const n = Math.min(chunkBytes, total - off);
        const pl = concat(le32(off), fw.subarray(off, off + n));
        const x = await ble.sendFrameNoWaitDetailed(FrameType.OtaChunk, pl, { timeoutMs: 1500 });
        pend.push({ ackP: x.ackP, off: (off + n) });
        off += n;

        if (pend.length >= windowN) {
          const acks = await Promise.all(pend.map((p) => p.ackP));
          for (let i = 0; i < acks.length; i++) {
            const ec = acks[i];
            if (ec === null) throw new Error("OTA_CHUNK timeout");
            if (ec !== 0) throw new Error(`OTA_CHUNK errCode=${ec} off=${pend[i].off}`);
          }
          pend.length = 0;
        }

        const pct = Math.floor((off * 100) / total);
        if (pct !== this.data.fwPercent) this.setData({ fwPercent: pct });
      }
      if (pend.length) {
        const acks = await Promise.all(pend.map((p) => p.ackP));
        for (let i = 0; i < acks.length; i++) {
          const ec = acks[i];
          if (ec === null) throw new Error("OTA_CHUNK timeout");
          if (ec !== 0) throw new Error(`OTA_CHUNK errCode=${ec} off=${pend[i].off}`);
        }
      }

      this.setData({ fwStatus: "发送 OTA_FINISH..." });
      const finRes = await ble.sendFrameStopAndWaitDetailed(FrameType.OtaFinish, le32(total), { timeoutMs: 2000, retries: 3 });
      if (finRes.errCode !== 0) throw new Error("OTA_FINISH errCode=" + finRes.errCode);

      this.setData({ fwPercent: 100, fwStatus: "升级完成，设备重启中..." });
    } catch (e) {
      const msg = String((e && e.message) || "未知错误");
      this.setData({ fwStatus: "升级失败：" + msg });
    } finally {
      this.setData({ fwBusy: false, fwBusyMode: "" });
    }
  },

  onBrightnessChanging(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (!Number.isFinite(v)) return;
    this.setData({ brightness: Math.max(0, Math.min(255, v)) });
  },

  async onBrightnessChange(evt) {
    this.onBrightnessChanging(evt);
    if (!ble.state.connected) return;
    try {
      const v = Number(this.data.brightness) || 0;
      await ble.sendJsonStopAndWait({ cmd: "bright", v }, { timeoutMs: 800, retries: 2 });
    } catch (_) {}
  },

  onAskConfirm(evt) {
    const action = String((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.action) || "");
    if (!action) return;
    const msg = (action === "format_fs")
      ? "确定要删除 Cody 上的所有数据吗？该操作不可恢复。"
      : "确定要恢复出厂设置吗？";
    this.setData({ confirmOpen: true, confirmMsg: msg, _confirmAction: action });
  },

  onCancelConfirm() {
    this.setData({ confirmOpen: false, confirmMsg: "", _confirmAction: "" });
  },

  async onOkConfirm() {
    const action = this.data._confirmAction;
    this.setData({ confirmOpen: false });
    if (!ble.state.connected) return;
    try {
      if (action === "format_fs") {
        await ble.sendJsonStopAndWait({ cmd: "format_fs" }, { timeoutMs: 2000, retries: 2 });
      } else if (action === "reset_system") {
        await ble.sendJsonStopAndWait({ cmd: "reset_system" }, { timeoutMs: 2000, retries: 1 });
      }
    } catch (_) {}
  },
});

