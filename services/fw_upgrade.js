import { ble } from "./ble";
import { FrameType } from "./proto_bin";

const UPDATE_FIRMWARE_URL = "https://raw.githubusercontent.com/JTKhalil/claudeRobot/main/firmware.bin";
const STORAGE_KEY = "wxcody_fw_upgrade_state";

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

function now() {
  return Date.now();
}

function loadPersisted() {
  try {
    const s = wx.getStorageSync(STORAGE_KEY);
    if (!s) return null;
    if (typeof s === "string") return JSON.parse(s);
    return s;
  } catch (_) {
    return null;
  }
}

function persist(state) {
  try {
    wx.setStorageSync(STORAGE_KEY, state);
  } catch (_) {}
}

function clone(x) {
  return JSON.parse(JSON.stringify(x || {}));
}

const defaultState = {
  running: false,
  percent: 0,
  status: "",
  startedAt: 0,
  finishedAt: 0,
  error: "",
};

let _state = { ...defaultState, ...(loadPersisted() || {}) };
let _listeners = [];
let _jobP = null;

// 小程序重启后：若上一次升级未完成，不继续跑，清理状态让用户重新点击升级
try {
  if (_state && _state.running) {
    _state = { ...defaultState, status: "上次升级未完成，请重新点击升级" };
    persist(_state);
  }
} catch (_) {}

function emit() {
  const s = getState();
  for (const cb of _listeners) {
    try { cb(s); } catch (_) {}
  }
}

function setState(partial) {
  _state = { ..._state, ...(partial || {}) };
  persist(_state);
  emit();
}

export function getState() {
  return clone(_state);
}

export function onStateChange(cb) {
  _listeners.push(cb);
  try { cb(getState()); } catch (_) {}
  return () => {
    _listeners = _listeners.filter((x) => x !== cb);
  };
}

async function downloadFirmwareBytes() {
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
      success: (r) => resolve(r.data),
      fail: (e) => reject(new Error((e && e.errMsg) || "readFile failed")),
    });
  });
  const fw = new Uint8Array(ab);
  if (!fw.length) throw new Error("firmware empty");
  return fw;
}

async function readFirmwareFromLocalPath(filePath) {
  const fs = wx.getFileSystemManager();
  const ab = await new Promise((resolve, reject) => {
    fs.readFile({
      filePath,
      success: (r) => resolve(r.data),
      fail: (e) => reject(new Error((e && e.errMsg) || "readFile failed")),
    });
  });
  const fw = new Uint8Array(ab);
  if (!fw.length) throw new Error("firmware empty");
  return fw;
}

async function pushOtaFirmwareBytes(fw) {
  const total = (fw.length >>> 0);
  const chunkBytes = 166;
  setState({ status: "发送 OTA_BEGIN..." });
  const beginRes = await ble.sendFrameStopAndWaitDetailed(FrameType.OtaBegin, le32(total), { timeoutMs: 1200, retries: 3 });
  if (beginRes.errCode !== 0) throw new Error("OTA_BEGIN errCode=" + beginRes.errCode);

  let off = 0;
  const pend = [];
  while (off < total) {
    const n = Math.min(chunkBytes, total - off);
    const pl = concat(le32(off), fw.subarray(off, off + n));
    const x = await ble.sendFrameNoWaitDetailed(FrameType.OtaChunk, pl, { timeoutMs: 1500 });
    pend.push(x.ackP);
    off += n;

    if (pend.length >= 6) {
      const p = pend.shift();
      try { await p; } catch (_) {}
    }

    const pct = Math.floor((off * 100) / total);
    if (pct !== _state.percent) setState({ percent: pct });
  }
  while (pend.length) {
    const p = pend.shift();
    try { await p; } catch (_) {}
  }

  setState({ status: "发送 OTA_FINISH..." });
  const finRes = await ble.sendFrameStopAndWaitDetailed(FrameType.OtaFinish, le32(total), { timeoutMs: 1500, retries: 3 });
  if (finRes.errCode !== 0) throw new Error("OTA_FINISH errCode=" + finRes.errCode);

  setState({ status: "完成：等待设备重启（会断开连接）", percent: 100, running: false, finishedAt: now() });
}

async function runUpgrade() {
  if (!ble.state.connected) throw new Error("not connected");

  setState({ running: true, percent: 0, status: "下载固件中...", startedAt: now(), finishedAt: 0, error: "" });
  const fw = await downloadFirmwareBytes();
  await pushOtaFirmwareBytes(fw);
}

async function runUpgradeFromLocalPath(filePath) {
  if (!ble.state.connected) throw new Error("not connected");
  setState({ running: true, percent: 0, status: "读取本地固件...", startedAt: now(), finishedAt: 0, error: "" });
  const fw = await readFirmwareFromLocalPath(filePath);
  await pushOtaFirmwareBytes(fw);
}

function wrapUpgradeJob(run) {
  if (_jobP) return _jobP;
  _jobP = (async () => {
    try {
      await run();
    } catch (e) {
      setState({
        running: false,
        error: (e && e.message) ? String(e.message) : String(e),
        status: "升级失败：" + ((e && e.message) || String(e)),
        finishedAt: now(),
      });
      throw e;
    } finally {
      _jobP = null;
    }
  })();
  return _jobP;
}

export async function startUpgrade() {
  return wrapUpgradeJob(() => runUpgrade());
}

/** 从本地临时路径读取固件并 OTA（与 startUpgrade 互斥，共用进度状态） */
export async function startUpgradeFromLocalFile(filePath) {
  const p = String(filePath || "").trim();
  if (!p) return Promise.reject(new Error("no file path"));
  return wrapUpgradeJob(() => runUpgradeFromLocalPath(p));
}

