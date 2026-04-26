import { ble } from "../../services/ble";

const STORAGE_BRIGHTNESS_KEY = "wxcody_backlight_brightness";

function clamp255(v) {
  if (v === null || v === undefined) return 255;
  if (typeof v === "string" && v.trim() === "") return 255;
  const n = Number(v);
  if (!Number.isFinite(n)) return 255;
  return Math.max(0, Math.min(255, Math.floor(n)));
}

Page({
  data: {
    canScroll: false,
    connected: false,
    brightness: 255,
  },

  _t: 0,

  onLoad() {
    this._syncState();
    this._restoreBrightness();
    ble.onConnectionStateChange(() => {
      this._syncState();
    });
  },

  onShow() {
    this._syncState();
    this._restoreBrightness();
  },

  _syncState() {
    this.setData({ connected: !!ble.state.connected });
  },

  _restoreBrightness() {
    try {
      const v = clamp255(wx.getStorageSync(STORAGE_BRIGHTNESS_KEY));
      if (v !== Number(this.data.brightness)) this.setData({ brightness: v });
    } catch (_) {}
  },

  _persistBrightness(v) {
    try {
      wx.setStorageSync(STORAGE_BRIGHTNESS_KEY, clamp255(v));
    } catch (_) {}
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
    this._persistBrightness(v);
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

