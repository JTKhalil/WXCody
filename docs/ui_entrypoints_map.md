# UI 改版入口映射（console → Dashboard + 二级页面）

> 目的：打破现有 `pages/console/console` 的 Tab 布局，但 **保留所有功能入口**。本表用于迁移核对。

## 术语
- **旧入口**：当前 `pages/console/console.wxml`（底部 Tabs：模式/图库/笔记/手绘/设置）里的入口与操作
- **新结构**：
  - **Dashboard**：`pages/console/console`（改为首页控制台）
  - **手绘页**：`pages/handdraw/handdraw`
  - **图库页**：`pages/gallery/gallery`（重做 UI，但可沿用现有逻辑）
  - **设备页**：`pages/device/device`
  - **日志页**：`pages/logs/logs`

---

## 模式（旧 Tab=模式）
- **旧：模式按钮（0~4）**（`onSetMode`)  
  - **新：Dashboard / 模式卡片（SegmentedControl）**（主入口）  
  - **新：设备页 / 模式**（完整入口与说明）
- **旧：刷新模式**（`onRefreshMode`)  
  - **新：Dashboard / 状态区的刷新**（轻入口）  
  - **新：设备页 / 刷新**（完整入口）

---

## 图库与图片轮播（旧 Tab=图库）
- **旧：启用轮播 switch**（`onImgSlideshowToggle`)  
  - **新：Dashboard / 快捷操作（可选）**  
  - **新：图库页 / 轮播设置**（主入口）
- **旧：间隔 slider**（`onImgIntervalChange`)  
  - **新：图库页 / 轮播设置**
- **旧：slot 缩略图网格（上传/替换/删除/取消上传）**（`onPush/onDeleteImage/onCancelUpload`)  
  - **新：图库页 / 网格与批量管理**（主入口）
- **旧：图片信息刷新**（`onRefreshImageInfo`)  
  - **新：图库页 / 下拉刷新或按钮**

---

## 笔记（旧 Tab=笔记）
- **旧：笔记轮播开关 + 间隔**（`onNoteSlideshowToggle/onNoteIntervalChange`)  
  - **新：Dashboard / 快捷操作（可选）**  
  - **新：设备页（或单独 notes 页，若后续要扩展）**
- **旧：新增/编辑笔记 textarea + 保存**（`onSaveNote/onEditNote/onNoteTextInput`)  
  - **新：Dashboard / 入口列表 → 笔记（待定页面）**
  - **说明**：本次计划未单列 notes 页；初版可先放入设备页的一个分组，后续独立更清爽。
- **旧：历史笔记列表（置顶/编辑/删除）**（`onPinNote/onDeleteNote`)  
  - **新：同上**

---

## 手绘与你画我猜（旧 Tab=手绘）
- **旧：画布绘制（触摸）**（`onHdTouchStart/onHdTouchMove/onHdTouchEnd`)  
  - **新：手绘页 / 画布**（主入口）
- **旧：颜色选择/粗细 slider**（`onHdPickColor/onHdStrokeChange`)  
  - **新：手绘页 / 工具条**
- **旧：清屏**（`onHdClear`)  
  - **新：手绘页 / 工具条（主入口）**  
  - **新：Dashboard / 快捷操作（可选）**
- **旧：开始/结束你画我猜**（`onHdGuessGame`)  
  - **新：手绘页 / 工具条（主入口）**  
  - **新：Dashboard / 快捷操作（可选）**
- **旧：遮罩（拉取/锁定/清屏/准备游戏）**  
  - **新：手绘页 / 统一遮罩组件**（保持直角画布与遮罩）

---

## 设置/设备（旧 Tab=设置）
- **旧：断开连接**（`onDisconnectBle`)  
  - **新：设备页 / 连接管理（主入口）**
- **旧：存储空间显示 + 刷新**（`onRefreshFs`)  
  - **新：设备页 / 存储空间**
- **旧：固件版本/检查更新/升级**（`onCheckUpdate/onUpgrade`)  
  - **新：设备页 / 固件更新**
- **旧：背光亮度 slider**（`onBrightnessChange`)  
  - **新：Dashboard / 快捷操作（轻入口）**  
  - **新：设备页 / 显示**
- **旧：危险操作（format_fs/reset_system）+ confirm modal**（`onAskConfirm/onOkConfirm`)  
  - **新：设备页 / 危险操作（保留 confirm modal）**
- **旧：重连**（`onReconnect`)  
  - **新：Dashboard / 状态区按钮**  
  - **新：设备页 / 连接管理**

---

## 日志与调试（旧 console 页内）
- **旧：复制日志/清空/开关 debug**（`onCopyLogs/onClearLogs/onToggleDebug`)  
  - **新：日志页 / 主入口**

