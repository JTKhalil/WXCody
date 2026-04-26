import { ble } from "../../services/ble";
import { Frame, FrameType } from "../../services/proto_bin";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(" ");
}

Page({
  data: {
    adapterReady: false,
    scanning: false,
    connected: false,
    deviceId: "",
    status: "-",
    log: "",
  },

  _uiT: 0 as any,
  _uiDirty: false,

  onLoad() {
    ble.onFrame((f: Frame) => {
      const pl = f.payload ? new Uint8Array(f.payload) : new Uint8Array(0);
      ble.log(`[notify] type=0x${f.type.toString(16)} session=${f.session} seq=${f.seq} len=${pl.length} payload=${hex(pl)}`);
      if (f.type === FrameType.Ack && pl.length >= 2) {
        ble.log(`[ack] origType=0x${pl[0].toString(16)} errCode=${pl[1]}`);
      }
      this.scheduleUiRefresh();
    });

    ble.onConnectionStateChange((connected) => {
      this.syncState();
      this.setData({ status: connected ? "已连接" : "已断开" });
      this.scheduleUiRefresh();
    });
  },

  async onOpenAdapter() {
    try {
      await ble.openAdapter();
      this.syncState();
      this.setData({ status: "蓝牙已打开" });
      ble.log("openBluetoothAdapter OK");
    } catch (e: any) {
      this.setData({ status: "打开蓝牙失败" });
      ble.log("openBluetoothAdapter FAIL: " + (e?.message || String(e)));
    }
    this.scheduleUiRefresh();
  },

  async onScanConnect() {
    try {
      this.setData({ status: "扫描中..." });
      ble.log("scanning...");
      await ble.scanAndConnectFirstCody();
      this.syncState();
      this.setData({ status: "连接成功" });
      ble.log("connected + notify enabled OK");
    } catch (e: any) {
      this.syncState();
      this.setData({ status: "连接失败" });
      ble.log("scan/connect FAIL: " + (e?.message || String(e)));
    }
    this.scheduleUiRefresh();
  },

  async onSendPing() {
    try {
      this.setData({ status: "发送 PING..." });
      ble.log("send PING...");
      await ble.sendPingStopAndWait({ timeoutMs: 800, retries: 3 });
      this.setData({ status: "PING OK" });
      ble.log("PING OK (ACK received)");
    } catch (e: any) {
      this.setData({ status: "PING FAIL" });
      ble.log("PING FAIL: " + (e?.message || String(e)));
    }
    this.scheduleUiRefresh();
  },

  async onReconnect() {
    try {
      this.setData({ status: "重连中..." });
      await ble.reconnect();
      this.syncState();
      this.setData({ status: "重连成功" });
      ble.log("reconnect OK");
    } catch (e: any) {
      this.syncState();
      this.setData({ status: "重连失败" });
      ble.log("reconnect FAIL: " + (e?.message || String(e)));
    }
    this.scheduleUiRefresh();
  },

  async onCopyLogs() {
    try {
      await ble.copyLogs({ maxChars: 20000 });
      this.setData({ status: "日志已复制" });
    } catch (e: any) {
      this.setData({ status: "复制失败" });
      ble.log("copyLogs FAIL: " + (e?.message || String(e)));
    }
    this.scheduleUiRefresh();
  },

  async onClearLogs() {
    ble.clearLogs();
    this.scheduleUiRefresh(true);
  },

  syncState() {
    this.setData({
      adapterReady: ble.state.adapterReady,
      scanning: ble.state.scanning,
      connected: ble.state.connected,
      deviceId: ble.state.deviceId || "",
    });
  },

  scheduleUiRefresh(force = false) {
    this._uiDirty = true;
    if (this._uiT && !force) return;
    if (this._uiT) clearTimeout(this._uiT);
    this._uiT = setTimeout(() => {
      this._uiT = 0;
      if (!this._uiDirty && !force) return;
      this._uiDirty = false;
      this.setData({ log: ble.getLogsText({ maxChars: 4000 }) });
    }, 80);
  },
});

