import { ble } from "../../services/ble";
import { FrameType } from "../../services/proto_bin";

const IMG_BYTES = 240 * 240 * 2;
const CHUNK_BYTES = 150;

function le32(v) {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
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
    previewSlot: 0,
    slots: [
      { slot: 0, status: "-" },
      { slot: 1, status: "-" },
      { slot: 2, status: "-" },
    ],
    log: "",
  },

  _pull: null,
  _ctx: null,
  _uiT: 0,
  _uiDirty: false,
  _slotsCache: null,
  _slotsDirty: false,

  onLoad() {
    this._slotsCache = (this.data.slots || []).map((s) => ({ ...s }));

    ble.onFrame(async (f) => {
      if (f.type === FrameType.ImgPullChunk) {
        await this.onPullChunk(f);
        return;
      }
      if (f.type === FrameType.ImgPullFinish) {
        await this.onPullFinish(f);
        return;
      }
    });

    ble.onConnectionStateChange(() => {
      this.syncState();
      this.scheduleUiRefresh(true);
    });

    this.syncState();
    this.scheduleUiRefresh(true);
  },

  async onReady() {
    try {
      this._ctx = await getCanvas2d(this);
    } catch (e) {
      ble.log("canvas init FAIL: " + ((e && e.message) || String(e)));
      this.scheduleUiRefresh(true);
    }
  },

  syncState() {
    this.setData({
      connected: ble.state.connected,
      deviceId: ble.state.deviceId || "",
    });
  },

  setSlotStatus(slot, status) {
    if (!this._slotsCache) this._slotsCache = (this.data.slots || []).map((s) => ({ ...s }));
    this._slotsCache = (this._slotsCache || []).map((s) => (s.slot === slot ? { ...s, status } : s));
    this._slotsDirty = true;
    this.scheduleUiRefresh();
  },

  scheduleUiRefresh(force = false) {
    this._uiDirty = true;
    if (this._uiT && !force) return;
    if (this._uiT) clearTimeout(this._uiT);
    this._uiT = setTimeout(() => {
      this._uiT = 0;
      if (!this._uiDirty && !force) return;
      this._uiDirty = false;
      const patch = { log: ble.getLogsText({ maxChars: 4000 }) };
      if (this._slotsDirty && this._slotsCache) {
        patch.slots = this._slotsCache;
        this._slotsDirty = false;
      }
      this.setData(patch);
    }, 80);
  },

  async onOpenAdapter() {
    try {
      await ble.openAdapter();
      ble.log("openBluetoothAdapter OK");
      this.syncState();
      this.scheduleUiRefresh(true);
    } catch (e) {
      ble.log("openBluetoothAdapter FAIL: " + ((e && e.message) || String(e)));
      this.scheduleUiRefresh(true);
    }
  },

  async onScanConnect() {
    try {
      ble.log("scanning...");
      await ble.scanAndConnectFirstCody();
      ble.log("connected OK");
      this.syncState();
      this.scheduleUiRefresh(true);
    } catch (e) {
      ble.log("scan/connect FAIL: " + ((e && e.message) || String(e)));
      this.syncState();
      this.scheduleUiRefresh(true);
    }
  },

  async onPing() {
    try {
      await ble.sendPingStopAndWait({ timeoutMs: 800, retries: 3 });
      ble.log("PING OK");
    } catch (e) {
      ble.log("PING FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh(true);
  },

  async onCopyLogs() {
    try {
      await ble.copyLogs({ maxChars: 20000 });
      ble.log("copyLogs OK");
    } catch (e) {
      ble.log("copyLogs FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh(true);
  },

  onClearLogs() {
    ble.clearLogs();
    this.scheduleUiRefresh(true);
  },

  async onPull(evt) {
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    try {
      this.setSlotStatus(slot, "pulling...");
      this.setData({ previewSlot: slot });
      this._pull = { slot, buf: new Uint8Array(IMG_BYTES), got: 0, done: false };
      await ble.sendFrameStopAndWait(FrameType.ImgPullBegin, new Uint8Array([slot & 0xff]), { timeoutMs: 800, retries: 3 });
      ble.log(`PULL_BEGIN slot${slot} ACK OK，等待设备分块...`);
      this.scheduleUiRefresh();
    } catch (e) {
      this._pull = null;
      this.setSlotStatus(slot, "pull fail");
      ble.log("PULL_BEGIN FAIL: " + ((e && e.message) || String(e)));
      this.scheduleUiRefresh(true);
    }
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
    this.setSlotStatus(ctx.slot, `pull ${Math.floor((ctx.got * 100) / IMG_BYTES)}%`);
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
      const c2d = (this._ctx && this._ctx.ctx) || null;
      if (!c2d) throw new Error("canvas ctx not ready");
      const imageData = c2d.createImageData(240, 240);
      rgb565ToImageData(ctx.buf, imageData);
      c2d.putImageData(imageData, 0, 0);
      ble.log(`PULL_FINISH slot${ctx.slot} 渲染完成`);
    } catch (e) {
      ble.log("render FAIL: " + ((e && e.message) || String(e)));
    } finally {
      this._pull = null;
      this.scheduleUiRefresh(true);
    }
  },

  async onPush(evt) {
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    try {
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

      const canvas = this._ctx && this._ctx.canvas;
      const ctx2d = this._ctx && this._ctx.ctx;
      if (!canvas || !ctx2d) throw new Error("canvas ctx not ready");

      this.setData({ previewSlot: slot });
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
      ctx2d.drawImage(img, sx, sy, s, s, 0, 0, 240, 240);

      const imageData = ctx2d.getImageData(0, 0, 240, 240);
      const rgb565 = imageDataToRgb565(imageData);

      this.setSlotStatus(slot, "pushing...");
      await ble.sendFrameStopAndWait(
        FrameType.ImgPushBegin,
        new Uint8Array([slot & 0xff, ...le32(IMG_BYTES)]),
        { timeoutMs: 1200, retries: 3 }
      );

      let lastUi = 0;
      for (let off = 0; off < rgb565.length; off += CHUNK_BYTES) {
        const chunk = rgb565.subarray(off, Math.min(rgb565.length, off + CHUNK_BYTES));
        const pl = new Uint8Array(1 + 4 + chunk.length);
        pl[0] = slot & 0xff;
        pl.set(le32(off), 1);
        pl.set(chunk, 5);
        await ble.sendFrameStopAndWait(FrameType.ImgPushChunk, pl, { timeoutMs: 1200, retries: 5 });
        const now = Date.now();
        if (now - lastUi >= 80 || off + chunk.length >= rgb565.length) {
          lastUi = now;
          this.setSlotStatus(slot, `push ${Math.floor(((off + chunk.length) * 100) / IMG_BYTES)}%`);
        }
      }

      await ble.sendFrameStopAndWait(
        FrameType.ImgPushFinish,
        new Uint8Array([slot & 0xff, ...le32(IMG_BYTES)]),
        { timeoutMs: 1200, retries: 3 }
      );
      this.setSlotStatus(slot, "push OK");
      ble.log(`PUSH_FINISH slot${slot} OK`);
      this.scheduleUiRefresh(true);
    } catch (e) {
      this.setSlotStatus(slot, "push fail");
      ble.log("PUSH FAIL: " + ((e && e.message) || String(e)));
      this.scheduleUiRefresh(true);
    }
  },
});