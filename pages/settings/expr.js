import { ble } from "../../services/ble";

const STORAGE_EXPR_GROUP = "wxcody_expr_group";

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v === 1 ? 1 : 0;
}

Page({
  data: {
    exprGroup: 0,
  },

  onLoad() {
    ble.onConnectionStateChange(() => {
      if (ble.state.connected) this._pullFromDevice();
    });
  },

  onShow() {
    this._restoreLocal();
    if (ble.state.connected) this._pullFromDevice();
  },

  _restoreLocal() {
    try {
      const v = clamp01(wx.getStorageSync(STORAGE_EXPR_GROUP));
      if (v !== Number(this.data.exprGroup)) this.setData({ exprGroup: v });
    } catch (_) {}
  },

  _persistLocal(v) {
    try {
      wx.setStorageSync(STORAGE_EXPR_GROUP, clamp01(v));
    } catch (_) {}
  },

  async _pullFromDevice() {
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "get_mode" }, { timeoutMs: 900, retries: 2 });
      const g = clamp01(r && r.expr_group);
      this.setData({ exprGroup: g });
      this._persistLocal(g);
    } catch (_) {
      /* 离线沿用本地缓存 */
    }
  },

  async onExprGroupChange(evt) {
    const v = clamp01(evt && evt.detail && evt.detail.value);
    this.setData({ exprGroup: v });
    this._persistLocal(v);
    if (!ble.state.connected) {
      wx.showToast({ title: "请先连接设备", icon: "none" });
      return;
    }
    try {
      await ble.sendJsonStopAndWait({ cmd: "set_expr_group", expr_group: v }, { timeoutMs: 1000, retries: 2 });
    } catch (e) {
      wx.showToast({ title: "同步失败", icon: "none" });
    }
  },
});
