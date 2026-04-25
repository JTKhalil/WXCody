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
    // 从控制台断开返回时，主动扫描附近 Cody
    // - query 参数优先（用于 redirectTo 的显式触发）
    // - 以及首次进入时的默认自动扫描（之前已在 onLoad 调用 onScanList）
    try {
      const pages = getCurrentPages();
      const cur = pages && pages.length ? pages[pages.length - 1] : null;
      const opts = (cur && cur.options) || {};
      if (opts && String(opts.scan || "") === "1") {
        // 清掉标记，避免 onShow 重复触发（对 options 不可写就忽略）
        try { cur.options.scan = ""; } catch (_) {}
        this.onScanList().catch(() => {});
      }
    } catch (_) {}
    setTimeout(() => this._updateCanScroll(), 80);
  },

  async _sendPairHello() {
    const name = String(this.data.deviceName || "").trim();
    if (!name) return;
    try {
      const id = String(this.data.clientId || "").trim();
      // 加快名称同步：pair_hello 不依赖 notify 回包（有些机型刚订阅时回包会延迟）
      // 这里改成“发两次”提高到达率，避免 Cody 端一直拿不到设备名称而不显示连接页。
      await ble.sendJson({ cmd: "pair_hello", name, id });
      await new Promise((r) => setTimeout(r, 60));
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
    try {
      while (this.data.waitingConfirm) {
        if (!ble.state.connected) throw new Error("设备已断开");
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
      let pending = true;
      try {
        const r = await ble.sendJsonStopAndWait({ cmd: "pair_status" }, { timeoutMs: 900, retries: 1 });
        if (r && r.status === "ok" && r.pending === false) pending = false;
      } catch (_) {}

      if (!pending) {
        this._goConsoleOnce();
        return;
      }

      // 未信任/需确认：再弹窗等待设备端确认
      this.setData({ waitingConfirm: true, waitingText: "请等待设备确认" });
      await this._waitDeviceConfirm();
      this._goConsoleOnce();
    } catch (_) {
      // 自动连接失败：静默留在连接页
      try { await wx.closeBluetoothAdapter(); } catch (_) {}
    }
  },

  async onScanList() {
    try {
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
    try {
      // 先立刻弹出弹窗（覆盖 connect/discover 的间隙）
      this.setData({ waitingConfirm: true, waitingText: "连接中..." });
      try {
        await ble.openAdapter();
      } catch (_) {
        this.setData({ waitingConfirm: false, waitingText: "请等待设备确认" });
        try { wx.showToast({ title: "请先打开手机蓝牙", icon: "none", duration: 1800 }); } catch (_) {}
        return;
      }
      await ble.connect(id);
      await ble.discoverAndSubscribe();
      await this._sendPairHello();
      this.setData({ waitingText: "请等待设备确认" });
      await this._waitDeviceConfirm();
      this._saveKnownDevice(id, name);
      this._goConsoleOnce();
    } catch (err) {
      ble.log("connect FAIL: " + ((err && err.message) || String(err)));
      try {
        const msg = String((err && err.message) || "");
        if (msg.includes("not available") || msg.includes("bluetooth") || msg.includes("adapter")) {
          wx.showToast({ title: "请先打开手机蓝牙", icon: "none", duration: 1800 });
        }
      } catch (_) {}
      this.setData({ waitingConfirm: false, waitingText: "请等待设备确认" });
    }
  },

});
