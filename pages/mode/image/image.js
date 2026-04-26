import { ble } from "../../../services/ble";
import { FrameType } from "../../../services/proto_bin";
import {
  IMG_BYTES,
  thumbCacheGet,
  thumbCacheSet,
  thumbCacheDel,
  subscribeImgPullUi,
  enqueueMissingThumbPulls,
  mergeBusyPullRows,
} from "../../../services/img_thumb_sync";

// ImgPushChunk 的 data 安全上限约 166B
const CHUNK_BYTES = 166;

function le32(v) {
  const x = (v >>> 0);
  return new Uint8Array([x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff]);
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
    connected: false,
    deviceId: "",
    canScroll: false,

    imgSlideshowEnabled: true,
    imgInterval: 10,
    uploadLock: false,
    uploadingSlot: -1,
    slots: [
      { slot: 0, status: "-", hasImage: false, previewReady: false, busy: false, progressText: "", progressPct: 0 },
    ],
  },

  _thumbCtx: null,
  _workCtx: null,
  _slotsCache: null,
  _slotsDirty: false,
  _uiT: 0,
  _uiDirty: false,
  _imgPullUiUnsub: null,
  _cancelUploadSlots: null,
  _unsubs: null,
  /** 与控制台图库一致：canvas 重建后必须重画，不能因 previewReady=true 跳过 */
  _forceThumbRedrawOnce: false,

  onLoad() {
    this._thumbCtx = {};
    this._cancelUploadSlots = new Set();
    this._slotsCache = (this.data.slots || []).map((s) => ({ ...s }));

    const unsubs = [];
    unsubs.push(ble.onConnectionStateChange(() => {
      this.syncState();
      this.scheduleUiRefresh(true);
    }));
    this._unsubs = unsubs;

    this._imgPullUiUnsub = subscribeImgPullUi((snap) => this._applyImgThumbSyncSnap(snap));

    this.syncState();
    setTimeout(() => {
      this.onRefreshImgConfig().catch(() => {});
      this._thumbCtx = {};
      this._forceThumbRedrawOnce = true;
      this._ensureThumbCanvases();
      this.onRefreshImageInfo().catch(() => {});
    }, 250);
  },

  onShow() {
    setTimeout(() => this._updateCanScroll(), 80);
    // 从设置子页返回等场景下 canvas 会重建，旧 ctx 失效；须强制从缓存重绘（不能信 previewReady）
    this._forceThumbRedrawOnce = true;
    this._thumbCtx = {};
    this._ensureThumbCanvases();
    setTimeout(() => {
      if (ble.state.connected) {
        this.onRefreshImageInfo().catch(() => {});
      } else {
        this._ensureThumbFromCacheOrPull().catch(() => {});
      }
    }, 150);
  },

  onReady() {
    setTimeout(() => this._updateCanScroll(), 80);
  },

  onUnload() {
    if (this._uiT) clearTimeout(this._uiT);
    this._uiT = 0;
    if (this._imgPullUiUnsub) {
      try { this._imgPullUiUnsub(); } catch (_) {}
      this._imgPullUiUnsub = null;
    }
    const unsubs = this._unsubs || [];
    for (const u of unsubs) {
      try { u(); } catch (_) {}
    }
    this._unsubs = null;
  },

  _updateCanScroll() {
    try {
      const sys = wx.getSystemInfoSync();
      const winH = Number(sys && sys.windowHeight) || 0;
      if (!winH) return;
      wx.createSelectorQuery()
        .in(this)
        .select(".container")
        .boundingClientRect((rect) => {
          const h = Number(rect && rect.height) || 0;
          const can = h > (winH + 2);
          if (can !== !!this.data.canScroll) this.setData({ canScroll: can });
        })
        .exec();
    } catch (_) {}
  },

  syncState() {
    this.setData({
      connected: ble.state.connected,
      deviceId: ble.state.deviceId || "",
    });
  },

  scheduleUiRefresh(force = false) {
    const needSlots = !!this._slotsDirty;
    if (!needSlots && !force) return;
    this._uiDirty = true;
    if (this._uiT && !force) return;
    if (this._uiT) clearTimeout(this._uiT);
    this._uiT = setTimeout(() => {
      this._uiT = 0;
      if (!this._uiDirty && !force) return;
      this._uiDirty = false;
      const patch = {};
      if (this._slotsDirty && this._slotsCache) {
        patch.slots = this._slotsCache;
        this._slotsDirty = false;
      }
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

  _applyImgThumbSyncSnap(snap) {
    for (const ev of snap.events || []) {
      if (ev.type === "pull_ok") {
        this.setSlotProgress(ev.slot, false, "", 0);
        this.setSlotStatus(ev.slot, ev.status || "pull OK");
        const cached = thumbCacheGet(ev.slot);
        if (cached) {
          this._renderThumbFromRgb565(ev.slot, cached)
            .then(() => {
              this._slotsCache = (this._slotsCache || this.data.slots || []).map((s) =>
                (s.slot === ev.slot ? { ...s, hasImage: true, previewReady: true } : s)
              );
              this._slotsDirty = true;
              this.scheduleUiRefresh(true);
            })
            .catch(() => {});
        }
      } else if (ev.type === "pull_fail") {
        this.setSlotProgress(ev.slot, false, "", 0);
        this.setSlotStatus(ev.slot, ev.message || "pull fail");
        this.scheduleUiRefresh(true);
      }
    }
    const meta = snap.slotMeta || {};
    for (const k of Object.keys(meta)) {
      const slot = Number(k);
      const m = meta[k];
      this.setSlotProgress(slot, !!m.busy, "", m.progressPct || 0);
      if (m.status) this.setSlotStatus(slot, m.status);
    }
  },

  async _getThumbCtx(slot) {
    const id = "thumb" + slot;
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
      c2d.fillStyle = "#111";
      c2d.fillRect(0, 0, 240, 240);
    } catch (_) {}
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
        } catch (_) {}
      }
    }, 50);
  },

  async onRefreshImgConfig() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "slideshow_config" }, { timeoutMs: 800, retries: 3 });
      if (r && typeof r.enabled === "boolean") this.setData({ imgSlideshowEnabled: !!r.enabled });
      if (r && (r.interval || r.interval === 0)) this.setData({ imgInterval: Number(r.interval) || 10 });
    } catch (_) {}
  },

  async onImgSlideshowToggle(evt) {
    const enabled = !!(evt && evt.detail && evt.detail.value);
    this.setData({ imgSlideshowEnabled: enabled });
    if (!ble.state.connected) return;
    try {
      await ble.sendJsonStopAndWait({ cmd: "set_img_slideshow", enabled }, { timeoutMs: 800, retries: 3 });
    } catch (_) {}
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
    } catch (_) {}
  },

  async onRefreshImageInfo() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "image_info" }, { timeoutMs: 1200, retries: 3 });
      const indices = Array.isArray(r && r.indices) ? r.indices : null;
      const boolSlots = Array.isArray(r && r.slots) ? r.slots : null;
      const fsFreeB = Number(r && r.fs_free_b);
      const imgBytes = Number(r && r.img_bytes) || IMG_BYTES;
      const canAdd = (r && typeof r.can_add === "boolean") ? !!r.can_add : (Number.isFinite(fsFreeB) ? fsFreeB >= imgBytes : true);
      const nextSlot = Number.isFinite(Number(r && r.next_slot)) ? Number(r.next_slot) : -1;

      let used = [];
      if (indices) used = indices.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
      else if (boolSlots) used = boolSlots.map((v, i) => (v ? i : -1)).filter((x) => x >= 0);

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

      const prevSlotsAll = (this._slotsCache || []).length ? (this._slotsCache || []) : (this.data.slots || []);
      for (const ps of prevSlotsAll) {
        if (!ps || !ps.busy) continue;
        if (slotsOut.find((x) => x.slot === ps.slot)) continue;
        slotsOut.push({ ...ps });
      }
      mergeBusyPullRows(slotsOut);
      if (!slotsOut.length) slotsOut.push({ slot: 0, status: "-", hasImage: false, previewReady: false, busy: false, progressText: "", progressPct: 0 });

      this._slotsCache = slotsOut;
      this.setData({ slots: slotsOut });
      this._ensureThumbCanvases();
      await this._ensureThumbFromCacheOrPull();
    } catch (_) {}
  },

  async _ensureThumbFromCacheOrPull() {
    const slots = this._slotsCache || this.data.slots || [];
    let changed = false;
    for (const s of slots) {
      if (!s || !s.hasImage) continue;
      if (!this._forceThumbRedrawOnce && s.previewReady) continue;
      const cached = thumbCacheGet(s.slot);
      if (cached) {
        try {
          await this._renderThumbFromRgb565(s.slot, cached);
          this._slotsCache = (this._slotsCache || this.data.slots || []).map((x) =>
            (x.slot === s.slot ? { ...x, previewReady: true } : x)
          );
          changed = true;
        } catch (e) {
          const msg = String((e && e.message) || "");
          const notReady =
            msg.includes("canvas node not found") || msg.includes("ctx not ready") || msg.includes("not ready");
          if (notReady) {
            setTimeout(() => {
              this._forceThumbRedrawOnce = true;
              this._ensureThumbCanvases();
              this._ensureThumbFromCacheOrPull().catch(() => {});
            }, 120);
          }
        }
      }
    }
    this._forceThumbRedrawOnce = false;
    if (changed) {
      this._slotsDirty = true;
      this.scheduleUiRefresh(true);
    }
    enqueueMissingThumbPulls(slots);
  },

  async onCancelUpload(evt) {
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    if (!Number.isFinite(slot)) return;
    try { this._cancelUploadSlots && this._cancelUploadSlots.add(slot); } catch (_) {}
    try { this.setSlotStatus(slot, "cancelling..."); } catch (_) {}
    try { await ble.sendJsonStopAndWait({ cmd: "img_cancel" }, { timeoutMs: 1200, retries: 2 }); } catch (_) {}
  },

  async onPush(evt) {
    const from = (evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.from) || "";
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
      ctx2d.fillStyle = "#fff";
      ctx2d.fillRect(0, 0, 240, 240);
      ctx2d.drawImage(img, sx, sy, s, s, 0, 0, 240, 240);
      const imageData = ctx2d.getImageData(0, 0, 240, 240);
      const rgb565 = imageDataToRgb565(imageData);

      this.setSlotProgress(slot, true, "", 0);
      this.setSlotStatus(slot, "pushing...");
      await ble.sendFrameStopAndWait(FrameType.ImgPushBegin, new Uint8Array([slot & 0xff, ...le32(IMG_BYTES)]), { timeoutMs: 1200, retries: 3 });

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
        const n = Date.now();
        if (n - lastUi >= 80 || off + chunk.length >= rgb565.length) {
          lastUi = n;
          const pct = Math.floor(((off + chunk.length) * 100) / IMG_BYTES);
          this.setSlotProgress(slot, true, "", pct);
        }
      }
      await ble.sendFrameStopAndWait(FrameType.ImgPushFinish, new Uint8Array([slot & 0xff, ...le32(IMG_BYTES)]), { timeoutMs: 1200, retries: 3 });
      this.setSlotStatus(slot, "push OK");
      this.setSlotProgress(slot, false, "", 0);
      thumbCacheSet(slot, rgb565);
      try { await this._renderThumbFromRgb565(slot, rgb565); } catch (_) {}
      this._slotsCache = (this._slotsCache || this.data.slots || []).map((s0) => (s0.slot === slot ? { ...s0, hasImage: true, previewReady: true } : s0));
      this._slotsDirty = true;
      this.scheduleUiRefresh(true);
      this.onRefreshImageInfo().catch(() => {});
    } catch (e) {
      const msg = (e && e.message) || String(e);
      this.setSlotProgress(slot, false, "", 0);
      this.setSlotStatus(slot, msg === "cancelled" ? "cancelled" : "push fail");
      const curSlot = (this._slotsCache || this.data.slots || []).find((s) => s.slot === slot);
      const isReplace = !!(curSlot && curSlot.hasImage);
      if (!isReplace) {
        try { thumbCacheDel(slot); } catch (_) {}
        try { await this._clearThumb(slot); } catch (_) {}
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
      thumbCacheDel(slot);
      await this._clearThumb(slot);
      this._slotsCache = (this._slotsCache || this.data.slots || []).filter((s) => s.slot !== slot);
      this._slotsDirty = true;
      this.scheduleUiRefresh(true);
      this.onRefreshImageInfo().catch(() => {});
    } catch (_) {
      this.setSlotStatus(slot, "delete fail");
      this.scheduleUiRefresh(true);
    }
  },
});

