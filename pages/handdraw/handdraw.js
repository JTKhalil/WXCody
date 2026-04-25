import { ble } from "../../services/ble";
import { FrameType } from "../../services/proto_bin";

// 复用 console 页的手绘实现：保持功能一致，后续再抽公共模块
const IMG_BYTES = 240 * 240 * 2;
const CHUNK_BYTES = 166;
const HD_BLE_BATCH_IMMEDIATE = 3;
const HD_BLE_BATCH_DEBOUNCE_MS = 1;

function hexToRgb565(hex) {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6) return 0;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (![r, g, b].every((n) => Number.isFinite(n))) return 0;
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function clampHanddrawXY(x, y) {
  return {
    x: Math.max(0, Math.min(239, Math.floor(x))),
    y: Math.max(0, Math.min(239, Math.floor(y))),
  };
}

function makeSolidHanddrawRgb565(bg) {
  const black = (String(bg || "").toLowerCase() !== "white");
  const v = black ? 0x0000 : 0xffff;
  const out = new Uint8Array(IMG_BYTES);
  for (let i = 0; i < out.length; i += 2) {
    out[i] = v & 0xff;
    out[i + 1] = (v >>> 8) & 0xff;
  }
  return out;
}

function handdrawRgb565ApplySegment(buf, x0, y0, x1, y1, c, w) {
  // 粗略 Bresenham：与 console 一致即可（手机端仅用于本地预览）
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  const r = Math.max(0, Math.floor(w / 2));
  const plot = (x, y) => {
    for (let yy = y - r; yy <= y + r; yy++) {
      if (yy < 0 || yy > 239) continue;
      for (let xx = x - r; xx <= x + r; xx++) {
        if (xx < 0 || xx > 239) continue;
        const off = (yy * 240 + xx) * 2;
        buf[off] = c & 0xff;
        buf[off + 1] = (c >>> 8) & 0xff;
      }
    }
  };
  while (true) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

async function getCanvas2dById(page, id, s) {
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
        canvas.width = s;
        canvas.height = s;
        resolve({ canvas, ctx });
      });
  });
}

function putRgb565BufferOnCanvas(ctx2d, rgb565) {
  const imageData = ctx2d.createImageData(240, 240);
  const dst = imageData.data;
  let di = 0;
  for (let i = 0; i + 1 < rgb565.length; i += 2) {
    const v = rgb565[i] | (rgb565[i + 1] << 8);
    const r5 = (v >> 11) & 0x1f;
    const g6 = (v >> 5) & 0x3f;
    const b5 = (v >> 0) & 0x1f;
    dst[di++] = (r5 * 255 + 15) / 31;
    dst[di++] = (g6 * 255 + 31) / 63;
    dst[di++] = (b5 * 255 + 15) / 31;
    dst[di++] = 255;
  }
  ctx2d.putImageData(imageData, 0, 0);
}

function hexStringToBytes(hex) {
  const s = String(hex || "").trim();
  if (!s) return new Uint8Array();
  const clean = s.startsWith("0x") ? s.slice(2) : s;
  const n = Math.floor(clean.length / 2);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) & 0xff;
  }
  return out;
}

const HD_GUESS_WORDS = [
  "苹果","香蕉","橙子","西瓜","草莓","葡萄","梨","桃子","樱桃","菠萝",
  "胡萝卜","西红柿","黄瓜","土豆","茄子","白菜","玉米","辣椒","洋葱","南瓜",
  "猫","狗","兔子","老虎","狮子","大象","熊猫","猴子","鸟","鱼",
  "汽车","自行车","飞机","船","火车","公交车","摩托车","直升机","火箭","潜艇",
  "太阳","月亮","星星","云","雨","雪","彩虹","闪电","风","雷",
  "房子","学校","医院","桥","塔","城堡","帐篷","窗户","门","楼梯",
  "书","笔","书包","电脑","手机","电视","钟表","椅子","桌子","床",
  "足球","篮球","乒乓球","羽毛球","滑雪","游泳","风筝","秋千","滑梯","跷跷板",
  "蛋糕","冰淇淋","面包","饺子","面条","米饭","糖果","巧克力","奶茶","汉堡",
  "帽子","鞋子","袜子","手套","围巾","眼镜","雨伞","背包","裙子","裤子",
];

function pickRandomGuessWord() {
  return HD_GUESS_WORDS[Math.floor(Math.random() * HD_GUESS_WORDS.length)];
}

Page({
  data: {
    connected: false,
    codyName: "",
    modeCurrent: -1,

    hdPenHex: "#ffffff",
    hdStrokeW: 4,
    hdBg: "black",
    hdPalette: ["#000000", "#ffffff", "#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#e67e22"],

    hdPulling: false,
    hdPullPercent: 0,
    hdClearing: false,
    hdDrawBlocked: false,
    hdDrawBlockMsg: "",
    hdGuessStarting: false,
    hdGuessPlaying: false,
    hdGuessPrompt: "",
    hdGuessRevealBlock: false,
    hdGuessRevealMsg: "本局答案已揭晓，请清屏或开始新游戏后再绘画。",
  },

  _hdCtx: null,
  _hdLast: null,
  _handdrawBleReady: false,
  _hdRgb565Cache: null,
  _hdBleBatch: null,
  _hdBleBatchTimer: 0,
  _hdBleSendChain: null,
  _hdGuessTimer: 0,
  _hdModePollId: 0,

  onLoad() {
    this._handdrawBleReady = true;
    this._hdBleSendChain = Promise.resolve();
    this._ensureGalleryFrameHandler();
    this._syncConn();
    this._startHanddrawModePoll();
  },

  onUnload() {
    this._stopHanddrawModePoll();
    if (this._hdGuessTimer) {
      try { clearTimeout(this._hdGuessTimer); } catch (_) {}
      this._hdGuessTimer = 0;
    }
  },

  onShow() {
    this._syncConn();
    setTimeout(() => this._enterHanddraw().catch(() => {}), 50);
  },

  async _enterHanddraw() {
    this._handdrawBleReady = false;
    this.setData({ hdPulling: false, hdPullPercent: 0 });
    const meta = await this._syncHanddrawMeta();
    const bgKey = meta ? meta.bg : "black";
    const deviceHasArt = !!(meta && meta.hasArt);
    if (!deviceHasArt) {
      this._hdRgb565Cache = makeSolidHanddrawRgb565(bgKey);
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, 0);
    } else if (this._hdRgb565Cache instanceof Uint8Array && this._hdRgb565Cache.length === IMG_BYTES) {
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, 0);
    } else {
      try {
        const pulled = await this._pullHanddrawBitmapFromDevice();
        this._hdRgb565Cache = pulled;
        await this._attachHanddrawCanvasAndPaint(pulled, 0);
      } catch (_) {
        this._hdRgb565Cache = makeSolidHanddrawRgb565(bgKey);
        await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, 0);
      }
    }
    await this._syncHanddrawStatus().catch(() => {});
    this._handdrawBleReady = true;
  },

  _syncConn() {
    const connected = !!ble.state.connected;
    this.setData({ connected, codyName: ble.state.deviceName || "" });
  },

  _updateHanddrawBlockState() {
    const m = Number(this.data.modeCurrent);
    const connected = !!ble.state.connected;
    const blocked = connected && Number.isFinite(m) && m >= 0 && m !== 4;
    const msg = "Cody 当前不是手绘模式，画板已锁定。请先切换为「手绘模式」后再绘画。";
    if (this.data.hdDrawBlocked !== blocked || this.data.hdDrawBlockMsg !== msg) {
      this.setData({ hdDrawBlocked: blocked, hdDrawBlockMsg: msg });
    }
  },

  _isHanddrawPaintBlocked() {
    if (!ble.state.connected) return true;
    const m = Number(this.data.modeCurrent);
    if (!Number.isFinite(m) || m < 0) return false;
    if (m !== 4) return true;
    if (this.data.hdGuessRevealBlock) return true;
    return false;
  },

  _isHanddrawModeOnlyBlocked() {
    if (!ble.state.connected) return true;
    const m = Number(this.data.modeCurrent);
    if (!Number.isFinite(m) || m < 0) return false;
    return m !== 4;
  },

  _syncGuessRevealFromModeResponse(r) {
    const showAns = !!(r && (r.guess_show_answer === true || r.guess_show_answer === 1));
    if (showAns) {
      if (!this.data.hdGuessRevealBlock || this.data.hdGuessPlaying) {
        if (this._hdGuessTimer) {
          try { clearTimeout(this._hdGuessTimer); } catch (_) {}
          this._hdGuessTimer = 0;
        }
        this.setData({ hdGuessRevealBlock: true, hdGuessPlaying: false, hdGuessPrompt: "", hdGuessStarting: false });
      }
    } else if (this.data.hdGuessRevealBlock) {
      this.setData({ hdGuessRevealBlock: false });
    }
  },

  _startHanddrawModePoll() {
    if (this._hdModePollId) return;
    const tick = async () => {
      if (!ble.state.connected) return;
      try {
        const r = await ble.sendJsonStopAndWait({ cmd: "get_mode" }, { timeoutMs: 700, retries: 1 });
        this._syncGuessRevealFromModeResponse(r);
        const m = Number(r && r.mode);
        if (Number.isFinite(m) && m !== Number(this.data.modeCurrent)) {
          this.setData({ modeCurrent: m }, () => this._updateHanddrawBlockState());
        } else {
          this._updateHanddrawBlockState();
        }
      } catch (_) {
        this._updateHanddrawBlockState();
      }
    };
    this._hdModePollId = setInterval(tick, 2200);
    tick();
  },

  _stopHanddrawModePoll() {
    if (!this._hdModePollId) return;
    try { clearInterval(this._hdModePollId); } catch (_) {}
    this._hdModePollId = 0;
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

  async _syncHanddrawStatus() {
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "handdraw_status" }, { timeoutMs: 1500, retries: 2 });
      if (r && r.status === "ok") {
        const bg = r.bg === "white" ? "white" : "black";
        this.setData({ hdBg: bg });
        return { bg, hasArt: !!r.bg_locked };
      }
    } catch (_) {}
    return null;
  },

  async _syncHanddrawMeta() {
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "handdraw_meta" }, { timeoutMs: 1200, retries: 2 });
      if (r && r.status === "ok") {
        const bg = r.bg === "white" ? "white" : "black";
        const hasArt = !!r.has_art;
        this.setData({ hdBg: bg });
        return { bg, hasArt };
      }
    } catch (_) {}
    return null;
  },

  async _pullHanddrawBitmapFromDevice() {
    const chunk = 720;
    const out = new Uint8Array(IMG_BYTES);
    let total = 0;
    this.setData({ hdPulling: true, hdPullPercent: 0 });
    try {
      for (let off = 0; off < IMG_BYTES; off += chunk) {
        const len = Math.min(chunk, IMG_BYTES - off);
        const r = await ble.sendJsonStopAndWait({ cmd: "handdraw_pull_chunk", off, len }, { timeoutMs: 2500, retries: 2 });
        if (!r || r.status !== "ok") throw new Error("handdraw_pull_chunk failed");
        const got = Number(r.len) || 0;
        if (got === 0) break;
        const raw = hexStringToBytes(r.data || "");
        if (!raw || raw.length < got) throw new Error("handdraw_pull bad hex");
        out.set(raw.subarray(0, got), off);
        total += got;
        const pct = Math.min(100, Math.floor((total * 100) / IMG_BYTES));
        this.setData({ hdPullPercent: pct });
        if (got < len) break;
      }
      if (total !== IMG_BYTES) throw new Error("incomplete handdraw pull");
      return out;
    } finally {
      this.setData({ hdPulling: false, hdPullPercent: 0 });
    }
  },

  async _attachHanddrawCanvasAndPaint(rgb565, _tab) {
    const pack = await getCanvas2dById(this, "canvasDraw", 240);
    this._hdCtx = this._hdCtx || {};
    this._hdCtx.canvasDraw = pack;
    const c2d = pack && pack.ctx;
    if (!c2d) return;
    const buf = (rgb565 instanceof Uint8Array && rgb565.length === IMG_BYTES) ? rgb565 : makeSolidHanddrawRgb565(this.data.hdBg);
    putRgb565BufferOnCanvas(c2d, buf);
  },

  _cancelHdBleBatchTimer() {
    if (!this._hdBleBatchTimer) return;
    try { clearTimeout(this._hdBleBatchTimer); } catch (_) {}
    this._hdBleBatchTimer = 0;
  },

  _flushHdBleBatchNow() {
    if (!this._hdBleBatch || !this._hdBleBatch.length) return;
    const copy = this._hdBleBatch.slice(0);
    this._hdBleBatch = [];
    const run = () => {
      let p = Promise.resolve();
      for (const s of copy) {
        const payload = { cmd: "draw_stroke", x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, c: s.c, w: s.w };
        p = p.then(() => ble.sendJson(payload, { interChunkDelayMs: 0, writeNoResponse: true }));
      }
      return p;
    };
    this._hdBleSendChain = (this._hdBleSendChain || Promise.resolve()).then(run).catch(() => {});
  },

  async _awaitHanddrawBleIdle() {
    this._flushHdBleBatchNow();
    await (this._hdBleSendChain || Promise.resolve());
  },

  onHdPickColor(e) {
    const hex = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.hex) || "";
    if (!hex) return;
    this.setData({ hdPenHex: String(hex) });
  },

  onHdStrokeChanging(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (!Number.isFinite(v)) return;
    this.setData({ hdStrokeW: v });
  },

  onHdStrokeChange(evt) {
    this.onHdStrokeChanging(evt);
  },

  onHdTouchStart(e) {
    if (!ble.state.connected || !this._handdrawBleReady || this._isHanddrawPaintBlocked()) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    if (this._hdBleBatch && this._hdBleBatch.length) this._flushHdBleBatchNow();
    const x = Math.floor(t.x);
    const y = Math.floor(t.y);
    this._hdLast = this._hdLast || {};
    this._hdLast.canvasDraw = { x, y };
  },

  onHdTouchMove(e) {
    if (!ble.state.connected || !this._handdrawBleReady || this._isHanddrawPaintBlocked()) return;
    const prev = this._hdLast && this._hdLast.canvasDraw;
    if (!prev) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const x = Math.floor(t.x);
    const y = Math.floor(t.y);
    const m0 = clampHanddrawXY(prev.x, prev.y);
    const m1 = clampHanddrawXY(x, y);
    if (m0.x === m1.x && m0.y === m1.y) return;
    const c = hexToRgb565(this.data.hdPenHex);
    const w = Number(this.data.hdStrokeW) || 4;
    if (!(this._hdRgb565Cache instanceof Uint8Array) || this._hdRgb565Cache.length !== IMG_BYTES) {
      this._hdRgb565Cache = makeSolidHanddrawRgb565(this.data.hdBg || "black");
    }
    handdrawRgb565ApplySegment(this._hdRgb565Cache, m0.x, m0.y, m1.x, m1.y, c, w);
    const pack = this._hdCtx && this._hdCtx.canvasDraw;
    if (pack && pack.ctx) putRgb565BufferOnCanvas(pack.ctx, this._hdRgb565Cache);
    this._hdBleBatch = this._hdBleBatch || [];
    if (this._hdBleBatch.length >= 14) this._flushHdBleBatchNow();
    this._hdBleBatch.push({ x0: m0.x, y0: m0.y, x1: m1.x, y1: m1.y, c, w });
    if (this._hdBleBatch.length >= HD_BLE_BATCH_IMMEDIATE) {
      this._flushHdBleBatchNow();
    } else {
      this._cancelHdBleBatchTimer();
      this._hdBleBatchTimer = setTimeout(() => {
        this._hdBleBatchTimer = 0;
        this._flushHdBleBatchNow();
      }, HD_BLE_BATCH_DEBOUNCE_MS);
    }
    this._hdLast.canvasDraw = { x, y };
  },

  onHdTouchEnd() {
    this._cancelHdBleBatchTimer();
    this._flushHdBleBatchNow();
    if (this._hdLast) this._hdLast.canvasDraw = null;
  },

  async onHdClear() {
    if (!ble.state.connected || this._isHanddrawModeOnlyBlocked()) return;
    this.setData({ hdClearing: true });
    try { await this._awaitHanddrawBleIdle(); } catch (_) {}
    this._cancelHdBleBatchTimer();
    this._hdBleBatch = null;
    this._hdBleSendChain = Promise.resolve();
    try {
      await ble.sendJsonStopAndWait({ cmd: "handdraw_clear" }, { timeoutMs: 1500, retries: 2 });
      const bg = this.data.hdBg || "black";
      if (this._hdLast) this._hdLast.canvasDraw = null;
      this._hdRgb565Cache = makeSolidHanddrawRgb565(bg);
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, 0);
      // 清屏只清画：揭晓阶段清屏解锁
      const stillPlaying = !!this.data.hdGuessPlaying;
      const wasReveal = !!this.data.hdGuessRevealBlock;
      if (!stillPlaying && this._hdGuessTimer) {
        try { clearTimeout(this._hdGuessTimer); } catch (_) {}
        this._hdGuessTimer = 0;
      }
      const patch = { hdGuessStarting: false };
      if (wasReveal) {
        patch.hdGuessRevealBlock = false;
        patch.hdGuessPlaying = false;
        patch.hdGuessPrompt = "";
      }
      this.setData(patch);
    } catch (_) {
      // ignore
    } finally {
      this.setData({ hdClearing: false });
    }
  },

  async _onGuessGameTimeout() {
    this._hdGuessTimer = 0;
    if (!this.data.hdGuessPlaying) return;
    try {
      await ble.sendJsonStopAndWait({ cmd: "guess_game_end" }, { timeoutMs: 1500, retries: 2 });
      this.setData({ hdGuessPlaying: false, hdGuessPrompt: "", hdGuessRevealBlock: true });
    } catch (_) {
      this.setData({ hdGuessPlaying: false, hdGuessPrompt: "" });
    }
  },

  async onHdGuessGame() {
    if (!ble.state.connected || this._isHanddrawModeOnlyBlocked() || this.data.hdClearing || this.data.hdGuessStarting) return;
    if (this.data.hdGuessPlaying) {
      if (this._hdGuessTimer) {
        try { clearTimeout(this._hdGuessTimer); } catch (_) {}
        this._hdGuessTimer = 0;
      }
      try {
        await ble.sendJsonStopAndWait({ cmd: "guess_game_end" }, { timeoutMs: 1500, retries: 2 });
        this.setData({ hdGuessPlaying: false, hdGuessPrompt: "", hdGuessRevealBlock: true });
      } catch (_) {
        this.setData({ hdGuessPlaying: false, hdGuessPrompt: "" });
      }
      return;
    }
    const word = pickRandomGuessWord();
    this.setData({ hdGuessPlaying: true, hdGuessPrompt: word, hdGuessStarting: true });
    try {
      await this._awaitHanddrawBleIdle();
      await ble.sendJsonStopAndWait({ cmd: "guess_game_start", word, seconds: 180 }, { timeoutMs: 2500, retries: 2 });
      const bg = this.data.hdBg || "black";
      this._hdRgb565Cache = makeSolidHanddrawRgb565(bg);
      if (this._hdLast) this._hdLast.canvasDraw = null;
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, 0);
      this._handdrawBleReady = true;
    } catch (_) {
      if (this._hdGuessTimer) {
        try { clearTimeout(this._hdGuessTimer); } catch (_) {}
        this._hdGuessTimer = 0;
      }
      this.setData({ hdGuessPlaying: false, hdGuessPrompt: "", hdGuessStarting: false, hdGuessRevealBlock: false });
      return;
    }
    this.setData({ hdGuessStarting: false, hdGuessRevealBlock: false });
    if (this._hdGuessTimer) {
      try { clearTimeout(this._hdGuessTimer); } catch (_) {}
    }
    this._hdGuessTimer = setTimeout(() => this._onGuessGameTimeout(), 180000);
  },

  // 手绘同步使用 JSON handdraw_pull_chunk；二进制 ImgPull 帧仅用于图库 slot pull
});

