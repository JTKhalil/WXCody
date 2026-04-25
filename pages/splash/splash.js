import { ble } from "../../services/ble";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("timeout"));
    }, ms);
    promise.then((v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(e);
    });
  });
}

Page({
  data: {
    statusText: "",
    /** 内容未超屏时禁用滚动（闪屏页始终不滚动） */
    canScroll: false,
  },

  _done: false,
  _timer: 0,

  onLoad() {
    // 最长 3s：到点还没进控制台则去连接页
    this._timer = setTimeout(() => {
      if (this._done) return;
      this._goConnect();
    }, 3000);

    this._boot().catch(() => {
      // 失败就走连接页（但仍遵守 3s 上限）
    });
  },

  onUnload() {
    try { if (this._timer) clearTimeout(this._timer); } catch (_) {}
    this._timer = 0;
  },

  _goConsole() {
    if (this._done) return;
    this._done = true;
    try { if (this._timer) clearTimeout(this._timer); } catch (_) {}
    this._timer = 0;
    try { wx.redirectTo({ url: "/pages/console/console" }); } catch (_) {}
  },

  _goConnect() {
    if (this._done) return;
    this._done = true;
    try { if (this._timer) clearTimeout(this._timer); } catch (_) {}
    this._timer = 0;
    try { wx.redirectTo({ url: "/pages/connect/connect" }); } catch (_) {}
  },

  async _boot() {
    // 已经连接（例如热启动返回）直接进控制台
    if (ble && ble.state && ble.state.connected) {
      this._goConsole();
      return;
    }

    let lastId = "";
    try { lastId = String(wx.getStorageSync("wxcody_last_device") || ""); } catch (_) {}
    if (!lastId) {
      // 没有历史设备：稍等一会给视觉闪屏感，然后去连接页
      await sleep(450);
      if (!this._done) this._goConnect();
      return;
    }

    this.setData({ statusText: "正在连接..." });

    // 给自动回连留出时间（但整体仍由 3s timer 兜底）
    try {
      await withTimeout(ble.openAdapter(), 700);
      await withTimeout(ble.connect(lastId), 1200);
      await withTimeout(ble.discoverAndSubscribe(), 1200);
      // 已信任设备：pair_status 应返回 pending=false
      const r = await withTimeout(
        ble.sendJsonStopAndWait({ cmd: "pair_status" }, { timeoutMs: 450, retries: 2 }),
        1200
      );
      if (r && r.status === "ok" && r.pending === false) {
        this._goConsole();
        return;
      }
    } catch (_) {}

    // 3s 内未完成自动进入：去连接页由用户手动选择
    if (!this._done) this._goConnect();
  },
});

