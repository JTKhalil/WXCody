import { ble } from "../../services/ble";
import {
  getState as getUpgradeState,
  onStateChange as onUpgradeStateChange,
  startUpgrade,
  startUpgradeFromLocalFile,
} from "../../services/fw_upgrade";

const UPDATE_VERSION_URL = "https://raw.githubusercontent.com/JTKhalil/claudeRobot/main/version.txt";
const STORAGE_UPDATE_INFO_KEY = "wxcody_fw_update_info";
function cmpVer(a, b) {
  const pa = String(a || "").split(".").map((x) => Number(x) || 0);
  const pb = String(b || "").split(".").map((x) => Number(x) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function parseVersionText(text) {
  const s = (text || "").replace(/\r/g, "").trim();
  if (!s) return { version: "", notes: "" };
  const lines = s.split("\n");
  const version = (lines[0] || "").trim();
  const notes = lines.slice(1).join("\n").trim();
  return { version, notes };
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

  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    const u = cacheBust(url);
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
  throw lastErr || new Error("fetch failed");
}

Page({
  data: {
    canScroll: false,
    connected: false,
    fwCurrent: "",
    fwLatest: "",
    fwNotes: "",
    fwUpdateAvailable: false,
    fwBusy: false,
    fwBusyMode: "",
    fwPercent: 0,
    fwStatus: "",
  },

  _unsubUpgrade: null,
  /** 选本地固件过程中会触发 onShow；避免与 setData 异步叠加导致 onCheckUpdate 误跑并清掉升级 UI */
  _fwLocalPickFlow: false,

  onLoad() {
    this._sync();
    this._bindUpgrade();
    this._loadCachedUpdateInfo();
    ble.onConnectionStateChange(() => {
      this._sync();
      if (ble.state.connected) this.onCheckUpdate();
    });
  },

  onShow() {
    this._sync();
    this._loadCachedUpdateInfo();
    this._applyUpgradeState(getUpgradeState());
    if (this._fwLocalPickFlow) return;
    if (getUpgradeState().running) return;
    if (ble.state.connected) this.onCheckUpdate();
  },

  onUnload() {
    try { if (this._unsubUpgrade) this._unsubUpgrade(); } catch (_) {}
    this._unsubUpgrade = null;
  },

  _bindUpgrade() {
    try {
      if (this._unsubUpgrade) return;
      this._unsubUpgrade = onUpgradeStateChange((s) => {
        this._applyUpgradeState(s);
      });
    } catch (_) {}
  },

  _applyUpgradeState(s) {
    const st = s || {};
    const running = !!st.running;
    const pct = Number(st.percent);
    const percent = Number.isFinite(pct) ? pct : 0;
    const status = String(st.status || "");
    if (running) {
      this.setData({ fwBusy: true, fwBusyMode: "upgrade", fwPercent: percent, fwStatus: status || "升级中..." });
    } else if (this.data.fwBusyMode === "upgrade") {
      // 升级结束后保留最后状态/进度，解除 busy
      this.setData({ fwBusy: false, fwBusyMode: "", fwPercent: percent, fwStatus: status || this.data.fwStatus });
    }
  },

  _loadCachedUpdateInfo() {
    try {
      const x = wx.getStorageSync(STORAGE_UPDATE_INFO_KEY);
      const info = (x && typeof x === "string") ? JSON.parse(x) : (x || null);
      if (!info) return;
      const cur = String(info.current || "").trim();
      const latest = String(info.latest || "").trim();
      const notes = String(info.notes || "").trim();
      const up = !!info.updateAvailable;
      // 仅在页面当前为空时回填，避免覆盖实时拉取结果
      if (!this.data.fwCurrent && cur) this.setData({ fwCurrent: cur });
      if (!this.data.fwLatest && latest) this.setData({ fwLatest: latest });
      if (!this.data.fwNotes && notes) this.setData({ fwNotes: notes });
      if (!this.data.fwUpdateAvailable && up) this.setData({ fwUpdateAvailable: true });
    } catch (_) {}
  },

  _persistUpdateInfo(partial) {
    try {
      const prevRaw = wx.getStorageSync(STORAGE_UPDATE_INFO_KEY);
      const prev = (prevRaw && typeof prevRaw === "string") ? JSON.parse(prevRaw) : (prevRaw || {});
      const next = { ...(prev || {}), ...(partial || {}), at: Date.now() };
      wx.setStorageSync(STORAGE_UPDATE_INFO_KEY, next);
    } catch (_) {}
  },

  _sync() {
    this.setData({ connected: !!ble.state.connected });
  },

  async onCheckUpdate() {
    if (!ble.state.connected) return;
    if (getUpgradeState().running) return;
    if (this.data.fwBusy) return;
    this.setData({ fwBusy: true, fwBusyMode: "check", fwPercent: 0, fwStatus: "检查更新中..." });

    let current = "";
    try {
      this.setData({ fwStatus: "读取本机版本..." });
      const r = await ble.sendJsonStopAndWait({ cmd: "ota_info" }, { timeoutMs: 1200, retries: 2 });
      current = (r && r.current) ? String(r.current) : "";
    } catch (_) {}

    let latest = "";
    let notes = "";
    try {
      this.setData({ fwCurrent: current || "-", fwStatus: "拉取远端版本..." });
      const text = await fetchTextWithFallbacks(UPDATE_VERSION_URL, { timeoutMs: 8000, retries: 2 });
      const pv = parseVersionText(text);
      latest = pv.version || "";
      notes = pv.notes || "";
    } catch (_) {}

    const updateAvailable = !!(current && latest && cmpVer(latest, current) > 0);
    this.setData({
      fwCurrent: current || this.data.fwCurrent,
      fwLatest: latest || this.data.fwLatest,
      fwNotes: notes || (updateAvailable ? "" : this.data.fwNotes),
      fwUpdateAvailable: updateAvailable,
      fwStatus: updateAvailable ? "发现新版本" : "已是最新（或未获取到最新版本）",
    });
    this._persistUpdateInfo({
      current: (current || this.data.fwCurrent || "").trim(),
      latest: (latest || this.data.fwLatest || "").trim(),
      notes: (notes || this.data.fwNotes || "").trim(),
      updateAvailable: !!updateAvailable,
    });
    // 检查耗时期间用户可能已开始 OTA；勿用「检查结束」覆盖升级中的 UI
    if (!getUpgradeState().running) {
      this.setData({ fwBusy: false, fwBusyMode: "" });
    }
  },

  async onUpgrade() {
    if (!ble.state.connected) return;
    if (!this.data.fwUpdateAvailable) return;
    if (this.data.fwBusy) return;
    try {
      await startUpgrade();
    } catch (_) {}
  },

  async onUpgradeLocal() {
    if (!ble.state.connected) return;
    if (this.data.fwBusy) return;
    this._fwLocalPickFlow = true;
    try {
      const res = await new Promise((resolve, reject) => {
        wx.chooseMessageFile({
          count: 1,
          type: "file",
          extension: ["bin"],
          success: resolve,
          fail: (e) => reject(new Error((e && e.errMsg) || "chooseMessageFile failed")),
        });
      });
      const f = (res && res.tempFiles && res.tempFiles[0]) || null;
      if (!f || !f.path) throw new Error("未选择文件");
      const nm = String(f.name || "").toLowerCase();
      if (!nm.endsWith(".bin")) {
        try { wx.showToast({ title: "请选择 firmware.bin", icon: "none" }); } catch (_) {}
        return;
      }
      await startUpgradeFromLocalFile(f.path);
    } catch (e) {
      try {
        wx.showToast({ title: String((e && e.message) || e || "升级失败"), icon: "none", duration: 2200 });
      } catch (_) {}
    } finally {
      this._fwLocalPickFlow = false;
    }
  },
});

