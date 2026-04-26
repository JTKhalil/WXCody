import { ble } from "../../services/ble";

Page({
  data: {
    canScroll: false,
    connected: false,
    brightness: 255,
  },

  _t: 0,

  onLoad() {
    this._syncState();
    ble.onConnectionStateChange(() => {
      this._syncState();
    });
  },

  onShow() {
    this._syncState();
  },

  _syncState() {
    this.setData({ connected: !!ble.state.connected });
  },

  onBrightnessChanging(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (!Number.isFinite(v)) return;
    this.setData({ brightness: v });
    this._sendBrightnessThrottled(v);
  },

  onBrightnessChange(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (!Number.isFinite(v)) return;
    this.setData({ brightness: v });
    this._sendBrightnessThrottled(v, true);
  },

  _sendBrightnessThrottled(v, force) {
    if (!ble.state.connected) return;
    if (this._t && !force) return;
    if (this._t) clearTimeout(this._t);
    this._t = setTimeout(async () => {
      this._t = 0;
      try {
        await ble.sendJsonStopAndWait({ cmd: "bright", v: Number(v) || 0 }, { timeoutMs: 800, retries: 2 });
      } catch (_) {}
    }, force ? 0 : 80);
  },
});

