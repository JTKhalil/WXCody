import { ble } from "../../../services/ble";

Page({
  data: {
    connected: false,
    deviceId: "",
    canScroll: false,

    notes: [],
    notePinnedOrig: -1,
    noteSlideshow: false,
    noteInterval: 10,
    noteEditIndex: -1,
    noteText: "",
    noteCharCount: 0,
    noteCharLeft: 100,

    confirmOpen: false,
    confirmMsg: "",
  },

  _confirmAction: "",
  _brightT: 0,
  _unsubs: null,

  onLoad() {
    const unsubs = [];
    unsubs.push(ble.onConnectionStateChange(() => {
      this.syncState();
    }));
    this._unsubs = unsubs;

    this.syncState();
    setTimeout(() => {
      this.onRefreshNotes().catch(() => {});
    }, 250);
  },

  onShow() {
    setTimeout(() => this._updateCanScroll(), 80);
  },

  onReady() {
    setTimeout(() => this._updateCanScroll(), 80);
  },

  onUnload() {
    if (this._brightT) clearTimeout(this._brightT);
    this._brightT = 0;
    const unsubs = this._unsubs || [];
    for (const u of unsubs) {
      try { u(); } catch (_) {}
    }
    this._unsubs = null;
  },

  noop() {},

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

  syncState() {
    this.setData({
      connected: ble.state.connected,
      deviceId: ble.state.deviceId || "",
    });
  },

  onNoteTextInput(evt) {
    const v0 = ((evt && evt.detail && evt.detail.value) || "").toString();
    const v = v0.length > 100 ? v0.slice(0, 100) : v0;
    this.setData({ noteText: v, noteCharCount: v.length, noteCharLeft: Math.max(0, 100 - v.length) });
  },

  async onRefreshNotes() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "get_notes" }, { timeoutMs: 3000, retries: 3 });
      const notes = Array.isArray(r && r.notes) ? r.notes : [];
      const pinned = Number(r && r.pinned);
      const noteSlideshow = !!(r && r.noteSlideshow);
      const noteInterval = Number(r && r.noteInterval) || 10;
      const pinnedOrig = Number.isFinite(pinned) ? pinned : -1;

      const all = notes.map((n, i) => ({ ...n, origIndex: i }));
      let pinnedItem = null;
      if (pinnedOrig >= 0 && pinnedOrig < all.length) {
        pinnedItem = all.find((x) => x.origIndex === pinnedOrig) || null;
      }
      const rest = all.filter((x) => x.origIndex !== pinnedOrig).sort((a, b) => b.origIndex - a.origIndex);
      const vm = pinnedItem ? [pinnedItem, ...rest] : rest;
      this.setData({
        notes: vm,
        notePinnedOrig: pinnedOrig,
        noteSlideshow: (pinnedOrig >= 0) ? false : noteSlideshow,
        noteInterval,
      });
    } catch (_) {}
    this._updateCanScroll();
  },

  onEditNote(evt) {
    const idx = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.idx) ?? -1);
    const notes = this.data.notes || [];
    const item = notes.find((x) => x && x.origIndex === idx) || null;
    const text = ((item && item.content) || "").toString();
    const v = text.length > 100 ? text.slice(0, 100) : text;
    this.setData({ noteEditIndex: idx, noteText: v, noteCharCount: v.length, noteCharLeft: Math.max(0, 100 - v.length) });
    this._updateCanScroll();
  },

  async onSaveNote() {
    if (!ble.state.connected) return;
    const content0 = (this.data.noteText || "").toString();
    const content = content0.length > 100 ? content0.slice(0, 100) : content0;
    const idx = Number(this.data.noteEditIndex);
    try {
      const payload = { cmd: "save_note", content, index: (idx >= 0 ? idx : -1) };
      const r = await ble.sendJsonStopAndWait(payload, { timeoutMs: 3000, retries: 3 });
      if (r && r.status === "ok") {
        this.setData({ noteEditIndex: -1, noteText: "", noteCharCount: 0, noteCharLeft: 100 });
        await this.onRefreshNotes();
      }
    } catch (_) {}
    this._updateCanScroll();
  },

  async onDeleteNote(evt) {
    if (!ble.state.connected) return;
    const idx = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.idx) ?? -1);
    this._confirmAction = "delete_note:" + idx;
    this.setData({ confirmOpen: true, confirmMsg: "确定要删除这条笔记吗？" });
  },

  async onPinNote(evt) {
    if (!ble.state.connected) return;
    const idx = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.idx) ?? -1);
    const pinned = (this.data.notePinnedOrig === idx) ? -1 : idx;
    try {
      await ble.sendJsonStopAndWait(
        { cmd: "set_note_config", pinned, slideshow: (pinned >= 0) ? false : !!this.data.noteSlideshow, interval: Number(this.data.noteInterval) || 10 },
        { timeoutMs: 1200, retries: 3 }
      );
      await this.onRefreshNotes();
    } catch (_) {}
  },

  onNoteSlideshowToggle(evt) {
    const v = !!(evt && evt.detail && evt.detail.value);
    if (this.data.notePinnedOrig >= 0) {
      this.setData({ noteSlideshow: false });
      return;
    }
    this.setData({ noteSlideshow: v });
    this._sendNoteConfigThrottled(true);
  },

  onNoteIntervalChanging(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (Number.isFinite(v)) this.setData({ noteInterval: v });
  },

  onNoteIntervalChange(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    const value = Math.max(3, Math.min(60, Number.isFinite(v) ? v : 10));
    this.setData({ noteInterval: value });
    this._sendNoteConfigThrottled(true);
  },

  async _sendNoteConfigThrottled(force) {
    if (!ble.state.connected) return;
    const pinned = Number(this.data.notePinnedOrig) || -1;
    const slideshow = pinned >= 0 ? false : !!this.data.noteSlideshow;
    try {
      await ble.sendJsonStopAndWait(
        { cmd: "set_note_config", pinned, slideshow, interval: Number(this.data.noteInterval) || 10 },
        { timeoutMs: 1200, retries: 3 }
      );
    } catch (_) {}
    if (force) this._updateCanScroll();
  },

  onCancelConfirm() {
    this._confirmAction = "";
    this.setData({ confirmOpen: false, confirmMsg: "" });
  },

  async onOkConfirm() {
    const action = this._confirmAction || "";
    this.setData({ confirmOpen: false });
    if (action.startsWith("delete_note:")) {
      const idx = Number(action.split(":")[1] || -1);
      try {
        await ble.sendJsonStopAndWait({ cmd: "delete_note", index: idx }, { timeoutMs: 1500, retries: 2 });
        await this.onRefreshNotes();
      } catch (_) {}
    }
  },
});

