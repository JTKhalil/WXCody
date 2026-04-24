import { ble } from "../../services/ble";
import { FrameType } from "../../services/proto_bin";

const IMG_BYTES = 240 * 240 * 2;
// 提速：固件端二进制帧总长度上限为 180B（含头+CRC），当前 ImgPushChunk 负载含 1(slot)+4(off)+data，
// 因此 data 的安全上限约为 180-9(帧开销)-5(字段)=166B。
const CHUNK_BYTES = 166;

const THUMB_CACHE_PREFIX = "wxcody_thumb_rgb565_slot_";

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

async function fetchTextWithFallbacks(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 8000;
  const retries = (opts && opts.retries) || 2;
  const cacheBust = (u) => `${u}${u.includes("?") ? "&" : "?"}t=${Date.now()}`;

  // Some networks / devices behave differently between downloadFile and request.
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
    // wx.request may return string or object; version.txt should be plain text
    if (typeof res.data === "string") return res.data;
    return JSON.stringify(res.data || "");
  };

  // Fallback URLs: raw + github raw endpoint
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

function cmpVer(a, b) {
  // 按位比较：1.2.10 > 1.2.2
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

function cacheKeyForSlot(slot) {
  return THUMB_CACHE_PREFIX + String(slot);
}

function thumbCacheGet(slot) {
  try {
    const b64 = wx.getStorageSync(cacheKeyForSlot(slot));
    if (!b64 || typeof b64 !== "string") return null;
    const ab = wx.base64ToArrayBuffer(b64);
    const u8 = new Uint8Array(ab);
    if (u8.length !== IMG_BYTES) return null;
    return u8;
  } catch (_) {
    return null;
  }
}

function thumbCacheSet(slot, rgb565) {
  try {
    const u8 = rgb565 instanceof Uint8Array ? rgb565 : new Uint8Array(rgb565);
    if (u8.length !== IMG_BYTES) return;
    const b64 = wx.arrayBufferToBase64(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    wx.setStorageSync(cacheKeyForSlot(slot), b64);
  } catch (_) {}
}

function thumbCacheDel(slot) {
  try { wx.removeStorageSync(cacheKeyForSlot(slot)); } catch (_) {}
}

function clearAllCachesKeepIdentity() {
  // 清空所有小程序缓存（图片/笔记/设备记录等），但保留本机身份（clientId / deviceName）
  try {
    const info = wx.getStorageInfoSync();
    const keys = (info && info.keys) || [];
    for (const k of keys) {
      if (typeof k !== "string") continue;
      if (!k.startsWith("wxcody_")) continue;
      if (k === "wxcody_client_id") continue;
      if (k === "wxcody_device_name") continue;
      try { wx.removeStorageSync(k); } catch (_) {}
    }
  } catch (_) {}
}

function readLe32(b, off) {
  return ((b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0);
}

async function getCanvas2d(page) {
  return await new Promise((resolve, reject) => {
    wx.createSelectorQuery()
      .in(page)
      .select("#preview")
      .fields({ node: true, size: true })
      .exec((res) => {
        const node = res && res[0] && res[0].node;
        if (!node) return reject(new Error("canvas node not found"));
        const canvas = node;
        const ctx = canvas.getContext("2d");
        canvas.width = 240;
        canvas.height = 240;
        resolve({ canvas, ctx });
      });
  });
}

async function getCanvas2dById(page, id, size) {
  return await new Promise((resolve, reject) => {
    wx.createSelectorQuery()
      .in(page)
      .select("#" + id)
      .fields({ node: true, size: true })
      .exec((res) => {
        const node = res && res[0] && res[0].node;
        if (!node) return reject(new Error("canvas node not found: " + id));
        const canvas = node;
        const ctx = canvas.getContext("2d");
        const s = size || 240;
        canvas.width = s;
        canvas.height = s;
        resolve({ canvas, ctx });
      });
  });
}

function rgb565ToImageData(bytes, imageData) {
  const dst = imageData.data;
  let di = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const v = bytes[i] | (bytes[i + 1] << 8);
    const r5 = (v >> 11) & 0x1f;
    const g6 = (v >> 5) & 0x3f;
    const b5 = (v >> 0) & 0x1f;
    dst[di++] = (r5 * 255 + 15) / 31;
    dst[di++] = (g6 * 255 + 31) / 63;
    dst[di++] = (b5 * 255 + 15) / 31;
    dst[di++] = 255;
  }
}

function imageDataToRgb565(imageData) {
  const src = imageData.data;
  const out = new Uint8Array(IMG_BYTES);
  let oi = 0;
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    const r5 = (r * 31 + 127) / 255;
    const g6 = (g * 63 + 127) / 255;
    const b5 = (b * 31 + 127) / 255;
    const v = ((r5 & 0x1f) << 11) | ((g6 & 0x3f) << 5) | (b5 & 0x1f);
    out[oi++] = v & 0xff;
    out[oi++] = (v >> 8) & 0xff;
  }
  return out;
}

Page({
  data: {
    // header
    adapterReady: false,
    connected: false,
    deviceId: "",
    status: "-",
    codyName: "",
    log: "",
    showDebug: false,

    activeTab: 0,

    // mode
    modeCurrent: -1,

    // gallery
    imgSlideshowEnabled: true,
    imgInterval: 10,
    uploadLock: false,
    uploadingSlot: -1,
    slots: [
      { slot: 0, status: "-", hasImage: false, previewReady: false, busy: false, progressText: "", progressPct: 0 },
    ],

    // notes
    notes: [],
    notePinnedOrig: -1,
    noteSlideshow: false,
    noteInterval: 10,
    noteEditIndex: -1,
    noteText: "",
    noteCharCount: 0,
    noteCharLeft: 100,

    // settings
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
    brightness: 255,

    confirmOpen: false,
    confirmMsg: "",
  },

  // internal
  _uiT: 0,
  _uiDirty: false,
  _slotsCache: null,
  _slotsDirty: false,
  _thumbCtx: null,
  _workCtx: null,
  _pull: null,
  _pullQueue: null,
  _pullQueueRunning: false,
  _confirmAction: "",
  _brightT: 0,
  _unsubs: null,
  _galleryFrameUnsub: null,
  _lastTimeSyncMs: 0,
  _forceThumbRedrawOnce: false,
  _disconnectRedirecting: false,
  _tabLoaded: null,
  _cancelUploadSlots: null,

  onLoad() {
    this._slotsCache = (this.data.slots || []).map((s) => ({ ...s }));
    this._thumbCtx = {};
    this._pullQueue = [];
    this._cancelUploadSlots = new Set();

    const unsubs = [];

    unsubs.push(ble.onConnectionStateChange((connected) => {
      this.syncState();
      this.setData({ status: connected ? "已连接" : "已断开" });
      this.scheduleUiRefresh(true);
      // 断线时不再保持 modal
      if (!connected) this.setData({ confirmOpen: false });
      if (connected) {
        this._disconnectRedirecting = false;
        this._syncTimeFromPhone().catch(() => {});
      } else {
        // 断开后直接回到连接页
        if (this._disconnectRedirecting) return;
        this._disconnectRedirecting = true;
        try {
          wx.redirectTo({ url: "/pages/connect/connect" });
        } catch (_) {}
      }
    }));

    // 不在 onLoad 里注册 onJson/onFrame（防止回调风暴卡 UI）。
    // 需要时在进入对应 Tab 时再注册。

    this._unsubs = unsubs;

    this.syncState();
    this._loadCodyName();
    this._tabLoaded = { 0: false, 1: false, 2: false, 3: false };
    // 关键：从 connect 页跳转进来时，BLE 可能已经处于 connected 状态，但不会再触发一次 onConnectionStateChange(true)。
    // 这种情况下需要在进入控制台页时主动同步一次时间，否则要等用户切 tab 才会触发同步。
    if (ble.state.connected) {
      this._disconnectRedirecting = false;
      this._syncTimeFromPhone().catch(() => {});
    }
    // 不主动刷新 log，避免大量 setData
    // 初次进入：延迟一次轻量刷新，避免刚跳转就并发 discover/write
    setTimeout(() => {
      this.onRefreshMode().catch(() => {});
      if (this._tabLoaded) this._tabLoaded[0] = true;
    }, 250);
  },

  async onCancelUpload(evt) {
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    if (!Number.isFinite(slot)) return;
    try { this._cancelUploadSlots && this._cancelUploadSlots.add(slot); } catch (_) {}
    try { this.setSlotStatus(slot, "cancelling..."); } catch (_) {}
    try { await ble.sendJsonStopAndWait({ cmd: "img_cancel" }, { timeoutMs: 1200, retries: 2 }); } catch (_) {}
    // 取消上传：若是替换，则保留原图；若是空槽位上传，则清空显示
    const curSlot = (this._slotsCache || this.data.slots || []).find((s) => s.slot === slot);
    const isReplace = !!(curSlot && curSlot.hasImage);
    if (!isReplace) {
      try { thumbCacheDel(slot); } catch (_) {}
      try { await this._clearThumb(slot); } catch (_) {}
    }
    try { this.setData({ uploadLock: false, uploadingSlot: -1 }); } catch (_) {}
    try {
      this._slotsCache = (this._slotsCache || this.data.slots || []).map((s) =>
        (s.slot === slot
          ? { ...s, hasImage: (isReplace ? true : false), previewReady: (isReplace ? s.previewReady : false), busy: false, progressPct: 0, status: "cancelled" }
          : s)
      );
      this._slotsDirty = true;
      this.scheduleUiRefresh(true);
    } catch (_) {}
  },

  _loadCodyName() {
    let nm = "";
    try { nm = String(wx.getStorageSync("wxcody_last_cody_name") || ""); } catch (_) {}
    if (!nm) {
      try {
        const list = wx.getStorageSync("wxcody_known_devices") || [];
        if (Array.isArray(list) && list[0] && list[0].name) nm = String(list[0].name || "");
      } catch (_) {}
    }
    nm = String(nm || "").trim();
    if (!nm) return;
    this.setData({ codyName: nm });
    try { wx.setNavigationBarTitle({ title: `Cody 控制台` }); } catch (_) {}
  },

  onShow() {
    // 去掉左上角 home 胶囊按钮（微信提供的“返回/主页”按钮）
    try { wx.hideHomeButton(); } catch (_) {}
  },

  async _syncTimeFromPhone() {
    if (!ble.state.connected) return;
    const now = Date.now();
    if (this._lastTimeSyncMs && now - this._lastTimeSyncMs < 30 * 1000) return; // 30s 防抖
    this._lastTimeSyncMs = now;
    try {
      const ts = Math.floor(now / 1000);
      await ble.sendJsonStopAndWait({ cmd: "sync_time", timestamp: ts }, { timeoutMs: 1200, retries: 2 });
    } catch (e) {
      ble.log("sync_time FAIL: " + ((e && e.message) || String(e)));
    }
  },

  async _getThumbCtx(slot) {
    const id = "thumb" + slot;
    // 不要盲信缓存：切换 tab 后 canvas 节点会重建，旧 ctx 会失效导致画面一直黑。
    // 这里优先尝试重新获取一次；失败才回退到缓存（避免抖动时完全不可用）。
    let ctx = null;
    try {
      ctx = await getCanvas2dById(this, id, 240);
    } catch (_) {
      ctx = (this._thumbCtx && this._thumbCtx[id]) || null;
      if (!ctx) throw _;
    }
    if (!this._thumbCtx) this._thumbCtx = {};
    this._thumbCtx[id] = ctx;
    return ctx;
  },

  async _getWorkCtx() {
    const id = "workCanvas";
    if (this._workCtx) return this._workCtx;
    const ctx = await getCanvas2dById(this, id, 240);
    this._workCtx = ctx;
    return ctx;
  },

  async _renderThumbFromRgb565(slot, rgb565) {
    const tctx = await this._getThumbCtx(slot);
    const c2d = tctx && tctx.ctx;
    if (!c2d) throw new Error("thumb canvas ctx not ready");
    const imageData = c2d.createImageData(240, 240);
    rgb565ToImageData(rgb565, imageData);
    c2d.putImageData(imageData, 0, 0);
  },

  async _clearThumb(slot) {
    try {
      const tctx = await this._getThumbCtx(slot);
      const c2d = tctx && tctx.ctx;
      if (!c2d) return;
      c2d.clearRect(0, 0, 240, 240);
      // 统一清空成深色底
      c2d.fillStyle = "#111";
      c2d.fillRect(0, 0, 240, 240);
    } catch (_) {}
  },

  onUnload() {
    if (this._uiT) clearTimeout(this._uiT);
    this._uiT = 0;
    if (this._brightT) clearTimeout(this._brightT);
    this._brightT = 0;
    if (this._galleryFrameUnsub) {
      try { this._galleryFrameUnsub(); } catch (_) {}
      this._galleryFrameUnsub = null;
    }
    this._workCtx = null;
    const unsubs = this._unsubs || [];
    for (const u of unsubs) {
      try { u(); } catch (_) {}
    }
    this._unsubs = null;
  },

  async onReady() {},

  noop() {},

  syncState() {
    this.setData({
      adapterReady: ble.state.adapterReady,
      connected: ble.state.connected,
      deviceId: ble.state.deviceId || "",
    });
  },

  scheduleUiRefresh(force = false) {
    // 默认不刷日志（避免 setData 风暴导致 UI 卡死）；仅在展开调试日志时刷新
    // 或 slots 需要刷新时刷新。
    const needLog = !!this.data.showDebug;
    const needSlots = !!this._slotsDirty;
    if (!needLog && !needSlots && !force) return;

    this._uiDirty = true;
    if (this._uiT && !force) return;
    if (this._uiT) clearTimeout(this._uiT);
    this._uiT = setTimeout(() => {
      this._uiT = 0;
      if (!this._uiDirty && !force) return;
      this._uiDirty = false;
      const patch = {};
      if (needLog) patch.log = ble.getLogsText({ maxChars: 2500 });
      if (this._slotsDirty && this._slotsCache) {
        patch.slots = this._slotsCache;
        this._slotsDirty = false;
      }
      // 没有 patch 就不要 setData
      if (Object.keys(patch).length) this.setData(patch);
    }, 120);
  },

  setSlotStatus(slot, status) {
    if (!this._slotsCache) this._slotsCache = (this.data.slots || []).map((s) => ({ ...s }));
    this._slotsCache = (this._slotsCache || []).map((s) => (s.slot === slot ? { ...s, status } : s));
    this._slotsDirty = true;
    this.scheduleUiRefresh();
  },

  setSlotProgress(slot, busy, progressText, progressPct) {
    if (!this._slotsCache) this._slotsCache = (this.data.slots || []).map((s) => ({ ...s }));
    const pct = Math.max(0, Math.min(100, Number.isFinite(Number(progressPct)) ? Number(progressPct) : 0));
    this._slotsCache = (this._slotsCache || []).map((s) =>
      (s.slot === slot ? { ...s, busy: !!busy, progressText: progressText || "", progressPct: pct } : s)
    );
    this._slotsDirty = true;
    this.scheduleUiRefresh();
  },

  async onTab(evt) {
    const tab = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.tab) || 0);
    // 只 setData 一次，避免切换时 UI 不稳定
    this.setData({ activeTab: tab, status: "切换 Tab -> " + tab });
    if (this.data.showDebug) ble.log("UI tab -> " + tab);

    // 默认策略：仅“首次进入该 tab”时刷新，后续切换不重复拉取（避免卡顿/流量浪费）。
    const loaded = !!(this._tabLoaded && this._tabLoaded[tab]);
    if (loaded) {
      // Gallery: 切回时 canvas 会重建，需要重绘缩略图，但不必再次拉取 image_info
      if (tab === 1) {
        this._ensureGalleryFrameHandler();
        // 切回图库：canvas 可能被重建，但不要立刻清空并触发拉取。
        // 只标记需要重绘，并等待 canvas ctx 准备好后从本地缓存恢复，避免黑屏/闪烁。
        this._forceThumbRedrawOnce = true;
        this._ensureThumbCanvases();
        setTimeout(() => {
          if (Number(this.data.activeTab) !== 1) return;
          this._ensureThumbFromCacheOrPull().catch(() => {});
        }, 120);
      }
      return;
    }

    try {
      if (tab === 0) {
        try { await this._syncTimeFromPhone(); } catch (_) {}
        await this.onRefreshMode();
      } else if (tab === 1) {
        await this.onRefreshImgConfig();
        this._ensureGalleryFrameHandler();
        // 关键：切 Tab 后 canvas 节点会重建，必须丢弃旧 ctx 缓存，否则会“画到旧 ctx 上”导致新画布一直黑
        this._thumbCtx = {};
        // 切回图库：强制要求重绘一次（即使 previewReady=true）
        this._forceThumbRedrawOnce = true;
        this._ensureThumbCanvases();
        await this.onRefreshImageInfo();
      } else if (tab === 2) {
        await this.onRefreshNotes();
      } else if (tab === 3) {
        await this.onRefreshFs();
        await this.onCheckUpdate();
      }
    } catch (_) {}
    if (this._tabLoaded) this._tabLoaded[tab] = true;
    this.scheduleUiRefresh(true);
  },

  _ensureGalleryFrameHandler() {
    if (this._galleryFrameUnsub) return;
    this._galleryFrameUnsub = ble.onFrame(async (f) => {
      if (f.type === FrameType.ImgPullChunk) {
        await this.onPullChunk(f);
        return;
      }
      if (f.type === FrameType.ImgPullFinish) {
        await this.onPullFinish(f);
        return;
      }
    });
  },

  _ensureThumbCanvases() {
    setTimeout(async () => {
      const slots = (this._slotsCache || this.data.slots || []);
      for (const s of slots) {
        const slot = s.slot;
        const id = "thumb" + slot;
        if (this._thumbCtx && this._thumbCtx[id]) continue;
        try {
          const ctx = await getCanvas2dById(this, id, 240);
          if (!this._thumbCtx) this._thumbCtx = {};
          this._thumbCtx[id] = ctx;
        } catch (_) {
          // ignore
        }
      }
    }, 50);
  },

  async onReconnect() {
    try {
      this.setData({ status: "重连中..." });
      await ble.reconnect();
      this.syncState();
      this.setData({ status: "重连成功" });
      ble.log("reconnect OK");
    } catch (e) {
      this.syncState();
      this.setData({ status: "重连失败" });
      ble.log("reconnect FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh(true);
  },

  async onCopyLogs() {
    try {
      await ble.copyLogs({ maxChars: 20000 });
      this.setData({ status: "日志已复制" });
    } catch (e) {
      this.setData({ status: "复制失败" });
      ble.log("copyLogs FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh(true);
  },

  onClearLogs() {
    ble.clearLogs();
    this.scheduleUiRefresh(true);
  },

  onToggleDebug() {
    this.setData({ showDebug: !this.data.showDebug });
    // 展开时刷新一次日志
    if (!this.data.showDebug) return;
    this.scheduleUiRefresh(true);
  },

  // ---------------- Mode ----------------
  async onRefreshMode() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "get_mode" }, { timeoutMs: 800, retries: 3 });
      const m = Number(r && r.mode);
      if (Number.isFinite(m)) this.setData({ modeCurrent: m });
      this.setData({ status: "模式已刷新" });
    } catch (e) {
      ble.log("get_mode FAIL: " + ((e && e.message) || String(e)));
      this.setData({ status: "刷新模式失败" });
    }
    this.scheduleUiRefresh();
  },

  async onSetMode(evt) {
    if (!ble.state.connected) return;
    const mode = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.mode) || 0);
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "set_mode", mode }, { timeoutMs: 800, retries: 3 });
      if (r && r.status === "ok") this.setData({ modeCurrent: mode, status: "切换成功" });
      else this.setData({ status: "切换失败" });
    } catch (e) {
      ble.log("set_mode FAIL: " + ((e && e.message) || String(e)));
      this.setData({ status: "切换失败" });
    }
    this.scheduleUiRefresh();
  },

  // ---------------- Gallery config ----------------
  async onRefreshImgConfig() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "slideshow_config" }, { timeoutMs: 800, retries: 3 });
      if (r && typeof r.enabled === "boolean") this.setData({ imgSlideshowEnabled: !!r.enabled });
      if (r && (r.interval || r.interval === 0)) this.setData({ imgInterval: Number(r.interval) || 10 });
    } catch (e) {
      ble.log("slideshow_config FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh();
  },

  async onImgSlideshowToggle(evt) {
    const enabled = !!(evt && evt.detail && evt.detail.value);
    this.setData({ imgSlideshowEnabled: enabled });
    if (!ble.state.connected) return;
    try {
      await ble.sendJsonStopAndWait({ cmd: "set_img_slideshow", enabled }, { timeoutMs: 800, retries: 3 });
    } catch (e) {
      ble.log("set_img_slideshow FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh();
  },

  onImgIntervalChanging(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (Number.isFinite(v)) this.setData({ imgInterval: v });
  },

  async onImgIntervalChange(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    const value = Math.max(3, Math.min(60, Number.isFinite(v) ? v : 10));
    this.setData({ imgInterval: value });
    if (!ble.state.connected) return;
    try {
      await ble.sendJsonStopAndWait({ cmd: "set_interval", value }, { timeoutMs: 800, retries: 3 });
    } catch (e) {
      ble.log("set_interval FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh();
  },

  async onRefreshImageInfo() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "image_info" }, { timeoutMs: 1200, retries: 3 });
      const indices = Array.isArray(r && r.indices) ? r.indices : null;
      const boolSlots = Array.isArray(r && r.slots) ? r.slots : null; // fallback

      const fsFreeB = Number(r && r.fs_free_b);
      const imgBytes = Number(r && r.img_bytes) || IMG_BYTES;
      const canAdd = (r && typeof r.can_add === "boolean") ? !!r.can_add : (Number.isFinite(fsFreeB) ? fsFreeB >= imgBytes : true);
      const nextSlot = Number.isFinite(Number(r && r.next_slot)) ? Number(r.next_slot) : -1;

      // 目标：初始 1 个槽位；每次上传完成后若还能放下一张则增加一个空槽位。
      // 这里用“已有图片索引 + (canAdd?1:0)”生成槽位列表。
      let used = [];
      if (indices) {
        used = indices.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
      } else if (boolSlots) {
        used = boolSlots.map((v, i) => (v ? i : -1)).filter((x) => x >= 0);
      }
      const slotsOut = [];
      for (const s of used) {
        const prev = (this._slotsCache || []).find((x) => x.slot === s) || (this.data.slots || []).find((x) => x.slot === s);
        slotsOut.push({
          slot: s,
          status: (prev && prev.status) || "-",
          hasImage: true,
          previewReady: !!(prev && prev.previewReady),
          busy: !!(prev && prev.busy),
          progressText: (prev && prev.progressText) || "",
          progressPct: Number.isFinite(prev && prev.progressPct) ? prev.progressPct : 0,
        });
      }
      if (canAdd) {
        const s = (nextSlot >= 0) ? nextSlot : ((used.length ? (Math.max(...used) + 1) : 0));
        const prev = (this._slotsCache || []).find((x) => x.slot === s) || (this.data.slots || []).find((x) => x.slot === s);
        slotsOut.push({
          slot: s,
          status: (prev && prev.status) || "-",
          hasImage: false,
          previewReady: false,
          busy: !!(prev && prev.busy),
          progressText: (prev && prev.progressText) || "",
          progressPct: Number.isFinite(prev && prev.progressPct) ? prev.progressPct : 0,
        });
      }

      // 关键：上传/拉取过程中，固件端 image_info 可能还没把“正在传输的 slot”计入 indices/next_slot，
      // 但 UI 仍需要保持该 slot 的 busy/progress，不要每次刷新都丢失进度导致看起来从 0 重新开始。
      const prevSlotsAll = (this._slotsCache || []).length ? (this._slotsCache || []) : (this.data.slots || []);
      for (const ps of prevSlotsAll) {
        if (!ps || !ps.busy) continue;
        if (slotsOut.find((x) => x.slot === ps.slot)) continue;
        slotsOut.push({ ...ps });
      }
      if (!slotsOut.length) {
        slotsOut.push({ slot: 0, status: "-", hasImage: false, previewReady: false, busy: false, progressText: "", progressPct: 0 });
      }

      this._slotsCache = slotsOut;
      // 在图库 tab 内优先立即 setData，让 canvas 节点尽快渲染出来（否则后续 getCanvas2dById 可能拿不到）
      if (Number(this.data.activeTab) === 1) {
        this.setData({ slots: slotsOut });
      } else {
        this._slotsDirty = true;
        this.scheduleUiRefresh(true);
      }

      this._ensureThumbCanvases();
      await this._ensureThumbFromCacheOrPull();
    } catch (e) {
      ble.log("image_info FAIL: " + ((e && e.message) || String(e)));
    }
  },

  async _ensureThumbFromCacheOrPull() {
    const slots = this._slotsCache || this.data.slots || [];
    let changed = false;
    for (const s of slots) {
      if (!s || !s.hasImage) continue;
      // 切回图库时强制重绘一次（否则会出现“画布黑但 previewReady=true”导致永不重绘）
      if (!this._forceThumbRedrawOnce && s.previewReady) continue;
      // 上传/拉取过程中切 tab 可能导致 canvas 重建；允许 busy 时也从本地缓存恢复预览
      const cached = thumbCacheGet(s.slot);
      if (cached) {
        try {
          await this._renderThumbFromRgb565(s.slot, cached);
          this._slotsCache = (this._slotsCache || this.data.slots || []).map((x) =>
            (x.slot === s.slot ? { ...x, previewReady: true } : x)
          );
          changed = true;
        } catch (e) {
          // 渲染失败常见原因：切 tab 后 canvas ctx 还没 ready。
          // 这时不要立刻走拉取（会导致“缓存图片也刷新/甚至黑屏”），而是稍后重试一次。
          const msg = String((e && e.message) || "");
          const notReady = msg.includes("canvas node not found") || msg.includes("ctx not ready") || msg.includes("not ready");
          if (notReady) {
            setTimeout(() => {
              if (Number(this.data.activeTab) !== 1) return;
              this._forceThumbRedrawOnce = true;
              this._ensureThumbCanvases();
              this._ensureThumbFromCacheOrPull().catch(() => {});
            }, 120);
          } else {
            // 如果渲染失败且不忙，走拉取；忙时不要并发拉取
            if (!s.busy) this._enqueuePull(s.slot);
          }
        }
      } else {
        if (!s.busy) this._enqueuePull(s.slot);
      }
    }
    this._forceThumbRedrawOnce = false;
    if (changed) {
      this._slotsDirty = true;
      this.scheduleUiRefresh(true);
    }
    this._runPullQueue();
  },

  _enqueuePull(slot) {
    if (!this._pullQueue) this._pullQueue = [];
    if (this._pullQueue.includes(slot)) return;
    this._pullQueue.push(slot);
  },

  async _runPullQueue() {
    if (this._pullQueueRunning) return;
    this._pullQueueRunning = true;
    try {
      while (ble.state.connected && this._pullQueue && this._pullQueue.length) {
        if (this._pull) break; // 正在拉取
        const slot = this._pullQueue.shift();
        if (!Number.isFinite(slot)) continue;
        const cur = (this._slotsCache || this.data.slots || []).find((x) => x.slot === slot);
        if (!cur || !cur.hasImage || cur.previewReady) continue;
        await this._pullSlot(slot);
      }
    } finally {
      this._pullQueueRunning = false;
    }
  },

  async _pullSlot(slot) {
    if (!ble.state.connected) return;
    try {
      this.setSlotProgress(slot, true, "", 0);
      this.setSlotStatus(slot, "pulling...");
      this._pull = { slot, buf: new Uint8Array(IMG_BYTES), got: 0, done: false };
      await ble.sendFrameStopAndWait(FrameType.ImgPullBegin, new Uint8Array([slot & 0xff]), { timeoutMs: 800, retries: 3 });
      this.scheduleUiRefresh();
    } catch (e) {
      this._pull = null;
      this.setSlotProgress(slot, false, "", 0);
      this.setSlotStatus(slot, "pull fail");
      ble.log("PULL_BEGIN FAIL: " + ((e && e.message) || String(e)));
      this.scheduleUiRefresh(true);
    }
  },

  // ---------------- Gallery pull/push (binary frames) ----------------
  async onPull(evt) {
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    if (!ble.state.connected) return;
    if (this._pull) return; // 单通道，避免并发拉取
    await this._pullSlot(slot);
  },

  async onPullChunk(f) {
    const pl = new Uint8Array(f.payload);
    if (pl.length < 1 + 4) return;
    const slot = pl[0];
    const off = readLe32(pl, 1);
    const bytes = pl.subarray(5);

    const ctx = this._pull;
    if (!ctx || ctx.done) {
      await ble.sendAck(f.session, f.seq, FrameType.ImgPullChunk, 0);
      return;
    }
    if (slot !== (ctx.slot & 0xff)) {
      await ble.sendAck(f.session, f.seq, FrameType.ImgPullChunk, 1);
      return;
    }
    if (off + bytes.length > ctx.buf.length) {
      await ble.sendAck(f.session, f.seq, FrameType.ImgPullChunk, 3);
      return;
    }

    ctx.buf.set(bytes, off);
    ctx.got = Math.max(ctx.got, off + bytes.length);
    await ble.sendAck(f.session, f.seq, FrameType.ImgPullChunk, 0);
    const pct = Math.floor((ctx.got * 100) / IMG_BYTES);
    this.setSlotProgress(ctx.slot, true, "", pct);
  },

  async onPullFinish(f) {
    const pl = new Uint8Array(f.payload);
    if (pl.length < 1 + 4) return;
    const slot = pl[0];
    const totalLen = readLe32(pl, 1);

    const ctx = this._pull;
    if (!ctx) {
      await ble.sendAck(f.session, f.seq, FrameType.ImgPullFinish, 0);
      return;
    }
    if (slot !== (ctx.slot & 0xff) || totalLen !== IMG_BYTES) {
      await ble.sendAck(f.session, f.seq, FrameType.ImgPullFinish, 1);
      ble.log("PULL_FINISH mismatch，已 ACK 但忽略渲染");
      this.scheduleUiRefresh(true);
      return;
    }

    ctx.done = true;
    await ble.sendAck(f.session, f.seq, FrameType.ImgPullFinish, 0);
    this.setSlotStatus(ctx.slot, "pull OK");

    try {
      await this._renderThumbFromRgb565(ctx.slot, ctx.buf);
      // 缓存到本地，下次无需再拉取
      thumbCacheSet(ctx.slot, ctx.buf);
      // pull 完成：标记预览已就绪（并假定该 slot 有图）
      this._slotsCache = (this._slotsCache || this.data.slots || []).map((s) =>
        (s.slot === ctx.slot ? { ...s, hasImage: true, previewReady: true } : s)
      );
      this._slotsDirty = true;
      this.setSlotProgress(ctx.slot, false, "", 0);
      this.scheduleUiRefresh(true);
      ble.log(`PULL_FINISH slot${ctx.slot} 渲染完成`);
    } catch (e) {
      ble.log("render FAIL: " + ((e && e.message) || String(e)));
    } finally {
      this._pull = null;
      this.scheduleUiRefresh(true);
      // 若队列里还有待拉取，继续
      this._runPullQueue();
    }
  },

  async onPush(evt) {
    const from = (evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.from) || "";
    // 防误触：只有点击“上传/替换”按钮才允许进入选择图片流程
    if (from !== "btn") return;
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    if (!ble.state.connected) return;
    if (this.data.uploadLock && this.data.uploadingSlot !== slot) {
      wx.showToast({ title: "上传中，请稍候", icon: "none" });
      return;
    }
    try {
      try { this._cancelUploadSlots && this._cancelUploadSlots.delete(slot); } catch (_) {}
      try { this.setData({ uploadLock: true, uploadingSlot: slot }); } catch (_) {}

      // 替换：不要一开始就删旧图；等新图片准备好、真正开始上传前再删除
      const curSlot = (this._slotsCache || this.data.slots || []).find((s) => s.slot === slot);
      const isReplace = !!(curSlot && curSlot.hasImage);

      this.setSlotStatus(slot, "choosing...");
      const r = await new Promise((resolve, reject) => {
        wx.chooseMedia({
          count: 1,
          mediaType: ["image"],
          sourceType: ["album", "camera"],
          success: resolve,
          fail: (e) => reject(new Error((e && e.errMsg) || "chooseMedia failed")),
        });
      });
      const filePath = r && r.tempFiles && r.tempFiles[0] && r.tempFiles[0].tempFilePath;
      if (!filePath) throw new Error("no image selected");

      // 关键：使用隐藏 work canvas 做缩放与取像素，避免覆盖当前缩略图（替换失败/取消仍保留原图显示）
      const wctx = await this._getWorkCtx();
      const canvas = wctx && wctx.canvas;
      const ctx2d = wctx && wctx.ctx;
      if (!canvas || !ctx2d) throw new Error("thumb canvas ctx not ready");

      this.setSlotStatus(slot, "resizing...");

      const img = canvas.createImage();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image load failed"));
        img.src = filePath;
      });

      const sw = img.width;
      const sh = img.height;
      const s = Math.min(sw, sh);
      const sx = Math.floor((sw - s) / 2);
      const sy = Math.floor((sh - s) / 2);
      ctx2d.clearRect(0, 0, 240, 240);
      // 关键：先铺底色再画图，避免 PNG 透明区域转 RGB565 后变黑（导致设备端看起来像黑屏）
      ctx2d.fillStyle = "#fff";
      ctx2d.fillRect(0, 0, 240, 240);
      ctx2d.drawImage(img, sx, sy, s, s, 0, 0, 240, 240);

      const imageData = ctx2d.getImageData(0, 0, 240, 240);
      const rgb565 = imageDataToRgb565(imageData);

      this.setSlotProgress(slot, true, "", 0);
      this.setSlotStatus(slot, "pushing...");
      await ble.sendFrameStopAndWait(
        FrameType.ImgPushBegin,
        new Uint8Array([slot & 0xff, ...le32(IMG_BYTES)]),
        { timeoutMs: 1200, retries: 3 }
      );

      // 图片上传在部分手机上“窗口并发”会更慢（系统 BLE 写队列拥塞导致 ACK 变慢）。
      // 这里恢复为停等（每块等 ACK），保证稳定吞吐与进度显示一致。
      let lastUi = 0;
      for (let off = 0; off < rgb565.length; off += CHUNK_BYTES) {
        if (this._cancelUploadSlots && this._cancelUploadSlots.has(slot)) {
          try { await ble.sendJsonStopAndWait({ cmd: "img_cancel" }, { timeoutMs: 1200, retries: 2 }); } catch (_) {}
          throw new Error("cancelled");
        }
        const chunk = rgb565.subarray(off, Math.min(rgb565.length, off + CHUNK_BYTES));
        const pl = new Uint8Array(1 + 4 + chunk.length);
        pl[0] = slot & 0xff;
        pl.set(le32(off), 1);
        pl.set(chunk, 5);
        await ble.sendFrameStopAndWait(FrameType.ImgPushChunk, pl, { timeoutMs: 1500, retries: 5 });
        const now = Date.now();
        if (now - lastUi >= 80 || off + chunk.length >= rgb565.length) {
          lastUi = now;
          const pct = Math.floor(((off + chunk.length) * 100) / IMG_BYTES);
          this.setSlotProgress(slot, true, "", pct);
        }
      }

      await ble.sendFrameStopAndWait(
        FrameType.ImgPushFinish,
        new Uint8Array([slot & 0xff, ...le32(IMG_BYTES)]),
        { timeoutMs: 1200, retries: 3 }
      );
      this.setSlotStatus(slot, "push OK");
      this.setSlotProgress(slot, false, "", 0);
      // 上传成功：本地缓存一份（下次无需拉取预览）
      thumbCacheSet(slot, rgb565);
      // 兜底：确保槽位预览立即可见（避免仅靠 drawImage 的临时画面在某些机型上不落地）
      try { await this._renderThumbFromRgb565(slot, rgb565); } catch (_) {}
      this._slotsCache = (this._slotsCache || this.data.slots || []).map((s) =>
        (s.slot === slot ? { ...s, hasImage: true, previewReady: true } : s)
      );
      this._slotsDirty = true;
      ble.log(`PUSH_FINISH slot${slot} OK`);
      this.scheduleUiRefresh(true);
      // 上传后刷新 image_info：生成下一个空槽位（若空间不足则不新增）
      this.onRefreshImageInfo().catch(() => {});
    } catch (e) {
      this.setSlotProgress(slot, false, "", 0);
      const msg = (e && e.message) || String(e);
      this.setSlotStatus(slot, msg === "cancelled" ? "cancelled" : "push fail");
      ble.log("PUSH FAIL: " + ((e && e.message) || String(e)));
      // 新增上传失败/取消：清空显示；替换失败/取消：保留原图显示与缓存
      if (!isReplace) {
        try { thumbCacheDel(slot); } catch (_) {}
        try { await this._clearThumb(slot); } catch (_) {}
        try {
          this._slotsCache = (this._slotsCache || this.data.slots || []).map((s) =>
            (s.slot === slot ? { ...s, hasImage: false, previewReady: false } : s)
          );
          this._slotsDirty = true;
        } catch (_) {}
      }
      this.scheduleUiRefresh(true);
    } finally {
      try { this.setData({ uploadLock: false, uploadingSlot: -1 }); } catch (_) {}
    }
  },

  async onDeleteImage(evt) {
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    if (!ble.state.connected) return;
    if (this.data.uploadLock) {
      wx.showToast({ title: "上传中，暂不可删除/替换", icon: "none" });
      return;
    }
    try {
      this.setSlotStatus(slot, "deleting...");
      await ble.sendJsonStopAndWait({ cmd: "delete_image", slot }, { timeoutMs: 1500, retries: 2 });
      this.setSlotStatus(slot, "deleted");
      // 清空本地预览与缓存
      thumbCacheDel(slot);
      await this._clearThumb(slot);
      // 从列表移除该槽位，末尾由 image_info 决定是否补一个空槽位
      this._slotsCache = (this._slotsCache || this.data.slots || []).filter((s) => s.slot !== slot);
      this._slotsDirty = true;
      this.scheduleUiRefresh(true);
      this.onRefreshImageInfo().catch(() => {});
    } catch (e) {
      this.setSlotStatus(slot, "delete fail");
      ble.log("delete_image FAIL: " + ((e && e.message) || String(e)));
      this.scheduleUiRefresh(true);
    }
  },

  // ---------------- Notes ----------------
  onNoteTextInput(evt) {
    const v0 = ((evt && evt.detail && evt.detail.value) || "").toString();
    const v = v0.length > 100 ? v0.slice(0, 100) : v0;
    this.setData({ noteText: v, noteCharCount: v.length, noteCharLeft: Math.max(0, 100 - v.length) });
  },

  async onRefreshNotes() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "get_notes" }, { timeoutMs: 3000, retries: 3 });
      const notes = Array.isArray(r && r.notes) ? r.notes : [];
      const pinned = Number(r && r.pinned);
      const noteSlideshow = !!(r && r.noteSlideshow);
      const noteInterval = Number(r && r.noteInterval) || 10;
      const pinnedOrig = Number.isFinite(pinned) ? pinned : -1;

      // 展示策略：最新笔记在最上；若置顶则置顶项永远在第一。
      const all = notes.map((n, i) => ({ ...n, origIndex: i }));
      let pinnedItem = null;
      if (pinnedOrig >= 0 && pinnedOrig < all.length) {
        pinnedItem = all.find((x) => x.origIndex === pinnedOrig) || null;
      }
      const rest = all.filter((x) => x.origIndex !== pinnedOrig).sort((a, b) => b.origIndex - a.origIndex);
      const vm = pinnedItem ? [pinnedItem, ...rest] : rest;
      this.setData({
        notes: vm,
        notePinnedOrig: pinnedOrig,
        // 置顶时轮播在设备端无效，这里也强制显示为关闭
        noteSlideshow: (pinnedOrig >= 0) ? false : noteSlideshow,
        noteInterval,
      });
      this.setData({ status: "笔记已刷新" });
    } catch (e) {
      ble.log("get_notes FAIL: " + ((e && e.message) || String(e)));
      this.setData({ status: "刷新笔记失败" });
    }
    this.scheduleUiRefresh();
  },

  onEditNote(evt) {
    const idx = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.idx) ?? -1);
    const notes = this.data.notes || [];
    const item = notes.find((x) => x && x.origIndex === idx) || null;
    const text = ((item && item.content) || "").toString();
    const v = text.length > 100 ? text.slice(0, 100) : text;
    this.setData({ noteEditIndex: idx, noteText: v, noteCharCount: v.length, noteCharLeft: Math.max(0, 100 - v.length) });
  },

  async onSaveNote() {
    if (!ble.state.connected) return;
    const content0 = (this.data.noteText || "").toString();
    const content = content0.length > 100 ? content0.slice(0, 100) : content0;
    const idx = Number(this.data.noteEditIndex);
    try {
      const payload = { cmd: "save_note", content, index: (idx >= 0 ? idx : -1) };
      const r = await ble.sendJsonStopAndWait(payload, { timeoutMs: 3000, retries: 3 });
      if (r && r.status === "ok") {
        this.setData({ noteEditIndex: -1, noteText: "", noteCharCount: 0, noteCharLeft: 100, status: "已保存" });
        await this.onRefreshNotes();
      } else {
        this.setData({ status: "保存失败" });
      }
    } catch (e) {
      ble.log("save_note FAIL: " + ((e && e.message) || String(e)));
      this.setData({ status: "保存失败" });
    }
    this.scheduleUiRefresh(true);
  },

  async onDeleteNote(evt) {
    if (!ble.state.connected) return;
    const idx = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.idx) ?? -1);
    this._confirmAction = "delete_note:" + idx;
    this.setData({ confirmOpen: true, confirmMsg: "确定要删除这条笔记吗？" });
  },

  async onPinNote(evt) {
    if (!ble.state.connected) return;
    const idx = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.idx) ?? -1);
    const pinned = (this.data.notePinnedOrig === idx) ? -1 : idx;
    try {
      // 置顶后轮播无效：这里直接关掉 slideshow
      await ble.sendJsonStopAndWait(
        { cmd: "set_note_config", pinned, slideshow: (pinned >= 0) ? false : !!this.data.noteSlideshow, interval: Number(this.data.noteInterval) || 10 },
        { timeoutMs: 1200, retries: 3 }
      );
      await this.onRefreshNotes();
    } catch (e) {
      ble.log("set_note_config FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh();
  },

  onNoteSlideshowToggle(evt) {
    const v = !!(evt && evt.detail && evt.detail.value);
    // 置顶后轮播无效：直接保持关闭
    if (this.data.notePinnedOrig >= 0) {
      this.setData({ noteSlideshow: false });
      return;
    }
    this.setData({ noteSlideshow: v });
    this._sendNoteConfigThrottled(true);
  },

  onNoteIntervalChanging(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (Number.isFinite(v)) this.setData({ noteInterval: v });
  },

  onNoteIntervalChange(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    const value = Math.max(3, Math.min(60, Number.isFinite(v) ? v : 10));
    this.setData({ noteInterval: value });
    this._sendNoteConfigThrottled(true);
  },

  async _sendNoteConfigThrottled(force) {
    if (!ble.state.connected) return;
    // 置顶时设备端轮播关闭，但仍需把 interval 等配置同步到固件（取消置顶后立即生效）
    const pinned = Number(this.data.notePinnedOrig) || -1;
    const slideshow = pinned >= 0 ? false : !!this.data.noteSlideshow;
    try {
      await ble.sendJsonStopAndWait(
        { cmd: "set_note_config", pinned, slideshow, interval: Number(this.data.noteInterval) || 10 },
        { timeoutMs: 1200, retries: 3 }
      );
    } catch (e) {
      ble.log("set_note_config FAIL: " + ((e && e.message) || String(e)));
    }
    if (force) this.scheduleUiRefresh();
  },

  // ---------------- Settings ----------------

  async onRefreshFs() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "fs_space" }, { timeoutMs: 1200, retries: 3 });
      const total = Number(r && r.total) || 0;
      const used = Number(r && r.used) || 0;
      const free = Number(r && r.free) || 0;
      const percent = total > 0 ? Math.min(100, Math.max(0, Math.floor((used * 100) / total))) : 0;
      this.setData({ fsTotal: total, fsUsed: used, fsFree: free, fsPercent: percent });
    } catch (e) {
      ble.log("fs_space FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh();
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
    } catch (e) {
      ble.log("check update FAIL: " + ((e && e.message) || String(e)));
      const msg = String((e && e.message) || "未知错误");
      this.setData({ fwStatus: "检查失败：" + msg });
    } finally {
      this.setData({ fwBusy: false, fwBusyMode: "" });
    }
    this.scheduleUiRefresh();
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
      // 发送 OTA 分块：尽量大一些以提升吞吐（固件端帧上限约 180B）
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
      const finRes = await ble.sendFrameStopAndWaitDetailed(FrameType.OtaFinish, le32(total), { timeoutMs: 1500, retries: 3 });
      if (finRes.errCode !== 0) throw new Error("OTA_FINISH errCode=" + finRes.errCode);
      this.setData({ fwStatus: "完成：等待设备重启（会断开连接）", fwPercent: 100 });
    } catch (e) {
      ble.log("upgrade FAIL: " + ((e && e.message) || String(e)));
      this.setData({ fwStatus: "升级失败：" + ((e && e.message) || String(e)) });
    } finally {
      this.setData({ fwBusy: false, fwBusyMode: "" });
      this.scheduleUiRefresh(true);
    }
  },

  onBrightnessChanging(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (!Number.isFinite(v)) return;
    this.setData({ brightness: v });
    this._sendBrightnessThrottled(v);
  },

  onBrightnessChange(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (!Number.isFinite(v)) return;
    this.setData({ brightness: v });
    this._sendBrightnessThrottled(v, true);
  },

  _sendBrightnessThrottled(v, force) {
    if (!ble.state.connected) return;
    if (this._brightT && !force) return;
    if (this._brightT) clearTimeout(this._brightT);
    this._brightT = setTimeout(async () => {
      this._brightT = 0;
      try {
        await ble.sendJsonStopAndWait({ cmd: "bright", v: Number(v) || 0 }, { timeoutMs: 800, retries: 2 });
      } catch (e) {
        ble.log("bright FAIL: " + ((e && e.message) || String(e)));
      }
    }, force ? 0 : 80);
  },

  onAskConfirm(evt) {
    const action = String((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.action) || "");
    this._confirmAction = action;
    const msg = (action === "format_fs")
      ? "确定要删除 Cody 上的所有数据吗？将清空图片与笔记。"
      : (action === "reset_system")
        ? "确定要恢复出厂设置吗？设备会重启并断开连接。"
        : "确定要执行该操作吗？";
    this.setData({ confirmOpen: true, confirmMsg: msg });
  },

  async onDisconnectBle() {
    // 设置页断开：先确认
    try {
      await new Promise((resolve, reject) => {
        wx.showModal({
          title: "断开连接",
          content: "确定要断开蓝牙连接吗？将清空本地缓存（图片/笔记等）。",
          confirmText: "断开",
          cancelText: "取消",
          success: (res) => {
            if (res && res.confirm) resolve();
            else reject(new Error("cancel"));
          },
          fail: () => reject(new Error("modal fail")),
        });
      });
    } catch (_) {
      return;
    }

    try {
      // 清空设备端配对记录：下次连接需要重新确认配对
      try {
        if (ble.state.connected) {
          await ble.sendJsonStopAndWait({ cmd: "ble_forget" }, { timeoutMs: 1200, retries: 1 });
        }
      } catch (_) {}

      // 清空小程序所有缓存（包含图片/笔记预览等），并移除“信任设备”记录
      clearAllCachesKeepIdentity();

      await ble.disconnect();
    } catch (_) {}

    // 返回连接页后：让 connect 页主动扫描（通过 query 参数触发）
    try {
      wx.redirectTo({ url: "/pages/connect/connect?scan=1" });
    } catch (_) {}
  },

  onCancelConfirm() {
    this._confirmAction = "";
    this.setData({ confirmOpen: false, confirmMsg: "" });
  },

  async onOkConfirm() {
    const action = this._confirmAction || "";
    this.setData({ confirmOpen: false });

    // delete_note is encoded as "delete_note:idx"
    if (action.startsWith("delete_note:")) {
      const idx = Number(action.split(":")[1] || -1);
      try {
        await ble.sendJsonStopAndWait({ cmd: "delete_note", index: idx }, { timeoutMs: 1500, retries: 2 });
        await this.onRefreshNotes();
      } catch (e) {
        ble.log("delete_note FAIL: " + ((e && e.message) || String(e)));
      }
      this.scheduleUiRefresh(true);
      return;
    }

    if (!ble.state.connected) return;
    try {
      if (action === "format_fs") {
        await ble.sendJsonStopAndWait({ cmd: "format_fs" }, { timeoutMs: 2000, retries: 2 });
        this.setData({ status: "已格式化" });
      } else if (action === "reset_system") {
        await ble.sendJsonStopAndWait({ cmd: "reset_system" }, { timeoutMs: 2000, retries: 1 });
        this.setData({ status: "已发送恢复出厂，等待断连..." });
      }
    } catch (e) {
      ble.log("confirm action FAIL: " + ((e && e.message) || String(e)));
      this.setData({ status: "操作失败" });
    }
    this.scheduleUiRefresh(true);
  },
});

