import { ble } from "../../../services/ble";

const IMG_BYTES = 240 * 240 * 2;
/** 与 proto_bin HANDDRAW_BATCH_MAX 一致；超限先刷避免截断 */
const HD_BLE_BATCH_MAX = 20;

/** 你画我猜词库（1000 词） */
const HD_GUESS_WORDS = [
  // 1. 动物界 (1-100)
  "狗","猫","猪","牛","羊","马","鸡","鸭","鹅","鱼","虾","蟹","龟","蛇","蛙","鸟","狼","熊","虎","豹","狮","象","鹿","猴","猩猩","狐狸","兔子","老鼠","松鼠","蝙蝠","企鹅","海豹","海豚","鲸鱼","鲨鱼","章鱼","乌贼","海星","海马","水母","蝴蝶","蜜蜂","蚂蚁","苍蝇","蚊子","蟑螂","蜘蛛","蜈蚣","毛毛虫","蜗牛","蚯蚓","螳螂","蜻蜓","蝉","萤火虫","瓢虫","刺猬","袋鼠","考拉","鸭嘴兽","熊猫","孔雀","天鹅","鸽子","老鹰","乌鸦","喜鹊","鹦鹉","啄木鸟","麻雀","燕子","猫头鹰","鸵鸟","火烈鸟","长颈鹿","斑马","骆驼","犀牛","河马","鳄鱼","蜥蜴","变色龙","恐龙","翼龙","剑龙","霸王龙","三叶虫","草泥马","哈士奇","柯基","柴犬","布偶猫","波斯猫","金鱼","锦鲤","大闸蟹","小龙虾","鲍鱼","生蚝","海螺",
  // 2. 水果蔬菜与植物 (101-200)
  "苹果","香蕉","梨","桃子","葡萄","西瓜","草莓","橙子","橘子","柚子","柠檬","菠萝","芒果","榴莲","木瓜","椰子","樱桃","蓝莓","猕猴桃","石榴","柿子","无花果","甘蔗","哈密瓜","火龙果","山竹","荔枝","龙眼","白菜","萝卜","土豆","番茄","黄瓜","茄子","辣椒","南瓜","冬瓜","苦瓜","丝瓜","洋葱","大蒜","生姜","大葱","芹菜","韭菜","菠菜","生菜","花菜","西兰花","蘑菇","香菇","金针菇","木耳","海带","紫菜","玉米","红薯","花生","毛豆","豌豆","绿豆","黄豆","红豆","芝麻","葵花籽","核桃","板栗","杏仁","开心果","松子","莲藕","竹笋","芦笋","胡萝卜","香菜","薄荷","玫瑰","百合","菊花","荷花","梅花","桃花","樱花","向日葵","蒲公英","仙人掌","含羞草","枫叶","松树","竹子","柳树","梧桐树","苹果树","葡萄藤","狗尾巴草","多肉植物","芦荟","猪笼草","四叶草","海藻",
  // 3. 食物与饮品 (201-300)
  "米饭","面条","馒头","包子","饺子","馄饨","汤圆","油条","豆浆","稀饭","炒饭","炒面","火锅","烧烤","麻辣烫","串串香","汉堡","薯条","炸鸡","披萨","牛排","意面","寿司","刺身","拉面","咖喱","三明治","热狗","甜甜圈","马卡龙","巧克力","冰淇淋","蛋糕","饼干","面包","布丁","果冻","糖果","棒棒糖","棉花糖","薯片","爆米花","辣条","牛肉干","猪肉脯","豆腐","腐竹","粉丝","粉条","米粉","煎饼果子","肉夹馍","凉皮","烤鸭","白切鸡","红烧肉","糖醋排骨","宫保鸡丁","麻婆豆腐","酸菜鱼","水煮肉片","烤鱼","小笼包","生煎包","蛋挞","可乐","雪碧","芬达","果汁","奶茶","咖啡","绿茶","红茶","乌龙茶","菊花茶","牛奶","酸奶","啤酒","红酒","白酒","香槟","鸡尾酒","矿泉水","苏打水","豆奶","凉茶","冰沙","奶昔","冰棒","雪糕","冰淇淋筒","火腿肠","培根","荷包蛋","茶叶蛋","松花蛋","咸鸭蛋","香肠","腊肉","肉丸","鱼丸","虾饺",
  // 4. 服饰与美妆 (301-400)
  "衣服","裤子","裙子","衬衫","T恤","毛衣","外套","大衣","羽绒服","风衣","西装","夹克","卫衣","背心","短裤","长裤","牛仔裤","休闲裤","运动裤","连衣裙","半身裙","超短裙","内衣","内裤","袜子","丝袜","棉袜","鞋子","皮鞋","运动鞋","休闲鞋","高跟鞋","凉鞋","拖鞋","靴子","雨鞋","雪地靴","帽子","棒球帽","草帽","毛线帽","头盔","围巾","丝巾","手套","皮带","领带","领结","手表","项链","戒指","耳环","手镯","手链","胸针","发夹","发箍","橡皮筋","梳子","镜子","眼镜","墨镜","隐形眼镜","口罩","雨伞","遮阳伞","包包","背包","单肩包","钱包","行李箱","口红","唇膏","粉底","散粉","眼影","眼线笔","睫毛膏","眉笔","腮红","香水","指甲油","洗面奶","沐浴露","洗发水","护发素","身体乳","防晒霜","面膜","卸妆水","化妆棉","棉签","剃须刀","吹风机","卷发棒","直发梳","假发","纹身","美瞳","高光","修容",
  // 5. 家具与家电 (401-500)
  "桌子","椅子","沙发","床","衣柜","书柜","鞋柜","电视柜","茶几","餐桌","办公桌","电脑桌","梳妆台","床头柜","凳子","板凳","吊床","摇椅","书架","衣架","晾衣架","垃圾桶","扫把","拖把","吸尘器","扫地机器人","抹布","水桶","洗脸盆","浴缸","马桶","花洒","水龙头","水槽","燃气灶","抽油烟机","微波炉","烤箱","电饭煲","热水壶","咖啡机","榨汁机","破壁机","洗碗机","消毒柜","冰箱","冷柜","洗衣机","烘干机","电视机","投影仪","音响","麦克风","耳机","路由器","机顶盒","空调","电风扇","暖风机","加湿器","空气净化器","除湿机","台灯","吊灯","壁灯","落地灯","手电筒","插座","排插","开关","电线","电池","遥控器","钟表","闹钟","日历","相框","花瓶","烟灰缸","抱枕","靠垫","被子","枕头","床单","毛毯","地毯","窗帘","百叶窗","纱窗","门铃","锁","钥匙","保险箱","体重秤","温度计","卷尺","剪刀","指甲剪","针线","锤子","螺丝刀","钳子",
  // 6. 交通与建筑 (501-600)
  "汽车","自行车","摩托车","电动车","三轮车","公交车","大巴车","出租车","警车","救护车","消防车","卡车","货车","拖拉机","挖掘机","推土机","吊车","叉车","火车","高铁","地铁","轻轨","飞机","直升机","战斗机","客机","火箭","航天飞机","人造卫星","飞碟","热气球","飞艇","降落伞","轮船","游艇","帆船","潜水艇","皮划艇","木筏","航母","滑板","轮滑鞋","滑板车","平衡车","婴儿车","轮椅","马车","高铁站","火车站","地铁站","飞机场","港口","码头","加油站","充电桩","红绿灯","斑马线","路牌","减速带","桥梁","隧道","立交桥","高速公路","铁路","灯塔","风车","水车","城堡","宫殿","别墅","公寓","平房","草茅","帐篷","金字塔","长城","埃菲尔铁塔","自由女神像","天安门","东方明珠","体育场","游泳馆","电影院","游乐园","摩天轮","过山车","旋转木马","海盗船","水族馆","动物园","植物园","博物馆","图书馆","学校","医院","银行","邮局","超市","商场","菜市场","餐厅","咖啡馆",
  // 7. 职业与人物 (601-700)
  "警察","小偷","医生","护士","老师","学生","校长","服务员","厨师","理发师","快递员","外卖员","司机","飞行员","空姐","水手","船长","宇航员","科学家","工程师","程序员","设计师","画家","音乐家","歌手","演员","导演","摄影师","模特","记者","主持人","作家","诗人","律师","法官","老板","员工","秘书","会计","保安","保洁","农民","渔民","猎人","矿工","建筑工人","消防员","军人","特种兵","间谍","杀手","侦探","魔术师","小丑","杂技演员","运动员","裁判","教练","健身教练","按摩师","修车工","木匠","铁匠","裁缝","导游","翻译","收银员","售货员","乞丐","流浪汉","国王","王后","王子","公主","骑士","魔法师","女巫","吸血鬼","狼人","丧尸","外星人","机器人","美人鱼","天使","恶魔","神仙","妖怪","玉皇大帝","孙悟空","猪八戒","唐僧","沙和尚","哪吒","葫芦娃","奥特曼","蜘蛛侠","钢铁侠","蝙蝠侠","超人","美国队长",
  // 8. 科技数码与文具 (701-800)
  "电脑","笔记本电脑","平板电脑","手机","智能手表","充电宝","数据线","键盘","鼠标","显示器","主机","显卡","主板","内存条","硬盘","U盘","光盘","打印机","扫描仪","复印机","传真机","3D打印机","无人机","单反相机","拍立得","摄像机","镜头","三脚架","望远镜","显微镜","放大镜","指南针","计算器","算盘","试管","烧杯","酒精灯","磁铁","地球仪","黑板","粉笔","黑板擦","白板","马克笔","铅笔","钢笔","圆珠笔","水性笔","毛笔","橡皮擦","修正液","尺子","圆规","量角器","三角板","笔袋","文具盒","书包","书本","字典","报纸","杂志","信封","邮票","明信片","胶水","胶带","订书机","曲别针","大头针","图钉","便签纸","笔记本","日记本","文件夹","档案袋","名片","印章","砚台","墨水","宣纸","字画","代码","芯片","服务器","云端","安卓","Flutter","蓝牙","Wifi","密码","二维码","条形码","指纹","人脸识别","人工智能","蔚来","电瓶","快递箱","伺服电机",
  // 9. 运动娱乐与自然 (801-900)
  "篮球","足球","排球","乒乓球","羽毛球","网球","台球","保龄球","高尔夫球","棒球","橄榄球","冰球","水球","铅球","标枪","铁饼","跳高","跳远","跑步","游泳","潜水","冲浪","滑水","滑雪","滑冰","拳击","摔跤","柔道","跆拳道","空手道","击剑","射箭","射击","举重","体操","瑜伽","舞蹈","芭蕾","街舞","广场舞","太极拳","武术","双节棍","平底锅","三级头","三级甲","绝地求生","八倍镜","信号枪","医疗箱","扑克牌","麻将","象棋","围棋","五子棋","飞行棋","跳棋","骰子","积木","拼图","悠悠球","陀螺","风筝","沙包","跳绳","毽子","呼啦圈","滑梯","秋千","跷跷板","太阳","月亮","星星","流星","银河","黑洞","云朵","雨滴","雪花","闪电","彩虹","龙卷风","台风","火山","地震","海啸","瀑布","河流","湖泊","海洋","岛屿","沙漠","绿洲","森林","草原","高山","峡谷","溶洞","冰川","悬崖",
  // 10. 动作状态与趣味成语 (901-1000)
  "哭泣","大笑","微笑","生气","发怒","害怕","恐惧","惊讶","害羞","悲伤","睡觉","打呼噜","做梦","起床","洗脸","刷牙","洗澡","吃饭","喝水","咀嚼","吞咽","呕吐","走路","跑步","跳跃","爬行","飞翔","跌倒","攀岩","打架","踢腿","挥手","鼓掌","拥抱","亲吻","握手","鞠躬","下跪","点头","摇头","指引","推拉","搬运","举起","扔掉","捡起","敲门","开锁","关窗","切菜","炒菜","洗碗","扫地","画画","写字","唱歌","跳舞","弹琴","吹笛子","打鼓","拍照","打电话","看书","玩手机","看电视","听音乐","思考","发呆","守株待兔","刻舟求剑","掩耳盗铃","拔苗助长","画蛇添足","对牛弹琴","狐假虎威","井底之蛙","杯弓蛇影","亡羊补牢","盲人摸象","画龙点睛","掩卷沉思","大惊小怪","手舞足蹈","东张西望","鸡飞狗跳","狼吞虎咽","张牙舞爪","抓耳挠腮","眉飞色舞","泪流满面","捧腹大笑","垂头丧气","火冒三丈","目瞪口呆","九牛一毛","一箭双雕","百发百中","三头六臂","五颜六色","七上八下",
];

function pickRandomGuessWord() {
  const a = HD_GUESS_WORDS;
  return a[Math.floor(Math.random() * a.length)];
}

function handdrawCachePath(deviceId) {
  const id = String(deviceId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const root = (typeof wx !== "undefined" && wx.env && wx.env.USER_DATA_PATH) ? wx.env.USER_DATA_PATH : "";
  return `${root}/wxcody_handdraw_${id}.bin`;
}

function hexToRgb565(hex) {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6) return 0;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (![r, g, b].every((n) => Number.isFinite(n))) return 0;
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function clampHanddrawXY(x, y) {
  return {
    x: Math.max(0, Math.min(239, Math.floor(x))),
    y: Math.max(0, Math.min(239, Math.floor(y))),
  };
}

function rgb565ToImageData(bytes, imageData) {
  const dst = imageData.data;
  let di = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const v = bytes[i] | (bytes[i + 1] << 8);
    const r5 = (v >> 11) & 0x1f;
    const g6 = (v >> 5) & 0x3f;
    const b5 = (v >> 0) & 0x1f;
    dst[di++] = (r5 * 255 + 15) / 31;
    dst[di++] = (g6 * 255 + 31) / 63;
    dst[di++] = (b5 * 255 + 15) / 31;
    dst[di++] = 255;
  }
}

async function getCanvas2dById(page, id, size) {
  return await new Promise((resolve, reject) => {
    wx.createSelectorQuery()
      .in(page)
      .select("#" + id)
      .fields({ node: true, size: true })
      .exec((res) => {
        const node = res && res[0] && res[0].node;
        if (!node) return reject(new Error("canvas node not found: " + id));
        const canvas = node;
        const ctx = canvas.getContext("2d");
        const s = size || 240;
        canvas.width = s;
        canvas.height = s;
        resolve({ canvas, ctx });
      });
  });
}

function putRgb565BufferOnCanvas(c2d, bytes, reuse) {
  if (!c2d || !bytes || bytes.length < IMG_BYTES) return;
  let imageData = reuse && reuse.imageData;
  if (!imageData || imageData.width !== 240 || imageData.height !== 240) {
    imageData = c2d.createImageData(240, 240);
    if (reuse) reuse.imageData = imageData;
  }
  rgb565ToImageData(bytes, imageData);
  c2d.putImageData(imageData, 0, 0);
}

function makeSolidHanddrawRgb565(bgKey) {
  const u8 = new Uint8Array(IMG_BYTES);
  const bg565 = bgKey === "white" ? 0xffff : 0;
  for (let i = 0; i < IMG_BYTES; i += 2) {
    u8[i] = bg565 & 0xff;
    u8[i + 1] = (bg565 >> 8) & 0xff;
  }
  return u8;
}

function handdrawRgb565ApplySegment(bytes, x0, y0, x1, y1, rgb565, widthPx) {
  const kW = 240;
  const kH = 240;
  let wp = Math.max(1, Math.min(24, Number(widthPx) || 4));
  let r = Math.floor(wp / 2);
  if (r < 1) r = 1;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  x0 = clamp(Math.floor(x0), 0, kW - 1);
  y0 = clamp(Math.floor(y0), 0, kH - 1);
  x1 = clamp(Math.floor(x1), 0, kW - 1);
  y1 = clamp(Math.floor(y1), 0, kH - 1);

  const plotDisk = (cx, cy, rad, c) => {
    for (let py = cy - rad; py <= cy + rad; py++) {
      if (py < 0 || py >= kH) continue;
      for (let px = cx - rad; px <= cx + rad; px++) {
        if (px < 0 || px >= kW) continue;
        const dx = px - cx;
        const dy = py - cy;
        if (dx * dx + dy * dy <= rad * rad) {
          const o = (py * kW + px) * 2;
          bytes[o] = c & 0xff;
          bytes[o + 1] = (c >> 8) & 0xff;
        }
      }
    }
  };

  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (;;) {
    plotDisk(x, y, r, rgb565);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

Page({
  data: {
    connected: false,
    deviceId: "",

    hdPenHex: "#ffffff",
    hdStrokeW: 4,
    hdMirror: false,
    hdBg: "black",
    hdPalette: ["#000000", "#ffffff", "#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6"],
    hdPulling: false,
    hdPullPercent: 0,
    hdClearing: false,
    hdGuessStarting: false,
    hdDrawBlocked: false,
    hdDrawBlockMsg: "",
    hdGuessPlaying: false,
    hdGuessPrompt: "",
    hdGuessRevealBlock: false,
    hdGuessRevealMsg: "本局答案已揭晓，请清屏或开始新游戏后再绘画。",
  },

  _hdCtx: null,
  _hdLast: null,
  _hdCanvasCssSize: 0,
  _handdrawBleReady: false,
  _hdBleSendChain: null,
  _hdRgb565Cache: null,
  _hdPersistT: 0,
  _hdModePollId: 0,
  _hdBleBatch: null,
  _hdBleBatchTimer: 0,
  _hdGuessTimer: 0,
  _unsubs: null,
  _hdRgb565PutReuse: null,
  _hdPaintRafPending: false,

  onLoad() {
    this._hdCtx = {};
    this._hdLast = {};
    this._hdBleSendChain = Promise.resolve();

    const unsubs = [];
    unsubs.push(ble.onConnectionStateChange((connected) => {
      this.syncState();
      if (!connected) {
        this._stopHanddrawModePoll();
        this.setData({
          hdGuessPlaying: false,
          hdGuessPrompt: "",
          hdGuessStarting: false,
          hdGuessRevealBlock: false,
        });
        if (this._hdGuessTimer) {
          try { clearTimeout(this._hdGuessTimer); } catch (_) {}
          this._hdGuessTimer = 0;
        }
      }
    }));
    this._unsubs = unsubs;

    this.syncState();
    setTimeout(() => {
      this._startHanddrawModePoll();
      this._enterHanddraw().catch(() => {});
    }, 250);
  },

  onShow() {
    try { wx.hideHomeButton(); } catch (_) {}
    this._startHanddrawModePoll();
  },

  onHide() {
    this._stopGuessGameOnLeave();
  },

  onUnload() {
    this._stopGuessGameOnLeave();
    this._stopHanddrawModePoll();
    if (this._hdPersistT) {
      try { clearTimeout(this._hdPersistT); } catch (_) {}
      this._hdPersistT = 0;
    }
    if (this._hdBleBatchTimer) {
      try { clearTimeout(this._hdBleBatchTimer); } catch (_) {}
      this._hdBleBatchTimer = 0;
    }
    this._hdBleBatch = null;
    if (this._hdGuessTimer) {
      try { clearTimeout(this._hdGuessTimer); } catch (_) {}
      this._hdGuessTimer = 0;
    }
    const unsubs = this._unsubs || [];
    for (const u of unsubs) {
      try { u(); } catch (_) {}
    }
    this._unsubs = null;
  },

  noop() {},

  syncState() {
    this.setData({
      connected: ble.state.connected,
      deviceId: ble.state.deviceId || "",
    });
  },

  _cancelHdBleBatchTimer() {
    if (this._hdBleBatchTimer) {
      try { clearTimeout(this._hdBleBatchTimer); } catch (_) {}
      this._hdBleBatchTimer = 0;
    }
  },

  _flushHdBleBatchNow() {
    this._cancelHdBleBatchTimer();
    const batch = this._hdBleBatch;
    if (!batch || !batch.length) return;
    this._hdBleBatch = [];
    const copy = batch.slice();
    const batchGen = typeof ble.getHanddrawStrokeGeneration === "function" ? ble.getHanddrawStrokeGeneration() : 0;
    const run = () => {
      if (typeof ble.sendHanddrawStrokeBatchBin === "function") {
        return ble.sendHanddrawStrokeBatchBin(copy, batchGen);
      }
      if (typeof ble.sendHanddrawStrokeBin === "function") {
        let p = Promise.resolve();
        for (const s of copy) p = p.then(() => ble.sendHanddrawStrokeBin(s, batchGen));
        return p;
      }
      let p = Promise.resolve();
      for (const s of copy) {
        const payload = { cmd: "draw_stroke", x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1, c: s.c, w: s.w };
        p = p.then(() =>
          ble.sendJson(payload, { interChunkDelayMs: 0, writeNoResponse: true, handdrawStrokeGen: batchGen })
        );
      }
      return p;
    };
    this._hdBleSendChain = (this._hdBleSendChain || Promise.resolve()).then(run).catch(() => {});
  },

  async _awaitHanddrawBleIdle() {
    this._flushHdBleBatchNow();
    await (this._hdBleSendChain || Promise.resolve());
  },

  _putHanddrawRgb565OnCanvas(c2d, bytes) {
    if (!c2d || !(bytes instanceof Uint8Array) || bytes.length < IMG_BYTES) return;
    if (!this._hdRgb565PutReuse) this._hdRgb565PutReuse = { imageData: null };
    putRgb565BufferOnCanvas(c2d, bytes, this._hdRgb565PutReuse);
  },

  _flushHdCanvasPaintNow() {
    const pack = this._hdCtx && this._hdCtx.canvasDraw;
    const bytes = this._hdRgb565Cache;
    if (!pack || !pack.ctx || !(bytes instanceof Uint8Array) || bytes.length !== IMG_BYTES) return;
    this._putHanddrawRgb565OnCanvas(pack.ctx, bytes);
  },

  _scheduleHdCanvasPaint() {
    if (this._hdPaintRafPending) return;
    this._hdPaintRafPending = true;
    const canvas = this._hdCtx && this._hdCtx.canvasDraw && this._hdCtx.canvasDraw.canvas;
    const done = () => {
      this._hdPaintRafPending = false;
      this._flushHdCanvasPaintNow();
      if (this._hdBleBatch && this._hdBleBatch.length) {
        this._flushHdBleBatchNow();
      }
    };
    try {
      if (canvas && typeof canvas.requestAnimationFrame === "function") {
        canvas.requestAnimationFrame(done);
      } else {
        setTimeout(done, 0);
      }
    } catch (_) {
      done();
    }
  },

  /** 丢弃尚未发出的笔迹同步，不等待 Cody 端收完 */
  _discardHanddrawBlePending() {
    try {
      if (typeof ble.bumpHanddrawStrokeGeneration === "function") ble.bumpHanddrawStrokeGeneration();
    } catch (_) {}
    this._cancelHdBleBatchTimer();
    this._hdBleBatch = null;
    this._hdBleSendChain = Promise.resolve();
  },

  _measureHdCanvasCssSize() {
    try {
      wx.createSelectorQuery()
        .in(this)
        .select("#canvasDraw")
        .fields({ size: true })
        .exec((res) => {
          const r0 = res && res[0];
          const w = Number(r0 && r0.width) || 0;
          const h = Number(r0 && r0.height) || 0;
          const s = Math.max(w, h);
          if (s > 0) this._hdCanvasCssSize = s;
        });
    } catch (_) {}
  },

  _mapHdTouchTo240(x, y) {
    const css = Number(this._hdCanvasCssSize) || 0;
    if (css > 0) return { x: (x * 240) / css, y: (y * 240) / css };
    return { x, y };
  },

  onHdPickColor(e) {
    const hex = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.hex) || "#000000";
    this.setData({ hdPenHex: String(hex) });
  },

  onHdStrokeChanging(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (Number.isFinite(v)) this.setData({ hdStrokeW: v });
  },

  onHdStrokeChange(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    const value = Math.max(2, Math.min(16, Number.isFinite(v) ? v : 4));
    this.setData({ hdStrokeW: value });
  },

  onHdMirrorToggle(evt) {
    const v = !!(evt && evt.detail && evt.detail.value);
    this.setData({ hdMirror: v });
  },

  _scheduleHanddrawPersist() {
    if (this._hdPersistT) {
      try { clearTimeout(this._hdPersistT); } catch (_) {}
      this._hdPersistT = 0;
    }
    this._hdPersistT = setTimeout(() => {
      this._hdPersistT = 0;
      this._saveHanddrawToDisk();
    }, 380);
  },

  _flushHanddrawPersist() {
    if (this._hdPersistT) {
      try { clearTimeout(this._hdPersistT); } catch (_) {}
      this._hdPersistT = 0;
    }
    this._saveHanddrawToDisk();
  },

  _loadHanddrawFromDisk() {
    const deviceId = String((ble.state.deviceId || this.data.deviceId || "").trim());
    if (!deviceId) return null;
    try {
      const fs = wx.getFileSystemManager();
      const path = handdrawCachePath(deviceId);
      const res = fs.readFileSync(path);
      const ab = res && res.data !== undefined ? res.data : res;
      if (!ab || (typeof ab.byteLength !== "number")) return null;
      const u8 = new Uint8Array(ab);
      if (u8.length !== IMG_BYTES) return null;
      return u8;
    } catch (_) {
      return null;
    }
  },

  _saveHanddrawToDisk() {
    const bytes = this._hdRgb565Cache;
    const deviceId = String((ble.state.deviceId || this.data.deviceId || "").trim());
    if (!(bytes instanceof Uint8Array) || bytes.length !== IMG_BYTES || !deviceId) return;
    try {
      const fs = wx.getFileSystemManager();
      const path = handdrawCachePath(deviceId);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      fs.writeFileSync(path, ab);
    } catch (_) {}
  },

  _removeHanddrawDiskCache() {
    const deviceId = String((ble.state.deviceId || this.data.deviceId || "").trim());
    if (!deviceId) return;
    try {
      const fs = wx.getFileSystemManager();
      fs.unlinkSync(handdrawCachePath(deviceId));
    } catch (_) {}
  },

  _updateHanddrawBlockStateFromMode(mode) {
    const connected = !!ble.state.connected;
    const m = Number(mode);
    const blocked = connected && Number.isFinite(m) && m >= 0 && m !== 4;
    const msg = "Cody 当前不是手绘模式，画板已锁定。请先在「模式」中切换为「手绘模式」，或在设备上切至手绘后再绘画。";
    if (this.data.hdDrawBlocked !== blocked || this.data.hdDrawBlockMsg !== msg) {
      this.setData({ hdDrawBlocked: blocked, hdDrawBlockMsg: msg });
    }
  },

  _isHanddrawModeOnlyBlocked() {
    if (!ble.state.connected) return true;
    const m = Number(this._lastMode || -1);
    if (!Number.isFinite(m) || m < 0) return false;
    return m !== 4;
  },

  _isHanddrawPaintBlocked() {
    if (!ble.state.connected) return true;
    const m = Number(this._lastMode || -1);
    if (!Number.isFinite(m) || m < 0) return false;
    if (m !== 4) return true;
    if (this.data.hdGuessRevealBlock) return true;
    return false;
  },

  _syncGuessRevealFromModeResponse(r) {
    const showAns = !!(r && (r.guess_show_answer === true || r.guess_show_answer === 1));
    if (showAns) {
      if (!this.data.hdGuessRevealBlock || this.data.hdGuessPlaying) {
        if (this._hdGuessTimer) {
          try { clearTimeout(this._hdGuessTimer); } catch (_) {}
          this._hdGuessTimer = 0;
        }
        this.setData({
          hdGuessRevealBlock: true,
          hdGuessPlaying: false,
          hdGuessPrompt: "",
          hdGuessStarting: false,
        });
      }
    } else if (this.data.hdGuessRevealBlock) {
      this.setData({ hdGuessRevealBlock: false });
    }
  },

  _stopHanddrawModePoll() {
    if (this._hdModePollId) {
      try { clearInterval(this._hdModePollId); } catch (_) {}
      this._hdModePollId = 0;
    }
  },

  _startHanddrawModePoll() {
    if (this._hdModePollId) return;
    const tick = async () => {
      if (!ble.state.connected) return;
      try {
        const r = await ble.sendJsonStopAndWait({ cmd: "get_mode" }, { timeoutMs: 700, retries: 1 });
        this._syncGuessRevealFromModeResponse(r);
        const m = Number(r && r.mode);
        if (Number.isFinite(m)) {
          this._lastMode = m;
          this._updateHanddrawBlockStateFromMode(m);
        }
      } catch (_) {}
    };
    this._hdModePollId = setInterval(tick, 2200);
    tick();
  },

  async _syncHanddrawMeta() {
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "handdraw_meta" }, { timeoutMs: 1200, retries: 2 });
      if (r && r.status === "ok") {
        const bg = r.bg === "white" ? "white" : "black";
        const hasArt = !!r.has_art;
        this.setData({ hdBg: bg });
        return { bg, hasArt };
      }
    } catch (_) {}
    return null;
  },

  async _syncHanddrawStatus() {
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "handdraw_status" }, { timeoutMs: 1500, retries: 2 });
      if (r && r.status === "ok") {
        const bg = r.bg === "white" ? "white" : "black";
        const hasArt = !!r.bg_locked;
        this.setData({ hdBg: bg });
        return { bg, hasArt };
      }
    } catch (_) {}
    return null;
  },

  async _pullHanddrawBitmapFromDevice() {
    const chunk = 720;
    const out = new Uint8Array(IMG_BYTES);
    let total = 0;
    this.setData({ hdPulling: true, hdPullPercent: 0 });
    try {
      for (let off = 0; off < IMG_BYTES; off += chunk) {
        const len = Math.min(chunk, IMG_BYTES - off);
        const r = await ble.sendJsonStopAndWait({ cmd: "handdraw_pull_chunk", off, len }, { timeoutMs: 2500, retries: 2 });
        if (!r || r.status !== "ok") throw new Error("handdraw_pull_chunk failed");
        const got = Number(r.len) || 0;
        if (got === 0) break;
        const raw = this._hexStringToBytes(r.data || "");
        if (!raw || raw.length < got) throw new Error("handdraw_pull bad hex");
        out.set(raw.subarray(0, got), off);
        total += got;
        const pct = Math.min(100, Math.floor((total * 100) / IMG_BYTES));
        this.setData({ hdPullPercent: pct });
        if (got < len) break;
      }
      if (total !== IMG_BYTES) throw new Error("incomplete handdraw pull " + total + "/" + IMG_BYTES);
      return out;
    } finally {
      this.setData({ hdPulling: false, hdPullPercent: 0 });
    }
  },

  _hexStringToBytes(hex) {
    const s = String(hex || "").trim();
    if (!s.length || s.length % 2 !== 0) return null;
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) {
      const v = parseInt(s.substr(i * 2, 2), 16);
      out[i] = Number.isFinite(v) ? v : 0;
    }
    return out;
  },

  async _attachHanddrawCanvasAndPaint(bytes) {
    this._hdCtx = this._hdCtx || {};
    this._hdLast = this._hdLast || {};
    this._cancelHdBleBatchTimer();
    this._hdBleBatch = null;
    this._hdBleSendChain = Promise.resolve();
    if (!bytes || bytes.length < IMG_BYTES) return;
    try {
      const pack = await getCanvas2dById(this, "canvasDraw", 240);
      const c2d = pack && pack.ctx;
      if (c2d) this._putHanddrawRgb565OnCanvas(c2d, bytes);
      this._hdCtx.canvasDraw = pack;
      this._measureHdCanvasCssSize();
    } catch (_) {}
  },

  async _enterHanddraw() {
    this._handdrawBleReady = false;
    this.setData({ hdPulling: false, hdPullPercent: 0 });
    const meta = await this._syncHanddrawMeta();
    let bgKey = "black";
    let deviceHasArt = false;
    if (meta) {
      bgKey = meta.bg;
      deviceHasArt = !!meta.hasArt;
    }

    const memValid = this._hdRgb565Cache instanceof Uint8Array && this._hdRgb565Cache.length === IMG_BYTES;
    if (!memValid) {
      const fromDisk = this._loadHanddrawFromDisk();
      if (fromDisk) this._hdRgb565Cache = fromDisk;
    }
    const hasLocal = this._hdRgb565Cache instanceof Uint8Array && this._hdRgb565Cache.length === IMG_BYTES;

    if (!deviceHasArt) {
      this._removeHanddrawDiskCache();
      this._hdRgb565Cache = makeSolidHanddrawRgb565(bgKey);
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache);
      this._saveHanddrawToDisk();
    } else if (hasLocal) {
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache);
    } else {
      try {
        const pulled = await this._pullHanddrawBitmapFromDevice();
        this._hdRgb565Cache = pulled;
        await this._attachHanddrawCanvasAndPaint(pulled);
        this._saveHanddrawToDisk();
      } catch (_) {
        this.setData({ hdPulling: false, hdPullPercent: 0 });
        this._hdRgb565Cache = makeSolidHanddrawRgb565(bgKey);
        await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache);
        this._saveHanddrawToDisk();
      }
    }

    this._syncHanddrawStatus().catch(() => {});
    this._handdrawBleReady = true;
  },

  onHdTouchStart(e) {
    if (!ble.state.connected || !this._handdrawBleReady || this._isHanddrawPaintBlocked()) return;
    const id = "canvasDraw";
    const t = e.touches && e.touches[0];
    if (!t) return;
    if (this._hdBleBatch && this._hdBleBatch.length) this._flushHdBleBatchNow();
    const m = this._mapHdTouchTo240(Number(t.x) || 0, Number(t.y) || 0);
    const x = Math.floor(m.x);
    const y = Math.floor(m.y);
    if (!this._hdLast) this._hdLast = {};
    this._hdLast[id] = { x, y };
  },

  onHdTouchMove(e) {
    if (!ble.state.connected || !this._handdrawBleReady || this._isHanddrawPaintBlocked()) return;
    const id = "canvasDraw";
    const prev = this._hdLast && this._hdLast[id];
    if (!prev) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const m = this._mapHdTouchTo240(Number(t.x) || 0, Number(t.y) || 0);
    const x = Math.floor(m.x);
    const y = Math.floor(m.y);
    const m0 = clampHanddrawXY(prev.x, prev.y);
    const m1 = clampHanddrawXY(x, y);
    if (m0.x === m1.x && m0.y === m1.y) return;
    const c = hexToRgb565(this.data.hdPenHex);
    const w = Number(this.data.hdStrokeW) || 4;
    if (!(this._hdRgb565Cache instanceof Uint8Array) || this._hdRgb565Cache.length !== IMG_BYTES) {
      this._hdRgb565Cache = makeSolidHanddrawRgb565(this.data.hdBg || "black");
    }
    handdrawRgb565ApplySegment(this._hdRgb565Cache, m0.x, m0.y, m1.x, m1.y, c, w);
    if (this.data.hdMirror) {
      const mx0 = 239 - m0.x;
      const mx1 = 239 - m1.x;
      handdrawRgb565ApplySegment(this._hdRgb565Cache, mx0, m0.y, mx1, m1.y, c, w);
    }
    this._hdBleBatch = this._hdBleBatch || [];
    const extra = this.data.hdMirror ? 2 : 1;
    if (this._hdBleBatch.length + extra > HD_BLE_BATCH_MAX) {
      this._flushHdBleBatchNow();
    }
    this._hdBleBatch.push({ x0: m0.x, y0: m0.y, x1: m1.x, y1: m1.y, c, w });
    if (this.data.hdMirror) {
      const mx0 = 239 - m0.x;
      const mx1 = 239 - m1.x;
      this._hdBleBatch.push({ x0: mx0, y0: m0.y, x1: mx1, y1: m1.y, c, w });
    }
    this._scheduleHdCanvasPaint();
    this._scheduleHanddrawPersist();
    this._hdLast[id] = { x, y };
  },

  onHdTouchEnd() {
    const id = "canvasDraw";
    this._cancelHdBleBatchTimer();
    this._flushHdBleBatchNow();
    this._hdPaintRafPending = false;
    this._flushHdCanvasPaintNow();
    if (this._hdLast) this._hdLast[id] = null;
    if (!this._isHanddrawPaintBlocked()) this._flushHanddrawPersist();
  },

  /**
   * 与「清屏」按钮一致：丢弃待发笔迹、立刻本地铺底、`handdraw_clear`、按设备背景校正。
   * @param {{ skipClearingUi?: boolean, silentDeviceFail?: boolean }} opts
   * @returns {Promise<{ ok: boolean }>}
   */
  async _handdrawPerformFullClearNoModal(opts) {
    const skipClearingUi = !!(opts && opts.skipClearingUi);
    const silentDeviceFail = !!(opts && opts.silentDeviceFail);
    if (!skipClearingUi) this.setData({ hdClearing: true });
    this._discardHanddrawBlePending();
    const bgLocal = this.data.hdBg || "black";
    try {
      if (this._hdLast) this._hdLast.canvasDraw = null;
      this._hdRgb565Cache = makeSolidHanddrawRgb565(bgLocal);
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache);
      this._flushHanddrawPersist();
    } catch (_) {}
    this._handdrawBleReady = true;
    if (!skipClearingUi) this.setData({ hdClearing: false });

    try {
      await ble.sendJsonStopAndWait({ cmd: "handdraw_clear" }, { timeoutMs: 1500, retries: 2 });
      const st = await this._syncHanddrawStatus();
      const bg = st ? st.bg : bgLocal;
      if (String(bg) !== String(bgLocal)) {
        if (this._hdLast) this._hdLast.canvasDraw = null;
        this._hdRgb565Cache = makeSolidHanddrawRgb565(bg);
        await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache);
        this._flushHanddrawPersist();
      }
      this._handdrawBleReady = true;
      return { ok: true };
    } catch (_) {
      this._handdrawBleReady = true;
      if (!silentDeviceFail) {
        try {
          wx.showToast({ title: "设备清屏未确认", icon: "none" });
        } catch (e2) {}
      }
      return { ok: false };
    }
  },

  async onHdClear() {
    if (!ble.state.connected || this._isHanddrawModeOnlyBlocked()) return;
    try {
      await new Promise((resolve, reject) => {
        wx.showModal({
          title: "清屏确认",
          content: "确定要清屏吗？当前画面将被清空。",
          confirmText: "清屏",
          cancelText: "取消",
          success: (res) => (res && res.confirm ? resolve() : reject(new Error("cancel"))),
          fail: () => reject(new Error("modal fail")),
        });
      });
    } catch (_) {
      return;
    }
    const r = await this._handdrawPerformFullClearNoModal({});
    if (r.ok) {
      this._handdrawBleReady = true;
      const stillPlaying = !!this.data.hdGuessPlaying;
      const wasReveal = !!this.data.hdGuessRevealBlock;
      if (!stillPlaying && this._hdGuessTimer) {
        try { clearTimeout(this._hdGuessTimer); } catch (_) {}
        this._hdGuessTimer = 0;
      }
      const patch = { hdGuessStarting: false };
      if (wasReveal) {
        patch.hdGuessRevealBlock = false;
        patch.hdGuessPlaying = false;
        patch.hdGuessPrompt = "";
      }
      this.setData(patch);
    }
  },

  async _onGuessGameTimeout() {
    this._hdGuessTimer = 0;
    if (!this.data.hdGuessPlaying) return;
    try {
      await ble.sendJsonStopAndWait({ cmd: "guess_game_end" }, { timeoutMs: 1500, retries: 2 });
      this.setData({ hdGuessPlaying: false, hdGuessPrompt: "", hdGuessRevealBlock: true });
    } catch (_) {
      this.setData({ hdGuessPlaying: false, hdGuessPrompt: "" });
    }
    try {
      ble.setHanddrawGuessGameActive(false);
    } catch (_) {}
  },

  async _startGuessGameWithWord(word) {
    const w = String(word || "").trim();
    if (!w) return;
    this.setData({ hdGuessPlaying: true, hdGuessPrompt: w, hdGuessStarting: true });
    try {
      ble.setHanddrawGuessGameActive(true);
    } catch (_) {}
    try {
      await this._handdrawPerformFullClearNoModal({ skipClearingUi: true, silentDeviceFail: true });
      await ble.sendJsonStopAndWait({ cmd: "guess_game_start", word: w, seconds: 180 }, { timeoutMs: 2500, retries: 2 });
      this._handdrawBleReady = true;
    } catch (_) {
      try {
        ble.setHanddrawGuessGameActive(false);
      } catch (e2) {}
      if (this._hdGuessTimer) {
        try { clearTimeout(this._hdGuessTimer); } catch (_) {}
        this._hdGuessTimer = 0;
      }
      this.setData({
        hdGuessPlaying: false,
        hdGuessPrompt: "",
        hdGuessStarting: false,
        hdGuessRevealBlock: false,
      });
      return;
    }
    this.setData({ hdGuessStarting: false, hdGuessRevealBlock: false });
    if (this._hdGuessTimer) {
      try { clearTimeout(this._hdGuessTimer); } catch (_) {}
    }
    this._hdGuessTimer = setTimeout(() => this._onGuessGameTimeout(), 180000);
  },

  async onHdGuessGame() {
    if (!ble.state.connected || this._isHanddrawModeOnlyBlocked() || this.data.hdClearing || this.data.hdGuessStarting) return;
    if (this.data.hdGuessPlaying) {
      if (this._hdGuessTimer) {
        try { clearTimeout(this._hdGuessTimer); } catch (_) {}
        this._hdGuessTimer = 0;
      }
      try {
        await ble.sendJsonStopAndWait({ cmd: "guess_game_end" }, { timeoutMs: 1500, retries: 2 });
        this.setData({ hdGuessPlaying: false, hdGuessPrompt: "", hdGuessRevealBlock: true });
      } catch (_) {
        this.setData({ hdGuessPlaying: false, hdGuessPrompt: "" });
      }
      try {
        ble.setHanddrawGuessGameActive(false);
      } catch (_) {}
      return;
    }
    await this._startGuessGameWithWord(pickRandomGuessWord());
  },

  async onHdGuessSkip() {
    if (!ble.state.connected || this._isHanddrawModeOnlyBlocked() || this.data.hdClearing || this.data.hdGuessStarting) return;
    if (!this.data.hdGuessPlaying) return;
    try {
      await new Promise((resolve, reject) => {
        wx.showModal({
          title: "跳过确认",
          content: "确定要跳过当前物品吗？将更换下一个并重新计时。",
          confirmText: "跳过",
          cancelText: "取消",
          success: (res) => (res && res.confirm ? resolve() : reject(new Error("cancel"))),
          fail: () => reject(new Error("modal fail")),
        });
      });
    } catch (_) {
      return;
    }
    try {
      if (this._hdGuessTimer) {
        try { clearTimeout(this._hdGuessTimer); } catch (_) {}
        this._hdGuessTimer = 0;
      }
      await ble.sendJsonStopAndWait({ cmd: "guess_game_end", reveal: false }, { timeoutMs: 1500, retries: 2 });
    } catch (_) {}
    await this._startGuessGameWithWord(pickRandomGuessWord());
  },

  _stopGuessGameOnLeave() {
    const active =
      this.data && (this.data.hdGuessPlaying || this.data.hdGuessStarting);
    if (!active) return;
    if (this._hdGuessTimer) {
      try { clearTimeout(this._hdGuessTimer); } catch (_) {}
      this._hdGuessTimer = 0;
    }
    try {
      if (ble && ble.state && ble.state.connected) {
        ble
          .sendJsonStopAndWait({ cmd: "guess_game_end", reveal: false }, { timeoutMs: 2200, retries: 2 })
          .catch(() => ble.sendJson({ cmd: "guess_game_end", reveal: false }).catch(() => {}));
      }
    } catch (_) {}
    try {
      this.setData({
        hdGuessPlaying: false,
        hdGuessPrompt: "",
        hdGuessStarting: false,
        hdGuessRevealBlock: true,
      });
    } catch (_) {}
    try {
      ble.setHanddrawGuessGameActive(false);
    } catch (_) {}
  },
});

