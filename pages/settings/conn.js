import { ble } from "../../services/ble";

function clearAllCachesKeepIdentity() {
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
}

Page({
  data: {
    canScroll: false,
    connected: false,
    codyName: "",
    miniProgramName: "",
    deviceName: "",
  },

  onLoad() {
    this._loadCodyName();
    this._loadIdentity();
    this._syncState();
    ble.onConnectionStateChange(() => {
      this._syncState();
    });
  },

  onShow() {
    this._loadCodyName();
    this._loadIdentity();
    this._syncState();
  },

  _syncState() {
    this.setData({
      connected: !!ble.state.connected,
    });
  },

  _loadCodyName() {
    let nm = "";
    try { nm = String(wx.getStorageSync("wxcody_last_cody_name") || ""); } catch (_) {}
    nm = String(nm || "").trim();
    if (nm) this.setData({ codyName: nm });
  },

  _loadIdentity() {
    let cid = "";
    let dn = "";
    try { cid = String(wx.getStorageSync("wxcody_client_id") || ""); } catch (_) {}
    try { dn = String(wx.getStorageSync("wxcody_device_name") || ""); } catch (_) {}
    cid = String(cid || "").trim();
    dn = String(dn || "").trim();
    this.setData({
      miniProgramName: cid,
      deviceName: dn,
    });
  },

  async onDisconnectBle() {
    try {
      await new Promise((resolve, reject) => {
        wx.showModal({
          title: "断开连接",
          content: "确定要断开蓝牙连接吗？将清空本地缓存（图片/笔记等）。",
          confirmText: "断开",
          cancelText: "取消",
          success: (res) => {
            if (res && res.confirm) resolve();
            else reject(new Error("cancel"));
          },
          fail: () => reject(new Error("modal fail")),
        });
      });
    } catch (_) {
      return;
    }

    try {
      try {
        if (ble.state.connected) {
          await ble.sendJsonStopAndWait({ cmd: "ble_forget" }, { timeoutMs: 1200, retries: 1 });
        }
      } catch (_) {}
      clearAllCachesKeepIdentity();
      await ble.disconnect();
    } catch (_) {}

    try {
      wx.redirectTo({ url: "/pages/connect/connect" });
    } catch (_) {}
  },
});

