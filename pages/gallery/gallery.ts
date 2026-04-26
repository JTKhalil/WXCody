import { ble } from "../../services/ble";
import { Frame, FrameType } from "../../services/proto_bin";

const IMG_BYTES = 240 * 240 * 2;
const CHUNK_BYTES = 150;

function le32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
}

function readLe32(b: Uint8Array, off: number): number {
  return ((b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0);
}

async function getCanvas2d(page: any): Promise<{ canvas: any; ctx: any }> {
  return await new Promise((resolve, reject) => {
    wx.createSelectorQuery()
      .in(page)
      .select("#preview")
      .fields({ node: true, size: true })
      .exec((res) => {
        const node = res && res[0] && (res[0] as any).node;
        if (!node) return reject(new Error("canvas node not found"));
        const canvas = node;
        const ctx = canvas.getContext("2d");
        canvas.width = 240;
        canvas.height = 240;
        resolve({ canvas, ctx });
      });
  });
}

function rgb565ToImageData(bytes: Uint8Array, imageData: any) {
  const dst: Uint8ClampedArray = imageData.data;
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

function imageDataToRgb565(imageData: any): Uint8Array {
  const src: Uint8ClampedArray = imageData.data;
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

type PullCtx = {
  slot: number;
  buf: Uint8Array;
  got: number;
  done: boolean;
};

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

  _pull: null as PullCtx | null,
  _ctx: null as any,
  _uiT: 0 as any,
  _uiDirty: false,
  _slotsCache: null as any,
  _slotsDirty: false,

  onLoad() {
    this._slotsCache = (this.data.slots || []).map((s: any) => ({ ...s }));
    ble.onFrame(async (f: Frame) => {
      if (f.type === FrameType.ImgPullChunk) {
        await this.onPullChunk(f);
        return;
      }
      if (f.type === FrameType.ImgPullFinish) {
        await this.onPullFinish(f);
        return;
      }
    });

    ble.onConnectionStateChange((connected) => {
      if (!connected && this._pull && !this._pull.done) {
        const slot = this._pull.slot;
        this._pull = null;
        this.setSlotStatus(slot, "已断开");
      }
      this.syncState();
      this.scheduleUiRefresh(true);
    });
  },

  async onReady() {
    try {
      this._ctx = await getCanvas2d(this);
    } catch (e: any) {
      ble.log("canvas init FAIL: " + (e?.message || String(e)));
      this.scheduleUiRefresh(true);
    }
  },

  syncState() {
    this.setData({
      connected: ble.state.connected,
      deviceId: ble.state.deviceId || "",
    });
  },

  setSlotStatus(slot: number, status: string) {
    if (!this._slotsCache) this._slotsCache = (this.data.slots || []).map((s: any) => ({ ...s }));
    this._slotsCache = (this._slotsCache || []).map((s: any) => (s.slot === slot ? { ...s, status } : s));
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
      const patch: any = { log: ble.getLogsText({ maxChars: 4000 }) };
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
    } catch (e: any) {
      ble.log("openBluetoothAdapter FAIL: " + (e?.message || String(e)));
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
    } catch (e: any) {
      ble.log("scan/connect FAIL: " + (e?.message || String(e)));
      this.syncState();
      this.scheduleUiRefresh(true);
    }
  },

  async onPing() {
    try {
      await ble.sendPingStopAndWait({ timeoutMs: 800, retries: 3 });
      ble.log("PING OK");
    } catch (e: any) {
      ble.log("PING FAIL: " + (e?.message || String(e)));
    }
    this.scheduleUiRefresh(true);
  },

  async onCopyLogs() {
    try {
      await ble.copyLogs({ maxChars: 20000 });
      ble.log("copyLogs OK");
    } catch (e: any) {
      ble.log("copyLogs FAIL: " + (e?.message || String(e)));
    }
    this.scheduleUiRefresh(true);
  },

  onClearLogs() {
    ble.clearLogs();
    this.scheduleUiRefresh(true);
  },

  async onPull(evt: any) {
    const slot = Number(evt?.currentTarget?.dataset?.slot ?? 0);
    try {
      this.setSlotStatus(slot, "pulling...");
      this.setData({ previewSlot: slot });
      this._pull = { slot, buf: new Uint8Array(IMG_BYTES), got: 0, done: false };
      await ble.sendFrameStopAndWait(FrameType.ImgPullBegin, new Uint8Array([slot & 0xff]), { timeoutMs: 800, retries: 3 });
      ble.log(`PULL_BEGIN slot${slot} ACK OK，等待设备分块...`);
      this.scheduleUiRefresh();
    } catch (e: any) {
      this._pull = null;
      this.setSlotStatus(slot, "pull fail");
      ble.log("PULL_BEGIN FAIL: " + (e?.message || String(e)));
      this.scheduleUiRefresh(true);
    }
  },

  async onPullChunk(f: Frame) {
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
    // 节流 UI：分块很密集，这里只让节流器负责刷新。
    this.setSlotStatus(ctx.slot, `pull ${Math.floor((ctx.got * 100) / IMG_BYTES)}%`);
  },

  async onPullFinish(f: Frame) {
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
      const { ctx: c2d } = this._ctx || {};
      if (!c2d) throw new Error("canvas ctx not ready");
      const imageData = c2d.createImageData(240, 240);
      rgb565ToImageData(ctx.buf, imageData);
      c2d.putImageData(imageData, 0, 0);
      ble.log(`PULL_FINISH slot${ctx.slot} 渲染完成`);
    } catch (e: any) {
      ble.log("render FAIL: " + (e?.message || String(e)));
    } finally {
      this._pull = null;
      this.scheduleUiRefresh(true);
    }
  },

  async onPush(evt: any) {
    const slot = Number(evt?.currentTarget?.dataset?.slot ?? 0);
    try {
      this.setSlotStatus(slot, "choosing...");
      const r = await new Promise<WechatMiniprogram.ChooseMediaSuccessCallbackResult>((resolve, reject) => {
        wx.chooseMedia({
          count: 1,
          mediaType: ["image"],
          sourceType: ["album", "camera"],
          success: resolve,
          fail: (e) => reject(new Error(e?.errMsg || "chooseMedia failed")),
        });
      });
      const filePath = r.tempFiles?.[0]?.tempFilePath;
      if (!filePath) throw new Error("no image selected");

      const { canvas, ctx } = this._ctx || {};
      if (!canvas || !ctx) throw new Error("canvas ctx not ready");

      this.setData({ previewSlot: slot });
      this.setSlotStatus(slot, "resizing...");

      const img = canvas.createImage();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image load failed"));
        img.src = filePath;
      });

      // Cover -> 240x240 center crop.
      const sw = img.width;
      const sh = img.height;
      const s = Math.min(sw, sh);
      const sx = Math.floor((sw - s) / 2);
      const sy = Math.floor((sh - s) / 2);
      ctx.clearRect(0, 0, 240, 240);
      ctx.drawImage(img, sx, sy, s, s, 0, 0, 240, 240);

      const imageData = ctx.getImageData(0, 0, 240, 240);
      const rgb565 = imageDataToRgb565(imageData);

      this.setSlotStatus(slot, "pushing...");
      await ble.sendFrameStopAndWait(FrameType.ImgPushBegin, new Uint8Array([slot & 0xff, ...le32(IMG_BYTES)]), { timeoutMs: 1200, retries: 3 });

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

      await ble.sendFrameStopAndWait(FrameType.ImgPushFinish, new Uint8Array([slot & 0xff, ...le32(IMG_BYTES)]), { timeoutMs: 1200, retries: 3 });
      this.setSlotStatus(slot, "push OK");
      ble.log(`PUSH_FINISH slot${slot} OK`);
      this.scheduleUiRefresh(true);
    } catch (e: any) {
      this.setSlotStatus(slot, "push fail");
      ble.log("PUSH FAIL: " + (e?.message || String(e)));
      this.scheduleUiRefresh(true);
    }
  },
});

