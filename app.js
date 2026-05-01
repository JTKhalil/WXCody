import { ble } from "./services/ble";

App({
  /** 本会话内是否已在连接页触发过首次自动扫描（断连/拒绝后回连接页不再自动扫） */
  globalData: {
    connectInitialAutoScanDone: false,
  },
  onHide() {
    try {
      ble.endHanddrawGuessGameIfAppBackground();
    } catch (_) {}
  },
});
