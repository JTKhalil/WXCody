import { ble } from "./ble";
import { FrameType } from "./proto_bin";

export const IMG_BYTES = 240 * 240 * 2;

const THUMB_CACHE_PREFIX = "wxcody_thumb_rgb565_slot_";

function cacheKeyForSlot(slot) {
  return THUMB_CACHE_PREFIX + String(slot);
}

export function thumbCacheGet(slot) {
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

export function thumbCacheSet(slot, rgb565) {
  try {
    const u8 = rgb565 instanceof Uint8Array ? rgb565 : new Uint8Array(rgb565);
    if (u8.length !== IMG_BYTES) return;
    const b64 = wx.arrayBufferToBase64(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    wx.setStorageSync(cacheKeyForSlot(slot), b64);
  } catch (_) {}
}

export function thumbCacheDel(slot) {
  try {
    wx.removeStorageSync(cacheKeyForSlot(slot));
  } catch (_) {}
}

function readLe32(b, off) {
  return ((b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0);
}

let _frameUnsub = null;
let _connUnsub = null;
/** @type {{ slot: number, buf: Uint8Array, got: number, done: boolean } | null} */
let _pull = null;
let _pullQueue = [];
let _pullQueueRunning = false;
let _listeners = [];

function resetImgThumbPullOnDisconnect() {
  const events = [];
  const seen = new Set();
  if (_pull && !_pull.done) {
    seen.add(_pull.slot);
    events.push({ type: "pull_fail", slot: _pull.slot, message: "连接已断开" });
  }
  for (const slot of _pullQueue) {
    if (seen.has(slot)) continue;
    seen.add(slot);
    events.push({ type: "pull_fail", slot, message: "连接已断开" });
  }
  _pull = null;
  _pullQueue.length = 0;
  _pullQueueRunning = false;
  if (events.length) emit(events);
  else emit();
}

function ensureConnPullResetListener() {
  if (_connUnsub) return;
  _connUnsub = ble.onConnectionStateChange((connected) => {
    if (connected) return;
    resetImgThumbPullOnDisconnect();
  });
}

function buildSlotMeta() {
  /** @type {Record<string, { busy: boolean, progressPct: number, status?: string, queued?: boolean }>} */
  const meta = {};
  for (const qs of _pullQueue) {
    if (!meta[String(qs)]) {
      meta[String(qs)] = { busy: true, progressPct: 0, status: "waiting...", queued: true };
    }
  }
  if (_pull && !_pull.done) {
    const slot = _pull.slot;
    const pct = Math.floor((_pull.got * 100) / IMG_BYTES);
    meta[String(slot)] = { busy: true, progressPct: pct, status: "pulling...", queued: false };
  }
  return meta;
}

/**
 * @param {Array<{ type: string, slot: number, status?: string, message?: string }>} [events]
 */
function emit(events) {
  const snap = { slotMeta: buildSlotMeta(), events: events || [] };
  for (const cb of _listeners) {
    try {
      cb(snap);
    } catch (_) {}
  }
}

export function getThumbPullOverlay() {
  return buildSlotMeta();
}

/** 将正在拉取/排队中的 slot 合并进 image_info 得到的列表（例如离开设置页后仍在后台同步） */
export function mergeBusyPullRows(slotsOut) {
  const overlay = getThumbPullOverlay();
  for (const k of Object.keys(overlay)) {
    const slot = Number(k);
    const o = overlay[k];
    let row = slotsOut.find((x) => x.slot === slot);
    if (!row) {
      slotsOut.push({
        slot,
        status: o.status || "-",
        hasImage: true,
        previewReady: false,
        busy: !!o.busy,
        progressText: "",
        progressPct: Number.isFinite(o.progressPct) ? o.progressPct : 0,
      });
    } else if (o.busy) {
      row.busy = true;
      row.progressPct = o.progressPct;
      if (o.status) row.status = o.status;
    }
  }
}

export function subscribeImgPullUi(cb) {
  ensureImgPullListener();
  _listeners.push(cb);
  try {
    cb({ slotMeta: buildSlotMeta(), events: [] });
  } catch (_) {}
  return () => {
    _listeners = _listeners.filter((x) => x !== cb);
  };
}

/** 全局唯一 ImgPull 帧监听；不因某个页面 onUnload 而移除 */
export function ensureImgPullListener() {
  ensureConnPullResetListener();
  if (_frameUnsub) return;
  _frameUnsub = ble.onFrame(async (f) => {
    if (f.type === FrameType.ImgPullChunk) {
      await onPullChunk(f);
      return;
    }
    if (f.type === FrameType.ImgPullFinish) {
      await onPullFinish(f);
    }
  });
}

function enqueuePull(slot) {
  if (_pullQueue.includes(slot)) return;
  _pullQueue.push(slot);
  emit();
}

/**
 * @param {Array<{ slot: number, hasImage?: boolean, previewReady?: boolean }>} slots
 */
export function enqueueMissingThumbPulls(slots) {
  ensureImgPullListener();
  for (const s of slots) {
    if (!s || !s.hasImage || s.previewReady) continue;
    if (s.busy) continue;
    if (_pull && _pull.slot === s.slot && !_pull.done) continue;
    if (thumbCacheGet(s.slot)) continue;
    enqueuePull(s.slot);
  }
  _runPullQueue();
}

export async function startThumbPullImmediate(slot) {
  ensureImgPullListener();
  if (!Number.isFinite(slot)) return;
  if (_pull) return;
  await _pullSlot(slot);
}

async function _pullSlot(slot) {
  if (!ble.state.connected) return;
  _pull = { slot, buf: new Uint8Array(IMG_BYTES), got: 0, done: false };
  emit();
  try {
    await ble.sendFrameStopAndWait(FrameType.ImgPullBegin, new Uint8Array([slot & 0xff]), { timeoutMs: 800, retries: 3 });
    emit();
  } catch (_) {
    const failedSlot = slot;
    const hadCtx = _pull && _pull.slot === failedSlot;
    _pull = null;
    // 断线时由 resetImgThumbPullOnDisconnect 统一通知，避免重复 pull_fail
    if (hadCtx && ble.state.connected) {
      emit([{ type: "pull_fail", slot: failedSlot, message: "pull fail" }]);
    }
    _runPullQueue();
  }
}

async function _runPullQueue() {
  if (_pullQueueRunning) return;
  _pullQueueRunning = true;
  try {
    while (ble.state.connected && _pullQueue.length) {
      if (_pull) break;
      const slot = _pullQueue.shift();
      if (!Number.isFinite(slot)) continue;
      emit();
      await _pullSlot(slot);
    }
  } finally {
    _pullQueueRunning = false;
  }
}

async function onPullChunk(f) {
  const pl = new Uint8Array(f.payload);
  if (pl.length < 1 + 4) return;
  const slot = pl[0];
  const off = readLe32(pl, 1);
  const bytes = pl.subarray(5);
  const ctx = _pull;
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
  emit();
}

async function onPullFinish(f) {
  const pl = new Uint8Array(f.payload);
  if (pl.length < 1 + 4) return;
  const slot = pl[0];
  const totalLen = readLe32(pl, 1);
  const ctx = _pull;
  if (!ctx) {
    await ble.sendAck(f.session, f.seq, FrameType.ImgPullFinish, 0);
    return;
  }
  if (slot !== (ctx.slot & 0xff) || totalLen !== IMG_BYTES) {
    await ble.sendAck(f.session, f.seq, FrameType.ImgPullFinish, 1);
    const badSlot = ctx.slot;
    _pull = null;
    emit([{ type: "pull_fail", slot: badSlot, message: "pull fail" }]);
    _runPullQueue();
    return;
  }
  ctx.done = true;
  await ble.sendAck(f.session, f.seq, FrameType.ImgPullFinish, 0);
  const doneSlot = ctx.slot;
  try {
    thumbCacheSet(doneSlot, ctx.buf);
  } catch (_) {}
  _pull = null;
  emit([{ type: "pull_ok", slot: doneSlot, status: "pull OK" }]);
  _runPullQueue();
}
