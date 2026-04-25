import { ble } from "../../services/ble";

Page({
  data: {
    connected: false,
    codyName: "",
    showDebug: false,
    log: "",
  },

  onLoad() {
    this._syncConn();
    this._refreshLog();
  },

  onShow() {
    this._syncConn();
    this._refreshLog();
  },

  _syncConn() {
    this.setData({ connected: !!ble.state.connected, codyName: ble.state.deviceName || "" });
  },

  _refreshLog() {
    try {
      const s = ble.getLogsText ? ble.getLogsText({ maxChars: 8000 }) : "";
      this.setData({ log: String(s || "") });
    } catch (_) {}
  },

  async onCopyLogs() {
    try {
      await ble.copyLogs({ maxChars: 20000 });
      this._refreshLog();
    } catch (_) {}
  },

  onClearLogs() {
    try {
      ble.clearLogs();
    } catch (_) {}
    this._refreshLog();
  },

  onToggleDebug() {
    this.setData({ showDebug: !this.data.showDebug }, () => this._refreshLog());
  },
});

