import { crc16CcittFalse } from "../utils/crc16";

export const MAGIC0 = 0xc0;
export const MAGIC1 = 0xde;

export const FrameType = {
  Ping: 0x01,
  Ack: 0x7f,
  ImgPullBegin: 0x10,
  ImgPullChunk: 0x11,
  ImgPullFinish: 0x12,
  ImgPushBegin: 0x13,
  ImgPushChunk: 0x14,
  ImgPushFinish: 0x15,
  OtaBegin: 0x20,
  OtaChunk: 0x21,
  OtaFinish: 0x22,
  OtaStatus: 0x23,
  HanddrawStroke: 0x30,
  HanddrawStrokeBatch: 0x31,
};

// ACK errCode constants (must match firmware include/ble/ble_proto.h)
export const AckErr = {
  Ok: 0,
  BadArg: 1,
  Fs: 2,
  Size: 3,
  Proto: 4,
  Busy: 5,
  Update: 6,
  Auth: 7,
};

function le16(v) {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

function readLe16(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8)) & 0xffff;
}

export function buildFrame(type, session, seq, payload) {
  const pl = payload || new Uint8Array(0);
  const len = pl.length & 0xffff;
  const out = new Uint8Array(2 + 1 + 1 + 1 + 2 + len + 2);
  let i = 0;
  out[i++] = MAGIC0;
  out[i++] = MAGIC1;
  out[i++] = type & 0xff;
  out[i++] = session & 0xff;
  out[i++] = seq & 0xff;
  out.set(le16(len), i);
  i += 2;
  if (len) out.set(pl, i);
  i += len;
  const crc = crc16CcittFalse(out.subarray(0, i));
  out.set(le16(crc), i);
  return out;
}

export function buildPing(session, seq) {
  return buildFrame(FrameType.Ping, session, seq);
}

export function buildHanddrawStrokePayload(x0, y0, x1, y1, c, w) {
  const p = new Uint8Array(7);
  p[0] = x0 & 0xff;
  p[1] = y0 & 0xff;
  p[2] = x1 & 0xff;
  p[3] = y1 & 0xff;
  const col = c & 0xffff;
  p[4] = col & 0xff;
  p[5] = (col >> 8) & 0xff;
  p[6] = w & 0xff;
  return p;
}

/** 单帧最大段数：7B/段 + 1B 计数，整帧仍低于常见 BLE ATT MTU */
const HANDDRAW_BATCH_MAX = 20;

export function buildHanddrawStrokeBatchPayload(segs) {
  const n = Math.min(Math.max(0, segs.length), HANDDRAW_BATCH_MAX);
  const p = new Uint8Array(1 + n * 7);
  p[0] = n & 0xff;
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    const o = 1 + i * 7;
    p[o] = s.x0 & 0xff;
    p[o + 1] = s.y0 & 0xff;
    p[o + 2] = s.x1 & 0xff;
    p[o + 3] = s.y1 & 0xff;
    const col = s.c & 0xffff;
    p[o + 4] = col & 0xff;
    p[o + 5] = (col >> 8) & 0xff;
    p[o + 6] = s.w & 0xff;
  }
  return p;
}

export function buildAck(session, seq, origType, errCode) {
  return buildFrame(FrameType.Ack, session, seq, new Uint8Array([origType & 0xff, errCode & 0xff]));
}

export function isAckForPingOk(frame) {
  if (frame.type !== FrameType.Ack) return false;
  if (frame.payload.length < 2) return false;
  const origType = frame.payload[0];
  const errCode = frame.payload[1];
  return origType === FrameType.Ping && errCode === 0;
}

export class FrameParser {
  buf = new Uint8Array(0);

  push(chunk) {
    const incoming = new Uint8Array(chunk);
    this.buf = concat(this.buf, incoming);
    return this.drain();
  }

  drain() {
    const out = [];
    while (this.buf.length > 0) {
      if (!(this.buf.length >= 2 && this.buf[0] === MAGIC0 && this.buf[1] === MAGIC1)) {
        const idx = findNextStart(this.buf);
        if (idx < 0) {
          this.buf = new Uint8Array(0);
          break;
        }
        this.buf = this.buf.subarray(idx);
        continue;
      }

      if (this.buf.length < 2 + 5) break;
      const type = this.buf[2];
      const session = this.buf[3];
      const seq = this.buf[4];
      const len = readLe16(this.buf, 5);
      const frameSize = 2 + 1 + 1 + 1 + 2 + len + 2;
      if (this.buf.length < frameSize) break;

      const gotCrc = readLe16(this.buf, frameSize - 2);
      const calcCrc = crc16CcittFalse(this.buf.subarray(0, frameSize - 2));
      if (gotCrc !== calcCrc) {
        this.buf = this.buf.subarray(1);
        continue;
      }

      const payloadOff = 2 + 1 + 1 + 1 + 2;
      const payload = this.buf.subarray(payloadOff, payloadOff + len);
      out.push({ type, session, seq, payload });
      this.buf = this.buf.subarray(frameSize);
    }
    return out;
  }
}

function concat(a, b) {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function findNextStart(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (i + 1 < buf.length && buf[i] === MAGIC0 && buf[i + 1] === MAGIC1) return i;
  }
  return -1;
}

