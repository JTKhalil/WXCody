import { ble } from "../../services/ble";
import { FrameType } from "../../services/proto_bin";

function hex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

Page({
  data: {
    deviceId: "",
    clientId: "",
    deviceName: "",
    devices: [],
    waitingConfirm: false,
    waitingText: "请等待设备确认",
    scanningUi: false,
    /** 内容未超屏时禁用滚动 */
    canScroll: false,
  },

  _tapToken: 0,
  _connecting: false,

  _isLocallyTrusted(deviceId) {
    const id = String(deviceId || "").trim();
    if (!id) return false;
    try {
      const lastId = String(wx.getStorageSync("wxcody_last_device") || "").trim();
      if (lastId && lastId === id) return true;
    } catch (_) {}
    try {
      const list = wx.getStorageSync("wxcody_known_devices");
      const arr = Array.isArray(list) ? list : [];
      return arr.some((x) => x && String(x.deviceId || "").trim() === id);
    } catch (_) {}
    return false;
  },

  _showSysLoading(title) {
    try {
      wx.showLoading({ title: String(title || "连接中..."), mask: true });
      return true;
    } catch (_) {}
    return false;
  },

  _hideSysLoading() {
    try { wx.hideLoading(); } catch (_) {}
  },

  _lastTrustedRejectAt: 0,

  async _checkTrustedQuickly() {
    // 设备刚重启时，pair_status 可能短时间内仍显示 pending=true；
    // 这里做一个短轮询窗口，尽量自动进入控制台（已信任设备应无需用户确认）。
    const startTs = Date.now();
    while (Date.now() - startTs < 3200) {
      if (!ble.state.connected) throw new Error("设备已断开");
      try {
        const r = await ble.sendJsonStopAndWait({ cmd: "pair_status" }, { timeoutMs: 900, retries: 1 });
        if (r && r.status === "ok" && r.pending === false) return true;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 450));
    }
    return false;
  },

  _clearAllCachesKeepIdentity() {
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
  },

  _uiT: 0,
  _uiDirty: false,
  _navigated: false,
  _unsubs: null,
  _btPrevAvail: null,
  _btHandling: false,
  _btStateCb: null,

  _scheduleInitialAutoScanIfNeeded() {
    try {
      const app = getApp();
      const gd = app && app.globalData;
      if (!gd || gd.connectInitialAutoScanDone) return;
      gd.connectInitialAutoScanDone = true;
      setTimeout(() => {
        if (this._navigated || ble.state.connected) return;
        this.onScanList().catch(() => {});
      }, 320);
    } catch (_) {}
  },

  onLoad() {
    const unsubs = [];

    unsubs.push(ble.onFrame((f) => {
      const pl = f.payload ? new Uint8Array(f.payload) : new Uint8Array(0);
      ble.log(
        `[notify] type=0x${f.type.toString(16)} session=${f.session} seq=${f.seq} len=${pl.length} payload=${hex(pl)}`
      );
      if (f.type === FrameType.Ack && pl.length >= 2) {
        ble.log(`[ack] origType=0x${pl[0].toString(16)} errCode=${pl[1]}`);
      }
    }));

    unsubs.push(ble.onConnectionStateChange((connected) => {
      // 连接状态变化无需在连接页展示状态卡片；只做必要的 UI/流程控制
      if (!connected) {
        // 若在等待确认时断开，通常意味着设备端拒绝
        if (this.data.waitingConfirm) {
          try {
            wx.showToast({ title: "连接被拒绝", icon: "none", duration: 1500 });
          } catch (_) {}
        }
        this.setData({ waitingConfirm: false });
      }
      this.setData({ deviceId: ble.state.deviceId || "" });
    }));

    this._unsubs = unsubs;

    // 监听系统蓝牙开关变化：必须先 openBluetoothAdapter 才能稳定收到 stateChange
    this._setupBluetoothStateWatcher();

    this._tryAutoConnectLast().catch(() => {});
    this.setData({ deviceId: ble.state.deviceId || "" });

    // clientId：用于 Cody 端确认页显示“是哪台手机在请求连接”
    let cid = "";
    try { cid = String(wx.getStorageSync("wxcody_client_id") || ""); } catch (_) {}
    const macLikeRe = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
    if (!cid || !macLikeRe.test(cid)) {
      const hex2 = () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0").toUpperCase();
      cid = `${hex2()}:${hex2()}:${hex2()}:${hex2()}:${hex2()}:${hex2()}`;
      try { wx.setStorageSync("wxcody_client_id", cid); } catch (_) {}
    }
    this.setData({ clientId: cid });

    // 设备名称：用于 Cody 端确认页显示“请求连接的设备名称”
    let dn = "";
    try { dn = String(wx.getStorageSync("wxcody_device_name") || ""); } catch (_) {}
    if (!dn) {
      // 生成一个随机可爱的英文名（持久化），避免 brand+model 太长
      const adj = ["Sunny","Misty","Lucky","Bouncy","Cozy","Jolly","Puffy","Clever","Sparkly","Happy","Nimble","Silly","Brave","Sleepy","Peachy","Chirpy","Witty","Fluffy"];
      const animal = ["Panda","Kitten","Bunny","Fox","Otter","Koala","Puppy","Duck","Penguin","Bear","Hamster","Dolphin","Tiger","Seal","Hedgehog","Shiba"];
      const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
      const n = Math.floor(Math.random() * 90) + 10;
      dn = `${pick(adj)}${pick(animal)}${n}`;
      try { wx.setStorageSync("wxcody_device_name", dn); } catch (_) {}
    }
    this.setData({ deviceName: dn });
    this._scheduleInitialAutoScanIfNeeded();
    setTimeout(() => this._updateCanScroll(), 80);
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

  _setupBluetoothStateWatcher() {
    if (this._btStateCb) return;
    try {
      // 尝试初始化适配器（蓝牙关闭时会失败，但后续开启会触发 stateChange）
      try { wx.openBluetoothAdapter({ success: () => {}, fail: () => {} }); } catch (_) {}

      // 读取一次初始状态，设置 prev
      try {
        wx.getBluetoothAdapterState({
          success: (st) => {
            this._btPrevAvail = !!(st && st.available);
          },
          fail: () => {
            // 保持 null，等待首次 stateChange
          },
        });
      } catch (_) {}

      const cb = (st) => {
        const avail = !!(st && st.available);
        if (this._btPrevAvail === false && avail === true) {
          this._onBluetoothTurnedOn();
        }
        this._btPrevAvail = avail;
      };
      this._btStateCb = cb;
      wx.onBluetoothAdapterStateChange(cb);
    } catch (_) {}
  },

  async _onBluetoothTurnedOn() {
    if (this._btHandling) return;
    this._btHandling = true;
    try {
      // 给系统一点时间稳定（部分机型刚打开蓝牙立刻 scan 会失败）
      await new Promise((r) => setTimeout(r, 180));

      // 优先尝试直连上次设备（已信任会直接进控制台）
      await this._tryAutoConnectLast().catch(() => {});
      if (this._navigated) return;

      // 直连未成功：刷新扫描列表
      await this.onScanList().catch(() => {});
    } finally {
      this._btHandling = false;
    }
  },

  onShow() {
    // 自动扫描仅在「本会话首次进入连接页」由 onLoad 调度一次；断连/拒绝后回此页不再自动扫，需用户点「扫描附近的 Cody」
    setTimeout(() => this._updateCanScroll(), 80);
  },

  async _sendPairHello() {
    const name = String(this.data.deviceName || "").trim();
    if (!name) return;
    try {
      const id = String(this.data.clientId || "").trim();
      // 避免过密发送命令导致设备端配对页卡死：只发一次，后续依赖 pair_status 轮询
      await ble.sendJson({ cmd: "pair_hello", name, id });
    } catch (_) {}
  },

  onUnload() {
    const unsubs = this._unsubs || [];
    for (const u of unsubs) {
      try { u(); } catch (_) {}
    }
    this._unsubs = null;

    try {
      if (this._btStateCb) {
        // 新版基础库支持 off；不支持则忽略
        try { wx.offBluetoothAdapterStateChange(this._btStateCb); } catch (_) {}
      }
    } catch (_) {}
    this._btStateCb = null;
  },

  _goConsoleOnce() {
    if (this._navigated) return;
    this._navigated = true;
    // 用 redirectTo 避免 connect 页堆栈与二次进入
    wx.redirectTo({ url: "/pages/console/console" });
  },

  async _waitDeviceConfirm() {
    this.setData({ waitingConfirm: true });
    const startTs = Date.now();
    try {
      while (this.data.waitingConfirm) {
        if (!ble.state.connected) throw new Error("设备已断开");
        if (Date.now() - startTs > 20000) throw new Error("等待设备确认超时");
        try {
          const r = await ble.sendJsonStopAndWait({ cmd: "pair_status" }, { timeoutMs: 900, retries: 1 });
          if (r && r.status === "ok" && r.pending === false) {
            try {
              wx.showToast({ title: "配对成功", icon: "success", duration: 1200 });
            } catch (_) {}
            return true;
          }
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 600));
      }
      throw new Error("用户取消");
    } finally {
      this.setData({ waitingConfirm: false });
    }
  },

  async onCloseWaiting() {
    // 用户主动关闭：断开连接并关闭弹窗
    this.setData({ waitingConfirm: false });
    try { await ble.disconnect(); } catch (_) {}
  },

  _saveKnownDevice(deviceId, name) {
    if (!deviceId) return;
    try {
      // 只保留“最近一次信任的设备”
      let lastId = "";
      try { lastId = String(wx.getStorageSync("wxcody_last_device") || ""); } catch (_) {}
      if (lastId && lastId !== deviceId) {
        // 新设备覆盖旧设备：清空旧设备的所有缓存（图片/笔记等）
        this._clearAllCachesKeepIdentity();
      }

      const now = Date.now();
      const nm = String(name || "").trim();
      const entry = { deviceId, name: nm, lastAt: now };
      const out = [entry];
      wx.setStorageSync("wxcody_known_devices", out);
      wx.setStorageSync("wxcody_last_device", deviceId);
      wx.setStorageSync("wxcody_last_cody_name", nm);
    } catch (_) {}
  },

  async _tryAutoConnectLast() {
    let lastId = "";
    try { lastId = String(wx.getStorageSync("wxcody_last_device") || ""); } catch (_) {}
    if (!lastId) return;
    try {
      await ble.openAdapter();
      await ble.connect(lastId);
      await ble.discoverAndSubscribe();
      await this._sendPairHello();
      // 启动自动回连：已信任设备应当直接进入控制台，不弹“等待确认”窗口
      const trusted = await this._checkTrustedQuickly();
      if (trusted) {
        this._goConsoleOnce();
        return;
      }

      // 自动回连场景：不再自动弹“等待确认”弹窗（避免重启后回到连接页时无意义弹窗）
      // 未信任设备需要确认时，交给用户手动点击设备名称触发连接流程与弹窗。
    } catch (_) {
      // 自动连接失败：断开并静默留在连接页（走 ble.closeAdapter 保持与 openAdapter 状态一致，避免重复注册监听）
      try { await ble.disconnect(); } catch (_) {}
      try { await ble.closeAdapter(); } catch (_) {}
    }
  },

  async onScanList() {
    try {
      // 若其实还处于连接状态（部分机型会导致扫描不再上报），直接尝试进入控制台
      if (ble.state.connected) {
        // 已信任设备：直接进入控制台
        try {
          const r = await ble.sendJsonStopAndWait({ cmd: "pair_status" }, { timeoutMs: 900, retries: 1 });
          if (r && r.status === "ok" && r.pending === false) {
            this._goConsoleOnce();
            return;
          }
        } catch (_) {}
        // 非信任/异常：先断开再扫描
        try { await ble.disconnect(); } catch (_) {}
      }

      try {
        await ble.openAdapter();
      } catch (e) {
        try { wx.showToast({ title: "请先打开手机蓝牙", icon: "none", duration: 1800 }); } catch (_) {}
        return;
      }
      this.setData({ devices: [], scanningUi: true });
      let list = await ble.scanCodyDevices(5500);

      // 刷新固件/重启设备后，部分机型会出现“扫描回调不再上报”的缓存问题；
      // 这里对空结果做一次软重置（close/open adapter）后重试，避免必须重启小程序。
      if ((!list || !list.length)) {
        try {
          await ble.closeAdapter();
          await new Promise((r) => setTimeout(r, 120));
          await ble.openAdapter();
          list = await ble.scanCodyDevices(5500);
        } catch (_) {}
      }

      this.setData({ devices: list || [] });
    } catch (e) {
      ble.log("scan list FAIL: " + ((e && e.message) || String(e)));
      // 兜底：部分机型/版本关闭蓝牙后可能在 scan 阶段报错
      try {
        const msg = String((e && e.message) || "");
        if (msg.includes("not available") || msg.includes("bluetooth") || msg.includes("adapter")) {
          wx.showToast({ title: "请先打开手机蓝牙", icon: "none", duration: 1800 });
        }
      } catch (_) {}
    } finally {
      this.setData({ scanningUi: false });
      setTimeout(() => this._updateCanScroll(), 80);
    }
  },

  async onTapDevice(e) {
    const id = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || "";
    const name = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.name) || "";
    if (!id) return;
    // 任意点击都先关闭弹窗，避免上一次流程残留
    if (this.data.waitingConfirm) this.setData({ waitingConfirm: false });
    // 防止快速连点导致并发流程互相 setData/弹窗
    if (this._connecting) return;
    this._connecting = true;
    const token = (++this._tapToken);
    const locallyTrusted = this._isLocallyTrusted(id);
    const usedSysLoading = locallyTrusted ? this._showSysLoading("连接中...") : false;
    try {
      // 已信任设备：若刚刚被拒绝过（通常是设备端重启/忙），立即重复点击不要进入任何确认弹窗流程
      // 直接当作“仍被拒绝/未就绪”处理，避免出现“请等待设备确认”的误弹窗。
      if (locallyTrusted && this._lastTrustedRejectAt && (Date.now() - this._lastTrustedRejectAt) < 2500) {
        if (usedSysLoading) this._hideSysLoading();
        try { wx.showToast({ title: "连接被拒绝", icon: "none", duration: 1800 }); } catch (_) {}
        return;
      }
      // 若上一轮流程遗留了弹窗状态（例如未信任流程中途返回），这里先强制关闭，避免已信任设备误弹窗
      if (locallyTrusted && this.data.waitingConfirm) {
        this.setData({ waitingConfirm: false });
      }
      // 未信任设备才弹确认弹窗；已连接过的设备直接连接
      if (!locallyTrusted) {
        if (token === this._tapToken) this.setData({ waitingConfirm: true, waitingText: "连接中..." });
      }
      try {
        await ble.openAdapter();
      } catch (_) {
        if (!locallyTrusted && token === this._tapToken) this.setData({ waitingConfirm: false, waitingText: "请等待设备确认" });
        try { wx.showToast({ title: "请先打开手机蓝牙", icon: "none", duration: 1800 }); } catch (_) {}
        return;
      }
      if (!locallyTrusted && token === this._tapToken) this.setData({ waitingText: "正在建立连接..." });
      await ble.connect(id);
      // 服务同步对用户无意义：统一提示设备端操作，避免“卡在同步服务”的误解
      if (!locallyTrusted && token === this._tapToken) this.setData({ waitingText: "请在 Cody 上确认连接" });
      await ble.discoverAndSubscribe();
      await this._sendPairHello();
      // 已信任设备：短时间内自动确认并直接进入控制台
      if (!locallyTrusted && token === this._tapToken) this.setData({ waitingText: "正在确认信任状态..." });
      const trusted = await this._checkTrustedQuickly();
      if (trusted) {
        this._saveKnownDevice(id, name);
        if (!locallyTrusted && token === this._tapToken) this.setData({ waitingConfirm: false });
        if (usedSysLoading) this._hideSysLoading();
        this._goConsoleOnce();
        return;
      }

      if (locallyTrusted) {
        // 已信任设备不应该进入“等待确认”流程；若未能在短窗口确认，视为被拒绝/未就绪
        throw new Error("连接被拒绝");
      }

      // 未信任设备：才进入等待确认
      if (token === this._tapToken) this.setData({ waitingText: "请等待设备确认" });
      await this._waitDeviceConfirm();
      this._saveKnownDevice(id, name);
      if (token === this._tapToken) this.setData({ waitingConfirm: false });
      if (usedSysLoading) this._hideSysLoading();
      this._goConsoleOnce();
    } catch (err) {
      ble.log("connect FAIL: " + ((err && err.message) || String(err)));
      try { await ble.disconnect(); } catch (_) {}
      if (usedSysLoading) this._hideSysLoading();
      try {
        const msg = String((err && err.message) || "");
        if (msg.includes("超时") || msg.toLowerCase().includes("timeout")) {
          wx.showToast({ title: "连接超时，请重试", icon: "none", duration: 1800 });
        }
        if (msg.includes("设备已断开") || msg.includes("连接被拒绝")) {
          wx.showToast({ title: "连接被拒绝", icon: "none", duration: 1800 });
        }
        if (msg.includes("not available") || msg.includes("bluetooth") || msg.includes("adapter")) {
          wx.showToast({ title: "请先打开手机蓝牙", icon: "none", duration: 1800 });
        }
      } catch (_) {}
      // 记录“已信任设备被拒绝”的时间窗，用于抑制立即重复点击带来的异常弹窗状态
      if (locallyTrusted) this._lastTrustedRejectAt = Date.now();
      // 无论如何，已信任设备不应该留下 waitingConfirm=true
      if (locallyTrusted && this.data.waitingConfirm) this.setData({ waitingConfirm: false });
      if (!locallyTrusted && token === this._tapToken) this.setData({ waitingConfirm: false, waitingText: "请等待设备确认" });
    } finally {
      if (token === this._tapToken) this._connecting = false;
    }
  },

});
