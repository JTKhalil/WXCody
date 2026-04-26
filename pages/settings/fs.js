import { ble } from "../../services/ble";

Page({
  data: {
    canScroll: false,
    connected: false,
    fsTotal: 0,
    fsUsed: 0,
    fsFree: 0,
    fsPercent: 0,
  },

  onLoad() {
    this._syncState();
    ble.onConnectionStateChange(() => {
      this._syncState();
      if (ble.state.connected) this.onRefreshFs();
    });
  },

  onShow() {
    this._syncState();
    if (ble.state.connected) this.onRefreshFs();
  },

  _syncState() {
    this.setData({ connected: !!ble.state.connected });
  },

  async onRefreshFs() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "fs_space" }, { timeoutMs: 1200, retries: 3 });
      const total = Number(r && r.total) || 0;
      const used = Number(r && r.used) || 0;
      const free = Number(r && r.free) || 0;
      const percent = total > 0 ? Math.min(100, Math.max(0, Math.floor((used * 100) / total))) : 0;
      this.setData({ fsTotal: total, fsUsed: used, fsFree: free, fsPercent: percent });
    } catch (_) {}
  },

  async onConfirmDanger(evt) {
    const action = String((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.action) || "");
    if (!ble.state.connected) return;
    const msg =
      action === "format_fs"
        ? "确定要删除 Cody 上的所有数据吗？将清空图片与笔记。"
        : action === "reset_system"
          ? "确定要恢复出厂设置吗？设备会重启并断开连接。"
          : "确定要执行该操作吗？";
    try {
      await new Promise((resolve, reject) => {
        wx.showModal({
          title: "系统提示",
          content: msg,
          confirmText: "确定",
          cancelText: "取消",
          success: (res) => (res && res.confirm ? resolve() : reject(new Error("cancel"))),
          fail: () => reject(new Error("modal fail")),
        });
      });
    } catch (_) {
      return;
    }
    try {
      if (action === "format_fs") {
        await ble.sendJsonStopAndWait({ cmd: "format_fs" }, { timeoutMs: 2000, retries: 2 });
        wx.showToast({ title: "已格式化", icon: "success" });
      } else if (action === "reset_system") {
        await ble.sendJsonStopAndWait({ cmd: "reset_system" }, { timeoutMs: 2000, retries: 1 });
        wx.showToast({ title: "已发送指令", icon: "success" });
      }
    } catch (_) {
      wx.showToast({ title: "操作失败", icon: "none" });
    }
  },
});

