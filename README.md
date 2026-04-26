## WXCody（微信小程序：Cody BLE 管理端）

本目录是 **微信小程序**，用于通过 **BLE（GATT）** 直连 `Cody` 设备，完成连接/配对、模式切换、图片/笔记/手绘设置、系统设置，以及 **固件升级（在线与本地 `firmware.bin`）**。

### 运行环境

- **微信开发者工具**（项目类型：小程序）
- **手机端微信**（真机调试 BLE 必需）
- **已烧录并运行 Cody 固件**（见 `../Cody/README.md`）

### 快速开始

1. 打开微信开发者工具，选择“导入项目”
2. 项目目录选择本文件夹：`WXCody/`
3. AppID 使用 `project.config.json` 里的（或替换为你的测试号）
4. 真机调试运行

### 页面与入口

页面列表定义在 `app.json`：

- `pages/splash/splash`：启动页（尝试自动重连上次设备，失败则进入连接页）
- `pages/connect/connect`：连接页（打开蓝牙、扫描 `Cody-*`、连接与设备端确认配对）
- `pages/console/console`：主控制台（模式切换、系统设置入口）
- `pages/mode/image/image`：图片模式设置
- `pages/mode/note/note`：笔记模式设置
- `pages/mode/handdraw/handdraw`：手绘模式设置
- `pages/settings/conn`：连接设置（断开/清配对）
- `pages/settings/fs`：存储空间与危险操作（格式化/恢复出厂）
- `pages/settings/fw`：更新设置（检查版本、在线升级、本地 `firmware.bin` 升级）
- `pages/settings/bright`：背光亮度

> 说明：历史上的独立 `pages/ota/ota` 与 `pages/gallery/gallery` 调试页已移除，升级统一收敛到「更新设置」二级页。

### BLE 约定（必须与固件一致）

UUID 常量在运行时实现 `services/ble.js` 中定义：

- **Service UUID**：`0000C0DE-0000-1000-8000-00805F9B34FB`
- **RX Char UUID（Write/WriteNoResponse）**：`0000C0D1-0000-1000-8000-00805F9B34FB`
- **TX Char UUID（Notify）**：`0000C0D2-0000-1000-8000-00805F9B34FB`

扫描过滤策略：默认按设备名 `Cody-` 前缀匹配（见 `pages/connect/connect.js` / `services/ble.js`）。

### 首次连接/绑定（重要）

固件端启用了“首次连接需要确认”的绑定逻辑（pair pending）：

- 小程序连接后，需要先发送 `pair_hello`（JSONL）上报 `name/id`
- 设备端会弹出确认界面（在 Cody 屏幕上），用户按键确认后才会放行后续命令
- 已绑定后，设备会只信任该 `clientId`，其它手机连接会被直接断开

在控制台“断开连接”流程中，小程序会调用 `{"cmd":"ble_forget"}` 清除设备端信任记录，并清空本地缓存（保留本机身份键），以便下次重新配对。

### 协议

本项目同时使用两类协议：

#### 1) JSONL（控制命令）

- **发送**：`JSON.stringify(obj) + "\n"` 写入 RX
- **接收**：固件会把一行 JSONL 通过 TX notify 发送，且可能被分片；小程序端按字节拼接，遇到 `\n` 再整体 UTF-8 解码与 `JSON.parse`

实现位于 `services/ble.js` 的 `sendJson()/sendJsonStopAndWait()` 与 `_consumeJsonl()`。

常用命令（示例）：

- `{"cmd":"get_mode"}`
- `{"cmd":"set_mode","mode":0}`
- `{"cmd":"image_info"}`
- `{"cmd":"get_notes"}`
- `{"cmd":"save_note","content":"...","index":-1}`
- `{"cmd":"delete_note","index":0}`
- `{"cmd":"set_note_config","pinned":-1,"slideshow":true,"interval":10}`
- `{"cmd":"fs_space"}`
- `{"cmd":"bright","v":200}`
- `{"cmd":"format_fs"}`
- `{"cmd":"reset_system"}`
- `{"cmd":"ota_info"}`
- `{"cmd":"sync_time","timestamp":<unix_seconds>}`

#### 2) 二进制分帧（图片/OTA）

帧格式实现位于 `services/proto_bin.ts`：

- MAGIC：`0xC0 0xDE`
- `TYPE / SESSION / SEQ / LEN / PAYLOAD / CRC16`
- 采用 stop-and-wait（发一包等 ACK），部分场景也支持并发窗口发送（见 `pages/console/console.js` OTA 上传的 `windowN`）

帧类型（节选）：

- `Ping=0x01`, `Ack=0x7f`
- 图库：`ImgPullBegin/Chunk/Finish`，`ImgPushBegin/Chunk/Finish`
- OTA：`OtaBegin/Chunk/Finish/Status`

### 图库（RGB565）

- 图片统一处理为 **240×240 RGB565**（2 bytes/pixel，总大小 115200 bytes）
- 上传时小程序会在 canvas 上居中裁切缩放到 240×240，再转 RGB565 分块发送
- 拉取时会接收 RGB565 分块，拼满后渲染到 canvas，并缓存到本地 storage（用于下次快速预览）

实现主要在：

- `pages/mode/image/image.js`（图片模式：图槽、缩略图同步等）
- `pages/console/console.js`（控制台内仍保留部分图库相关 Tab 逻辑时，与 `img_thumb_sync` 等配合）

### OTA 升级

- `services/fw_upgrade.js`：统一 OTA 推送（`OtaBegin` / `OtaChunk` / `OtaFinish`）；在线升级从远端下载 `firmware.bin`，**本地升级**从用户选择的 `.bin` 临时路径读取后推送。
- `pages/settings/fw.js`（更新设置）：检查版本、在线升级、**选择本地 firmware.bin 升级**。

注意：

- OTA 会推送原始 `firmware.bin`，设备端写入 OTA 分区并在成功后重启（通常表现为 BLE 断开）

### 常见问题

- **扫描不到设备**：
  - 确认固件在广播（设备名应以 `Cody-` 开头）
  - 手机系统蓝牙已开启、微信已授予蓝牙权限
- **写入失败/超时**：
  - BLE 写入在不同机型上吞吐差异很大，项目内已对 JSON 与 BIN 做了分片与节流；仍可尝试靠近设备或重连
- **首次连接无法控制**：
  - 需要在设备上完成“连接确认”（pair pending），否则固件会对命令返回 `need_confirm`
