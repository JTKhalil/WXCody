import { ble } from "../../services/ble";
import { FrameType } from "../../services/proto_bin";
import { getState as getFwUpgradeState, onStateChange as onFwUpgradeStateChange } from "../../services/fw_upgrade";
import {
  IMG_BYTES,
  thumbCacheGet,
  thumbCacheSet,
  thumbCacheDel,
  subscribeImgPullUi,
  enqueueMissingThumbPulls,
  mergeBusyPullRows,
  startThumbPullImmediate,
} from "../../services/img_thumb_sync";
/** 控制台底部 Tab：手绘、设置（与设备 displayMode 无关） */
const TAB_HANDDRAW = 3;
const TAB_SETTINGS = 4;
// 提速：固件端二进制帧总长度上限为 180B（含头+CRC），当前 ImgPushChunk 负载含 1(slot)+4(off)+data，
// 因此 data 的安全上限约为 180-9(帧开销)-5(字段)=166B。
const CHUNK_BYTES = 166;
/** 手绘 BLE：攒够即发，降低屏相对手机的延迟（过小会增加空口包数） */
/** 与 proto_bin HANDDRAW_BATCH_MAX 一致 */
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

const UPDATE_VERSION_URL = "https://raw.githubusercontent.com/JTKhalil/claudeRobot/main/version.txt";
const UPDATE_FIRMWARE_URL = "https://raw.githubusercontent.com/JTKhalil/claudeRobot/main/firmware.bin";

function le32(v) {
  const x = (v >>> 0);
  return new Uint8Array([x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff]);
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
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

function parseVersionText(text) {
  const s = (text || "").replace(/\r/g, "").trim();
  if (!s) return { version: "", notes: "" };
  const lines = s.split("\n");
  const version = (lines[0] || "").trim();
  const notes = lines.slice(1).join("\n").trim();
  return { version, notes };
}

async function fetchTextWithFallbacks(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 8000;
  const retries = (opts && opts.retries) || 2;
  const cacheBust = (u) => `${u}${u.includes("?") ? "&" : "?"}t=${Date.now()}`;

  // Some networks / devices behave differently between downloadFile and request.
  const tryDownloadFile = async (u) => {
    const dl = await new Promise((resolve, reject) => {
      wx.downloadFile({
        url: u,
        timeout: timeoutMs,
        success: resolve,
        fail: (e) => reject(new Error((e && e.errMsg) || "downloadFile failed")),
      });
    });
    if (dl.statusCode !== 200 || !dl.tempFilePath) throw new Error(`downloadFile status=${dl.statusCode || 0}`);
    const fs = wx.getFileSystemManager();
    return await new Promise((resolve, reject) => {
      fs.readFile({
        filePath: dl.tempFilePath,
        encoding: "utf8",
        success: (x) => resolve(String(x && x.data ? x.data : "")),
        fail: (e) => reject(new Error((e && e.errMsg) || "readFile failed")),
      });
    });
  };

  const tryRequest = async (u) => {
    const res = await new Promise((resolve, reject) => {
      wx.request({
        url: u,
        method: "GET",
        timeout: timeoutMs,
        success: resolve,
        fail: (e) => reject(new Error((e && e.errMsg) || "request failed")),
      });
    });
    if ((res && res.statusCode) !== 200) throw new Error(`request status=${(res && res.statusCode) || 0}`);
    // wx.request may return string or object; version.txt should be plain text
    if (typeof res.data === "string") return res.data;
    return JSON.stringify(res.data || "");
  };

  // Fallback URLs: raw + github raw endpoint
  const fallbacks = [
    url,
    url.replace("s://raw.githubusercontent.com/", "https://raw.github.com/"),
    url.replace("https://raw.githubusercontent.com/", "https://github.com/").replace("/main/", "/raw/main/"),
  ];

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    for (const u0 of fallbacks) {
      const u = cacheBust(u0);
      try {
        return await tryDownloadFile(u);
      } catch (e1) {
        lastErr = e1;
        try {
          return await tryRequest(u);
        } catch (e2) {
          lastErr = e2;
        }
      }
    }
  }
  throw lastErr || new Error("fetchText failed");
}

function cmpVer(a, b) {
  // 按位比较：1.2.10 > 1.2.2
  const pa = String(a || "").trim().split(".").map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
  const pb = String(b || "").trim().split(".").map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function clearAllCachesKeepIdentity() {
  // 清空所有小程序缓存（图片/笔记/设备记录等），但保留本机身份（clientId / deviceName）
  try {
    const info = wx.getStorageInfoSync();
    const keys = (info && info.keys) || [];
    for (const k of keys) {
      if (typeof k !== "string") continue;
      if (!k.startsWith("wxcody_")) continue;
      if (k === "wxcody_client_id") continue;
      if (k === "wxcody_device_name") continue;
      try { wx.removeStorageSync(k); } catch (_) {}
    }
  } catch (_) {}
}

async function getCanvas2d(page) {
  return await new Promise((resolve, reject) => {
    wx.createSelectorQuery()
      .in(page)
      .select("#preview")
      .fields({ node: true, size: true })
      .exec((res) => {
        const node = res && res[0] && res[0].node;
        if (!node) return reject(new Error("canvas node not found"));
        const canvas = node;
        const ctx = canvas.getContext("2d");
        canvas.width = 240;
        canvas.height = 240;
        resolve({ canvas, ctx });
      });
  });
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

function imageDataToRgb565(imageData) {
  const src = imageData.data;
  const out = new Uint8Array(IMG_BYTES);
  let oi = 0;
  for (let i = 0; i < src.length; i += 4) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    const r5 = (r * 31 + 127) / 255;
    const g6 = (g * 63 + 127) / 255;
    const b5 = (b * 31 + 127) / 255;
    const v = ((r5 & 0x1f) << 11) | ((g6 & 0x3f) << 5) | (b5 & 0x1f);
    out[oi++] = v & 0xff;
    out[oi++] = (v >> 8) & 0xff;
  }
  return out;
}

function hexStringToBytes(hex) {
  const s = String(hex || "").trim();
  if (!s.length || s.length % 2 !== 0) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(s.substr(i * 2, 2), 16);
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
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

/** 与固件 handdraw 相同的圆盘笔刷 + Bresenham，写入 RGB565 小端缓冲 */
function handdrawRgb565ApplySegment(bytes, x0, y0, x1, y1, rgb565, widthPx) {
  const kW = 240;
  const kH = 240;
  let wp = Math.max(1, Math.min(24, Number(widthPx) || 2));
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
    // header
    adapterReady: false,
    connected: false,
    deviceId: "",
    status: "-",
    codyName: "",
    log: "",
    showDebug: false,

    activeTab: 0,

    // mode
    modeCurrent: -1,

    // gallery
    imgSlideshowEnabled: true,
    imgInterval: 10,
    uploadLock: false,
    uploadingSlot: -1,
    slots: [
      { slot: 0, status: "-", hasImage: false, previewReady: false, busy: false, progressText: "", progressPct: 0 },
    ],

    // notes
    notes: [],
    notePinnedOrig: -1,
    noteSlideshow: false,
    noteInterval: 10,
    noteEditIndex: -1,
    noteText: "",
    noteCharCount: 0,
    noteCharLeft: 100,

    // settings
    fsTotal: 0,
    fsUsed: 0,
    fsFree: 0,
    fsPercent: 0,
    fwCurrent: "",
    fwLatest: "",
    fwNotes: "",
    fwUpdateAvailable: false,
    fwBusy: false,
    fwBusyMode: "",
    fwPercent: 0,
    fwStatus: "",
    /** 顶部后台升级进度条（更新设置页触发） */
    fwBgRunning: false,
    fwBgPercent: 0,
    fwBgStatus: "",
    brightness: 255,

    hdPenHex: "#ffffff",
    hdStrokeW: 2,
    /** 镜像模式：横向对称绘制 */
    hdMirror: false,
    hdBg: "black",
    hdPalette: ["#000000", "#ffffff", "#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6"],
    hdPulling: false,
    hdPullPercent: 0,
    /** 清屏进行中：设备与本地画板同步完成前显示遮罩 */
    hdClearing: false,
    /** 你画我猜开始：设备清屏与本地画布就绪前显示遮罩 */
    hdGuessStarting: false,
    /** Cody 非手绘模式时盖住画板并禁止绘画 */
    hdDrawBlocked: false,
    hdDrawBlockMsg: "",
    /** 你画我猜：进行中时画板上方显示词语 */
    hdGuessPlaying: false,
    hdGuessPrompt: "",
    /** 设备处于揭晓答案阶段：禁止绘画（可与 get_mode.guess_show_answer 同步） */
    hdGuessRevealBlock: false,
    hdGuessRevealMsg: "本局答案已揭晓，请清屏或开始新游戏后再绘画。",

    confirmOpen: false,
    confirmMsg: "",

    /** 内容未超屏时禁用滚动 */
    canScroll: false,
  },

  // internal
  _uiT: 0,
  _uiDirty: false,
  _slotsCache: null,
  _slotsDirty: false,
  _thumbCtx: null,
  _workCtx: null,
  _confirmAction: "",
  _brightT: 0,
  _unsubs: null,
  _galleryFrameUnsub: null,
  _lastTimeSyncMs: 0,
  _forceThumbRedrawOnce: false,
  _tabLoaded: null,
  _cancelUploadSlots: null,
  _hdCtx: null,
  _hdLast: null,
  _hdCanvasCssSize: 0,
  _handdrawBleReady: false,
  /** 手绘 BLE 写入链，用于清屏/切模式前等待发完 */
  _hdBleSendChain: null,
  /** 与 Cody 一致的 240×240 RGB565 缓存；切换 Tab 保留 */
  _hdRgb565Cache: null,
  _hdPersistT: 0,
  _hdModePollId: 0,
  _hdBleBatch: null,
  _hdBleBatchTimer: 0,
  _hdGuessTimer: 0,
  _hdRgb565PutReuse: null,
  _hdPaintRafPending: false,

  /** 模式切换页：定时拉取 get_mode，同步设备端手动切换 */
  _modePollId: 0,
  _unsubFwUpgrade: null,

  onLoad() {
    this._slotsCache = (this.data.slots || []).map((s) => ({ ...s }));
    this._thumbCtx = {};
    this._cancelUploadSlots = new Set();

    const unsubs = [];

    unsubs.push(ble.onConnectionStateChange((connected) => {
      this.syncState();
      this.setData({ status: connected ? "已连接" : "已断开" });
      if (!connected) {
        this._stopHanddrawModePoll();
        this._stopModePoll();
      }
      this.scheduleUiRefresh(true);
      // 断线时不再保持 modal
      if (!connected) {
        this.setData({
          confirmOpen: false,
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
      if (connected) {
        this._syncTimeFromPhone().catch(() => {});
      }
      // 断连后统一由 services/ble emitConn → reLaunch 连接页，此处不再 redirectTo，避免与 reLaunch 双跳
    }));

    // 不在 onLoad 里注册 onJson/onFrame（防止回调风暴卡 UI）。
    // 需要时在进入对应 Tab 时再注册。

    this._unsubs = unsubs;

    this.syncState();
    this._loadCodyName();
    this._tabLoaded = { 0: false, 1: false, 2: false, 3: false, 4: false };
    // 关键：从 connect 页跳转进来时，BLE 可能已经处于 connected 状态，但不会再触发一次 onConnectionStateChange(true)。
    // 这种情况下需要在进入控制台页时主动同步一次时间，否则要等用户切 tab 才会触发同步。
    if (ble.state.connected) {
      this._syncTimeFromPhone().catch(() => {});
    }

    // 订阅后台固件升级状态（用于控制台顶部进度条）
    try {
      this._applyFwUpgradeState(getFwUpgradeState());
      if (!this._unsubFwUpgrade) {
        this._unsubFwUpgrade = onFwUpgradeStateChange((s) => this._applyFwUpgradeState(s));
      }
    } catch (_) {}
    // 不主动刷新 log，避免大量 setData
    // 初次进入：延迟一次轻量刷新，避免刚跳转就并发 discover/write
    setTimeout(() => {
      this.onRefreshMode().catch(() => {});
      if (this._tabLoaded) this._tabLoaded[0] = true;
    }, 250);
  },

  async onCancelUpload(evt) {
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    if (!Number.isFinite(slot)) return;
    try { this._cancelUploadSlots && this._cancelUploadSlots.add(slot); } catch (_) {}
    try { this.setSlotStatus(slot, "cancelling..."); } catch (_) {}
    try { await ble.sendJsonStopAndWait({ cmd: "img_cancel" }, { timeoutMs: 1200, retries: 2 }); } catch (_) {}
    // 取消上传：若是替换，则保留原图；若是空槽位上传，则清空显示
    const curSlot = (this._slotsCache || this.data.slots || []).find((s) => s.slot === slot);
    const isReplace = !!(curSlot && curSlot.hasImage);
    if (!isReplace) {
      try { thumbCacheDel(slot); } catch (_) {}
      try { await this._clearThumb(slot); } catch (_) {}
    }
    try { this.setData({ uploadLock: false, uploadingSlot: -1 }); } catch (_) {}
    try {
      this._slotsCache = (this._slotsCache || this.data.slots || []).map((s) =>
        (s.slot === slot
          ? { ...s, hasImage: (isReplace ? true : false), previewReady: (isReplace ? s.previewReady : false), busy: false, progressPct: 0, status: "cancelled" }
          : s)
      );
      this._slotsDirty = true;
      this.scheduleUiRefresh(true);
    } catch (_) {}
  },

  _loadCodyName() {
    let nm = "";
    try { nm = String(wx.getStorageSync("wxcody_last_cody_name") || ""); } catch (_) {}
    if (!nm) {
      try {
        const list = wx.getStorageSync("wxcody_known_devices") || [];
        if (Array.isArray(list) && list[0] && list[0].name) nm = String(list[0].name || "");
      } catch (_) {}
    }
    nm = String(nm || "").trim();
    if (!nm) return;
    this.setData({ codyName: nm });
    try { wx.setNavigationBarTitle({ title: `Cody 控制台` }); } catch (_) {}
  },

  onShow() {
    // 去掉左上角 home 胶囊按钮（微信提供的“返回/主页”按钮）
    try { wx.hideHomeButton(); } catch (_) {}
    setTimeout(() => this._updateCanScroll(), 80);
    // 返回页面时：若停留在模式切换页，则立刻刷新一次当前模式并开始同步
    if (Number(this.data.activeTab) === 0) {
      this.onRefreshMode().catch(() => {});
      this._startModePoll();
    }
    // 从「图库设置 / 存储 / 亮度」等子页返回：图库 tab 的 canvas 可能已重建，previewReady 仍为 true 会跳过重绘导致黑屏
    if (Number(this.data.activeTab) === 1 && ble.state.connected) {
      this._forceThumbRedrawOnce = true;
      this._thumbCtx = {};
      this._ensureThumbCanvases();
      setTimeout(() => {
        if (Number(this.data.activeTab) !== 1) return;
        this._ensureThumbFromCacheOrPull().catch(() => {});
      }, 120);
    }
  },

  async _syncTimeFromPhone() {
    if (!ble.state.connected) return;
    const now = Date.now();
    if (this._lastTimeSyncMs && now - this._lastTimeSyncMs < 30 * 1000) return; // 30s 防抖
    this._lastTimeSyncMs = now;
    try {
      const ts = Math.floor(now / 1000);
      await ble.sendJsonStopAndWait({ cmd: "sync_time", timestamp: ts }, { timeoutMs: 1200, retries: 2 });
    } catch (e) {
      ble.log("sync_time FAIL: " + ((e && e.message) || String(e)));
    }
  },

  async _getThumbCtx(slot) {
    const id = "thumb" + slot;
    // 不要盲信缓存：切换 tab 后 canvas 节点会重建，旧 ctx 会失效导致画面一直黑。
    // 这里优先尝试重新获取一次；失败才回退到缓存（避免抖动时完全不可用）。
    let ctx = null;
    try {
      ctx = await getCanvas2dById(this, id, 240);
    } catch (_) {
      ctx = (this._thumbCtx && this._thumbCtx[id]) || null;
      if (!ctx) throw _;
    }
    if (!this._thumbCtx) this._thumbCtx = {};
    this._thumbCtx[id] = ctx;
    return ctx;
  },

  async _getWorkCtx() {
    const id = "workCanvas";
    if (this._workCtx) return this._workCtx;
    const ctx = await getCanvas2dById(this, id, 240);
    this._workCtx = ctx;
    return ctx;
  },

  async _renderThumbFromRgb565(slot, rgb565) {
    const tctx = await this._getThumbCtx(slot);
    const c2d = tctx && tctx.ctx;
    if (!c2d) throw new Error("thumb canvas ctx not ready");
    const imageData = c2d.createImageData(240, 240);
    rgb565ToImageData(rgb565, imageData);
    c2d.putImageData(imageData, 0, 0);
  },

  async _clearThumb(slot) {
    try {
      const tctx = await this._getThumbCtx(slot);
      const c2d = tctx && tctx.ctx;
      if (!c2d) return;
      c2d.clearRect(0, 0, 240, 240);
      // 统一清空成深色底
      c2d.fillStyle = "#111";
      c2d.fillRect(0, 0, 240, 240);
    } catch (_) {}
  },

  onUnload() {
    // 若离开页面时你画我猜仍在进行，主动结束（避免设备端继续计时/锁状态）
    this._stopGuessGameOnLeave();
    if (this._uiT) clearTimeout(this._uiT);
    this._uiT = 0;
    if (this._brightT) clearTimeout(this._brightT);
    this._brightT = 0;
    if (this._galleryFrameUnsub) {
      try { this._galleryFrameUnsub(); } catch (_) {}
      this._galleryFrameUnsub = null;
    }
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
    this._stopModePoll();
    this._stopHanddrawModePoll();
    this._workCtx = null;
    this._hdCtx = null;
    this._hdLast = null;
    const unsubs = this._unsubs || [];
    for (const u of unsubs) {
      try { u(); } catch (_) {}
    }
    this._unsubs = null;
    try { if (this._unsubFwUpgrade) this._unsubFwUpgrade(); } catch (_) {}
    this._unsubFwUpgrade = null;
  },

  _applyFwUpgradeState(s) {
    const st = s || {};
    const running = !!st.running;
    const pct = Number(st.percent);
    const percent = Number.isFinite(pct) ? pct : 0;
    const status = String(st.status || "");
    // 仅控制顶部展示，不影响 settings tab 的 fw* 字段
    if (running || percent > 0) {
      this.setData({ fwBgRunning: running, fwBgPercent: percent, fwBgStatus: status });
    } else if (this.data.fwBgRunning || this.data.fwBgPercent) {
      this.setData({ fwBgRunning: false, fwBgPercent: 0, fwBgStatus: "" });
    }
  },

  onHide() {
    // 返回/离开控制台页时：若你画我猜进行中则停止
    this._stopGuessGameOnLeave();
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

  async onReady() {
    setTimeout(() => this._updateCanScroll(), 80);
  },

  _updateCanScroll() {
    try {
      // 手绘模式页禁止页面滑动（避免影响绘画体验）
      if (Number(this.data.activeTab) === TAB_HANDDRAW) {
        if (this.data.canScroll) this.setData({ canScroll: false });
        return;
      }
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

  noop() {},

  syncState() {
    this.setData({
      adapterReady: ble.state.adapterReady,
      connected: ble.state.connected,
      deviceId: ble.state.deviceId || "",
    });
  },

  scheduleUiRefresh(force = false) {
    // 默认不刷日志（避免 setData 风暴导致 UI 卡死）；仅在展开调试日志时刷新
    // 或 slots 需要刷新时刷新。
    const needLog = !!this.data.showDebug;
    const needSlots = !!this._slotsDirty;
    if (!needLog && !needSlots && !force) return;

    this._uiDirty = true;
    if (this._uiT && !force) return;
    if (this._uiT) clearTimeout(this._uiT);
    this._uiT = setTimeout(() => {
      this._uiT = 0;
      if (!this._uiDirty && !force) return;
      this._uiDirty = false;
      const patch = {};
      if (needLog) patch.log = ble.getLogsText({ maxChars: 2500 });
      if (this._slotsDirty && this._slotsCache) {
        patch.slots = this._slotsCache;
        this._slotsDirty = false;
      }
      // 没有 patch 就不要 setData
      if (Object.keys(patch).length) this.setData(patch);
    }, 120);
  },

  setSlotStatus(slot, status) {
    if (!this._slotsCache) this._slotsCache = (this.data.slots || []).map((s) => ({ ...s }));
    this._slotsCache = (this._slotsCache || []).map((s) => (s.slot === slot ? { ...s, status } : s));
    this._slotsDirty = true;
    this.scheduleUiRefresh();
  },

  setSlotProgress(slot, busy, progressText, progressPct) {
    if (!this._slotsCache) this._slotsCache = (this.data.slots || []).map((s) => ({ ...s }));
    const pct = Math.max(0, Math.min(100, Number.isFinite(Number(progressPct)) ? Number(progressPct) : 0));
    this._slotsCache = (this._slotsCache || []).map((s) =>
      (s.slot === slot ? { ...s, busy: !!busy, progressText: progressText || "", progressPct: pct } : s)
    );
    this._slotsDirty = true;
    this.scheduleUiRefresh();
  },

  _applyImgThumbSyncSnap(snap) {
    for (const ev of snap.events || []) {
      if (ev.type === "pull_ok") {
        this.setSlotProgress(ev.slot, false, "", 0);
        this.setSlotStatus(ev.slot, ev.status || "pull OK");
        const cached = thumbCacheGet(ev.slot);
        if (cached) {
          this._renderThumbFromRgb565(ev.slot, cached)
            .then(() => {
              this._slotsCache = (this._slotsCache || this.data.slots || []).map((s) =>
                (s.slot === ev.slot ? { ...s, hasImage: true, previewReady: true } : s)
              );
              this._slotsDirty = true;
              this.scheduleUiRefresh(true);
            })
            .catch(() => {});
        }
      } else if (ev.type === "pull_fail") {
        this.setSlotProgress(ev.slot, false, "", 0);
        this.setSlotStatus(ev.slot, ev.message || "pull fail");
        this.scheduleUiRefresh(true);
      }
    }
    const meta = snap.slotMeta || {};
    for (const k of Object.keys(meta)) {
      const slot = Number(k);
      const m = meta[k];
      this.setSlotProgress(slot, !!m.busy, "", m.progressPct || 0);
      if (m.status) this.setSlotStatus(slot, m.status);
    }
  },

  async onTab(evt) {
    const tab = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.tab) || 0);
    if (this.data.hdGuessPlaying && tab !== TAB_HANDDRAW) {
      this.setData({ status: "你画我猜进行中，请先结束游戏再切换页面" });
      return;
    }
    const prevTab = Number(this.data.activeTab);
    if (ble.state.connected && prevTab === TAB_HANDDRAW && tab !== TAB_HANDDRAW) {
      try {
        await this._awaitHanddrawBleIdle();
      } catch (_) {}
    }
    if (tab === TAB_HANDDRAW) {
      this._startHanddrawModePoll();
    } else {
      this._stopHanddrawModePoll();
    }
    if (tab === 0) {
      this._startModePoll();
    } else {
      this._stopModePoll();
    }
    // 只 setData 一次，避免切换时 UI 不稳定
    this.setData({ activeTab: tab, status: "切换 Tab -> " + tab }, () => {
      this._updateHanddrawBlockState();
      this._updateCanScroll();
    });
    if (this.data.showDebug) ble.log("UI tab -> " + tab);

    // 默认策略：仅“首次进入该 tab”时刷新，后续切换不重复拉取（避免卡顿/流量浪费）。
    const loaded = !!(this._tabLoaded && this._tabLoaded[tab]);
    if (loaded) {
      // 模式切换页：每次切回都刷新一次，确保设备端手动切模式能同步选中态
      if (tab === 0) {
        try { await this._syncTimeFromPhone(); } catch (_) {}
        await this.onRefreshMode();
      }
      // Gallery: 切回时 canvas 会重建，需要重绘缩略图，但不必再次拉取 image_info
      if (tab === 1) {
        this._ensureGalleryFrameHandler();
        // 切回图库：canvas 可能被重建，但不要立刻清空并触发拉取。
        // 只标记需要重绘，并等待 canvas ctx 准备好后从本地缓存恢复，避免黑屏/闪烁。
        this._forceThumbRedrawOnce = true;
        this._ensureThumbCanvases();
        setTimeout(() => {
          if (Number(this.data.activeTab) !== 1) return;
          this._ensureThumbFromCacheOrPull().catch(() => {});
        }, 120);
      }
      if (tab === TAB_HANDDRAW) {
        await this._quickRefreshHanddrawTab();
      }
      return;
    }

    try {
      if (tab === 0) {
        try { await this._syncTimeFromPhone(); } catch (_) {}
        await this.onRefreshMode();
      } else if (tab === 1) {
        await this.onRefreshImgConfig();
        this._ensureGalleryFrameHandler();
        // 关键：切 Tab 后 canvas 节点会重建，必须丢弃旧 ctx 缓存，否则会“画到旧 ctx 上”导致新画布一直黑
        this._thumbCtx = {};
        // 切回图库：强制要求重绘一次（即使 previewReady=true）
        this._forceThumbRedrawOnce = true;
        this._ensureThumbCanvases();
        await this.onRefreshImageInfo();
      } else if (tab === 2) {
        await this.onRefreshNotes();
      } else if (tab === TAB_HANDDRAW) {
        await this._enterHanddrawTab(tab);
      } else if (tab === TAB_SETTINGS) {
        await this.onRefreshFs();
        await this.onCheckUpdate();
      }
    } catch (_) {}
    if (this._tabLoaded) this._tabLoaded[tab] = true;
    this.scheduleUiRefresh(true);
    this._updateCanScroll();
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
    } catch (e) {
      ble.log("handdraw_status FAIL: " + ((e && e.message) || String(e)));
    }
    return null;
  },

  /** 不依赖手绘模式；用于首屏决策（背景、是否有稿） */
  async _syncHanddrawMeta() {
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "handdraw_meta" }, { timeoutMs: 1200, retries: 2 });
      if (r && r.status === "ok") {
        const bg = r.bg === "white" ? "white" : "black";
        const hasArt = !!r.has_art;
        this.setData({ hdBg: bg });
        return { bg, hasArt };
      }
    } catch (e) {
      ble.log("handdraw_meta FAIL: " + ((e && e.message) || String(e)));
    }
    return null;
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
    } catch (e) {
      try {
        ble.log("handdraw cache save: " + ((e && e.errMsg) || (e && e.message) || String(e)));
      } catch (_) {}
    }
  },

  _removeHanddrawDiskCache() {
    const deviceId = String((ble.state.deviceId || this.data.deviceId || "").trim());
    if (!deviceId) return;
    try {
      const fs = wx.getFileSystemManager();
      fs.unlinkSync(handdrawCachePath(deviceId));
    } catch (_) {
      /* 不存在则忽略 */
    }
  },

  _scheduleHanddrawPersist() {
    if (this._hdPersistT) {
      try {
        clearTimeout(this._hdPersistT);
      } catch (_) {}
      this._hdPersistT = 0;
    }
    this._hdPersistT = setTimeout(() => {
      this._hdPersistT = 0;
      this._saveHanddrawToDisk();
    }, 380);
  },

  _flushHanddrawPersist() {
    if (this._hdPersistT) {
      try {
        clearTimeout(this._hdPersistT);
      } catch (_) {}
      this._hdPersistT = 0;
    }
    this._saveHanddrawToDisk();
  },

  _updateHanddrawBlockState() {
    const tab = Number(this.data.activeTab);
    const m = Number(this.data.modeCurrent);
    const connected = !!ble.state.connected;
    const blocked = connected && tab === TAB_HANDDRAW && Number.isFinite(m) && m >= 0 && m !== 4;
    const msg =
      "Cody 当前不是手绘模式，画板已锁定。请先在「模式」中切换为「手绘模式」，或在设备上切至手绘后再绘画。";
    if (this.data.hdDrawBlocked !== blocked || this.data.hdDrawBlockMsg !== msg) {
      this.setData({ hdDrawBlocked: blocked, hdDrawBlockMsg: msg });
    }
  },

  /** 与 hdDrawBlocked 一致；未同步到 mode 前（modeCurrent&lt;0）不拦截，避免首屏误锁 */
  _isHanddrawPaintBlocked() {
    if (Number(this.data.activeTab) !== TAB_HANDDRAW) return false;
    if (!ble.state.connected) return true;
    const m = Number(this.data.modeCurrent);
    if (!Number.isFinite(m) || m < 0) return false;
    if (m !== 4) return true;
    if (this.data.hdGuessRevealBlock) return true;
    return false;
  },

  /** 仅手绘模式不对时拦截（不含揭晓锁），用于清屏 / 开始结束你画我猜 */
  _isHanddrawModeOnlyBlocked() {
    if (!ble.state.connected) return true;
    const m = Number(this.data.modeCurrent);
    if (!Number.isFinite(m) || m < 0) return false;
    return m !== 4;
  },

  _syncGuessRevealFromModeResponse(r) {
    const showAns = !!(r && (r.guess_show_answer === true || r.guess_show_answer === 1));
    if (showAns) {
      if (!this.data.hdGuessRevealBlock || this.data.hdGuessPlaying) {
        if (this._hdGuessTimer) {
          try {
            clearTimeout(this._hdGuessTimer);
          } catch (_) {}
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
      try {
        clearInterval(this._hdModePollId);
      } catch (_) {}
      this._hdModePollId = 0;
    }
  },

  _startHanddrawModePoll() {
    if (this._hdModePollId) return;
    const tick = async () => {
      if (Number(this.data.activeTab) !== TAB_HANDDRAW || !ble.state.connected) return;
      try {
        const r = await ble.sendJsonStopAndWait({ cmd: "get_mode" }, { timeoutMs: 700, retries: 1 });
        this._syncGuessRevealFromModeResponse(r);
        const m = Number(r && r.mode);
        if (Number.isFinite(m) && m !== Number(this.data.modeCurrent)) {
          this.setData({ modeCurrent: m }, () => this._updateHanddrawBlockState());
        } else {
          this._updateHanddrawBlockState();
        }
      } catch (_) {
        this._updateHanddrawBlockState();
      }
    };
    this._hdModePollId = setInterval(tick, 2200);
    tick();
  },

  _stopModePoll() {
    if (this._modePollId) {
      try { clearInterval(this._modePollId); } catch (_) {}
      this._modePollId = 0;
    }
  },

  _startModePoll() {
    if (this._modePollId) return;
    const tick = async () => {
      if (Number(this.data.activeTab) !== 0 || !ble.state.connected) return;
      try {
        const r = await ble.sendJsonStopAndWait({ cmd: "get_mode" }, { timeoutMs: 700, retries: 1 });
        this._syncGuessRevealFromModeResponse(r);
        const m = Number(r && r.mode);
        if (Number.isFinite(m) && m !== Number(this.data.modeCurrent)) {
          this.setData({ modeCurrent: m }, () => this._updateHanddrawBlockState());
        }
      } catch (_) {}
    };
    this._modePollId = setInterval(tick, 1200);
    tick();
  },

  /**
   * 再次进入手绘 Tab：不重拉 meta/整图，优先用缓存同步重绘画布（不主动 set_mode，由用户在设备或「模式」里切手绘）。
   */
  async _quickRefreshHanddrawTab() {
    const cacheOk = this._hdRgb565Cache instanceof Uint8Array && this._hdRgb565Cache.length === IMG_BYTES;
    if (!cacheOk) {
      await this._enterHanddrawTab(TAB_HANDDRAW);
      return;
    }
    try {
      const pack = this._hdCtx && this._hdCtx.canvasDraw;
      const c2d = pack && pack.ctx;
      if (c2d) {
        this._putHanddrawRgb565OnCanvas(c2d, this._hdRgb565Cache);
      } else {
        await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, TAB_HANDDRAW);
      }
    } catch (_) {
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, TAB_HANDDRAW);
    }
    this._handdrawBleReady = true;
    this._syncHanddrawStatus().catch(() => {});
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "get_mode" }, { timeoutMs: 800, retries: 1 });
      const m = Number(r && r.mode);
      if (Number.isFinite(m)) this.setData({ modeCurrent: m }, () => this._updateHanddrawBlockState());
      else this._updateHanddrawBlockState();
    } catch (_) {
      this._updateHanddrawBlockState();
    }
  },

  async _enterHanddrawTab(tab) {
    this._handdrawBleReady = false;
    const tabNum = Number(tab);
    if (tabNum !== TAB_HANDDRAW) return;

    this.setData({ hdPulling: false, hdPullPercent: 0 });

    const meta = await this._syncHanddrawMeta();
    let bgKey = "black";
    let deviceHasArt = false;
    if (meta) {
      bgKey = meta.bg;
      deviceHasArt = !!meta.hasArt;
    } else {
      bgKey = "black";
      deviceHasArt = false;
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
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, tabNum);
      this._saveHanddrawToDisk();
    } else if (hasLocal) {
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, tabNum);
    } else {
      try {
        const pulled = await this._pullHanddrawBitmapFromDevice();
        this._hdRgb565Cache = pulled;
        await this._attachHanddrawCanvasAndPaint(pulled, tabNum);
        this._saveHanddrawToDisk();
      } catch (e) {
        ble.log("handdraw pull FAIL: " + ((e && e.message) || String(e)));
        this.setData({ hdPulling: false, hdPullPercent: 0 });
        this._hdRgb565Cache = makeSolidHanddrawRgb565(bgKey);
        await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, tabNum);
        this._saveHanddrawToDisk();
      }
    }

    this._syncHanddrawStatus().catch(() => {});
    this._handdrawBleReady = true;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "get_mode" }, { timeoutMs: 800, retries: 1 });
      const m = Number(r && r.mode);
      if (Number.isFinite(m)) this.setData({ modeCurrent: m }, () => this._updateHanddrawBlockState());
      else this._updateHanddrawBlockState();
    } catch (_) {
      this._updateHanddrawBlockState();
    }
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
        const raw = hexStringToBytes(r.data || "");
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

  async _attachHanddrawCanvasAndPaint(bytes, forTab) {
    const tab = forTab !== undefined && forTab !== null ? Number(forTab) : Number(this.data.activeTab);
    if (tab !== TAB_HANDDRAW) return;
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
      // 记录当前画板显示尺寸，用于触摸坐标映射（画布 CSS 可能被放大）
      this._measureHdCanvasCssSize();
    } catch (e) {
      ble.log("handdraw canvas attach FAIL: " + ((e && e.message) || String(e)));
    }
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
    if (css > 0) {
      return { x: (x * 240) / css, y: (y * 240) / css };
    }
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
    const value = Math.max(2, Math.min(16, Number.isFinite(v) ? v : 2));
    this.setData({ hdStrokeW: value });
  },

  onHdMirrorToggle(evt) {
    const v = !!(evt && evt.detail && evt.detail.value);
    this.setData({ hdMirror: v });
  },

  _cancelHdBleBatchTimer() {
    if (this._hdBleBatchTimer) {
      try {
        clearTimeout(this._hdBleBatchTimer);
      } catch (_) {}
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
        for (const s of copy) {
          p = p.then(() => ble.sendHanddrawStrokeBin(s, batchGen));
        }
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
    this._hdBleSendChain = (this._hdBleSendChain || Promise.resolve()).then(run).catch((err) => {
      ble.log("draw_stroke batch FAIL: " + ((err && err.message) || String(err)));
    });
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

  _discardHanddrawBlePending() {
    try {
      if (typeof ble.bumpHanddrawStrokeGeneration === "function") ble.bumpHanddrawStrokeGeneration();
    } catch (_) {}
    this._cancelHdBleBatchTimer();
    this._hdBleBatch = null;
    this._hdBleSendChain = Promise.resolve();
  },

  onHdTouchStart(e) {
    if (!ble.state.connected || !this._handdrawBleReady || this._isHanddrawPaintBlocked()) return;
    const id = "canvasDraw";
    const t = e.touches && e.touches[0];
    if (!t) return;
    if (this._hdBleBatch && this._hdBleBatch.length) {
      this._flushHdBleBatchNow();
    }
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
    const w = Number(this.data.hdStrokeW) || 2;
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
      await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, TAB_HANDDRAW);
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
        await this._attachHanddrawCanvasAndPaint(this._hdRgb565Cache, TAB_HANDDRAW);
        this._flushHanddrawPersist();
      }
      this._handdrawBleReady = true;
      return { ok: true };
    } catch (err) {
      if (!silentDeviceFail) {
        this.setData({ status: "清屏失败（需处于手绘模式）" });
        ble.log("handdraw_clear FAIL: " + ((err && err.message) || String(err)));
      }
      this._handdrawBleReady = true;
      return { ok: false };
    }
  },

  async onHdClear() {
    if (!ble.state.connected || this._isHanddrawModeOnlyBlocked()) return;
    // 二次确认，避免误触清屏（清屏会影响设备端与本地画板）
    try {
      await new Promise((resolve, reject) => {
        wx.showModal({
          title: "清屏确认",
          content: "确定要清屏吗？当前画面将被清空。",
          confirmText: "清屏",
          cancelText: "取消",
          success: (res) => {
            if (res && res.confirm) resolve();
            else reject(new Error("cancel"));
          },
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
        try {
          clearTimeout(this._hdGuessTimer);
        } catch (_) {}
        this._hdGuessTimer = 0;
      }
      const patch = {
        status: "已清屏（可再换背景）",
        hdGuessStarting: false,
      };
      if (wasReveal) {
        patch.hdGuessRevealBlock = false;
        patch.hdGuessPlaying = false;
        patch.hdGuessPrompt = "";
      }
      this.setData(patch);
    }
    this.scheduleUiRefresh(true);
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
    this.scheduleUiRefresh(true);
  },

  async _startGuessGameWithWord(word) {
    const w = String(word || "").trim();
    if (!w) return;
    this.setData({ hdGuessPlaying: true, hdGuessPrompt: w, hdGuessStarting: true, status: "你画我猜进行中" });
    try {
      ble.setHanddrawGuessGameActive(true);
    } catch (_) {}
    try {
      await this._handdrawPerformFullClearNoModal({ skipClearingUi: true, silentDeviceFail: true });
      // 重新开始一局（用于首次开始与“跳过”）
      await ble.sendJsonStopAndWait({ cmd: "guess_game_start", word: w, seconds: 180 }, { timeoutMs: 2500, retries: 2 });
      this._handdrawBleReady = true;
    } catch (e) {
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
        status: "你画我猜开始失败（需设备为手绘模式且固件支持）",
      });
      ble.log("guess_game_start FAIL: " + ((e && e.message) || String(e)));
      this.scheduleUiRefresh(true);
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
      } catch (e) {
        ble.log("guess_game_end FAIL: " + ((e && e.message) || String(e)));
        this.setData({ hdGuessPlaying: false, hdGuessPrompt: "" });
      }
      try {
        ble.setHanddrawGuessGameActive(false);
      } catch (_) {}
      this.scheduleUiRefresh(true);
      return;
    }
    await this._startGuessGameWithWord(pickRandomGuessWord());
    this.scheduleUiRefresh(true);
  },

  async onHdGuessSkip() {
    if (!ble.state.connected || this._isHanddrawModeOnlyBlocked() || this.data.hdClearing || this.data.hdGuessStarting) return;
    if (!this.data.hdGuessPlaying) return;
    // 二次确认，避免误触跳过导致重置计时与清空画板
    try {
      await new Promise((resolve, reject) => {
        wx.showModal({
          title: "跳过确认",
          content: "确定要跳过当前物品吗？将更换下一个并重新计时。",
          confirmText: "跳过",
          cancelText: "取消",
          success: (res) => {
            if (res && res.confirm) resolve();
            else reject(new Error("cancel"));
          },
          fail: () => reject(new Error("modal fail")),
        });
      });
    } catch (_) {
      return;
    }
    // 先结束当前一局，再用新词重新开始并重置计时
    try {
      if (this._hdGuessTimer) {
        try { clearTimeout(this._hdGuessTimer); } catch (_) {}
        this._hdGuessTimer = 0;
      }
      await ble.sendJsonStopAndWait({ cmd: "guess_game_end", reveal: false }, { timeoutMs: 1500, retries: 2 });
    } catch (_) {}
    await this._startGuessGameWithWord(pickRandomGuessWord());
    this.scheduleUiRefresh(true);
  },

  _ensureGalleryFrameHandler() {
    if (this._galleryFrameUnsub) return;
    this._galleryFrameUnsub = subscribeImgPullUi((snap) => this._applyImgThumbSyncSnap(snap));
  },

  _ensureThumbCanvases() {
    setTimeout(async () => {
      const slots = (this._slotsCache || this.data.slots || []);
      for (const s of slots) {
        const slot = s.slot;
        const id = "thumb" + slot;
        if (this._thumbCtx && this._thumbCtx[id]) continue;
        try {
          const ctx = await getCanvas2dById(this, id, 240);
          if (!this._thumbCtx) this._thumbCtx = {};
          this._thumbCtx[id] = ctx;
        } catch (_) {
          // ignore
        }
      }
    }, 50);
  },

  onOpenModeSettings(evt) {
    const mode = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.mode) ?? -1);
    if (mode === 0) {
      wx.navigateTo({ url: "/pages/mode/image/image" });
      return;
    }
    if (mode === 2) {
      wx.navigateTo({ url: "/pages/mode/note/note" });
      return;
    }
    if (mode === 4) {
      wx.navigateTo({ url: "/pages/mode/handdraw/handdraw" });
      return;
    }
    wx.showToast({ title: "功能还未开放", icon: "none" });
  },

  onOpenSystemSettings(evt) {
    const page = String((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.page) || "").trim();
    const map = {
      conn: "/pages/settings/conn",
      fs: "/pages/settings/fs",
      fw: "/pages/settings/fw",
      bright: "/pages/settings/bright",
      danger: "/pages/settings/danger",
    };
    const url = map[page];
    if (!url) return;
    wx.navigateTo({ url });
  },

  async onReconnect() {
    try {
      this.setData({ status: "重连中..." });
      await ble.reconnect();
      this.syncState();
      this.setData({ status: "重连成功" });
      ble.log("reconnect OK");
    } catch (e) {
      this.syncState();
      this.setData({ status: "重连失败" });
      ble.log("reconnect FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh(true);
  },

  async onCopyLogs() {
    try {
      await ble.copyLogs({ maxChars: 20000 });
      this.setData({ status: "日志已复制" });
    } catch (e) {
      this.setData({ status: "复制失败" });
      ble.log("copyLogs FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh(true);
  },

  onClearLogs() {
    ble.clearLogs();
    this.scheduleUiRefresh(true);
  },

  onToggleDebug() {
    this.setData({ showDebug: !this.data.showDebug });
    // 展开时刷新一次日志
    if (!this.data.showDebug) return;
    this.scheduleUiRefresh(true);
  },

  // ---------------- Mode ----------------
  async onRefreshMode() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "get_mode" }, { timeoutMs: 800, retries: 3 });
      this._syncGuessRevealFromModeResponse(r);
      const m = Number(r && r.mode);
      if (Number.isFinite(m)) {
        this.setData({ modeCurrent: m, status: "模式已刷新" }, () => this._updateHanddrawBlockState());
      } else {
        this.setData({ status: "模式已刷新" }, () => this._updateHanddrawBlockState());
      }
    } catch (e) {
      ble.log("get_mode FAIL: " + ((e && e.message) || String(e)));
      this.setData({ status: "刷新模式失败" }, () => this._updateHanddrawBlockState());
    }
    this.scheduleUiRefresh();
  },

  async onSetMode(evt) {
    if (!ble.state.connected) return;
    if (this.data.hdGuessPlaying) {
      this.setData({ status: "你画我猜进行中，请先结束游戏再切换模式" });
      return;
    }
    const mode = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.mode) || 0);
    const cur = Number(this.data.modeCurrent);
    if (Number.isFinite(cur) && cur === 4 && mode !== 4) {
      try {
        await this._awaitHanddrawBleIdle();
      } catch (_) {}
    }
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "set_mode", mode }, { timeoutMs: 800, retries: 3 });
      if (r && r.status === "ok") {
        this.setData({ modeCurrent: mode, status: "切换成功" }, () => this._updateHanddrawBlockState());
      } else if (r && r.msg === "handdraw_transfer_busy") {
        this.setData({ status: "笔迹同步中，请稍后再切模式" }, () => this._updateHanddrawBlockState());
      } else if (r && r.msg === "guess_game_active") {
        this.setData({ status: "你画我猜进行中，请先结束游戏再切换模式" }, () => this._updateHanddrawBlockState());
      } else {
        this.setData({ status: "切换失败" }, () => this._updateHanddrawBlockState());
      }
    } catch (e) {
      ble.log("set_mode FAIL: " + ((e && e.message) || String(e)));
      this.setData({ status: "切换失败" }, () => this._updateHanddrawBlockState());
    }
    this.scheduleUiRefresh();
  },

  // ---------------- Gallery config ----------------
  async onRefreshImgConfig() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "slideshow_config" }, { timeoutMs: 800, retries: 3 });
      if (r && typeof r.enabled === "boolean") this.setData({ imgSlideshowEnabled: !!r.enabled });
      if (r && (r.interval || r.interval === 0)) this.setData({ imgInterval: Number(r.interval) || 10 });
    } catch (e) {
      ble.log("slideshow_config FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh();
  },

  async onImgSlideshowToggle(evt) {
    const enabled = !!(evt && evt.detail && evt.detail.value);
    this.setData({ imgSlideshowEnabled: enabled });
    if (!ble.state.connected) return;
    try {
      await ble.sendJsonStopAndWait({ cmd: "set_img_slideshow", enabled }, { timeoutMs: 800, retries: 3 });
    } catch (e) {
      ble.log("set_img_slideshow FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh();
  },

  onImgIntervalChanging(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    if (Number.isFinite(v)) this.setData({ imgInterval: v });
  },

  async onImgIntervalChange(evt) {
    const v = Number(evt && evt.detail && evt.detail.value);
    const value = Math.max(3, Math.min(60, Number.isFinite(v) ? v : 10));
    this.setData({ imgInterval: value });
    if (!ble.state.connected) return;
    try {
      await ble.sendJsonStopAndWait({ cmd: "set_interval", value }, { timeoutMs: 800, retries: 3 });
    } catch (e) {
      ble.log("set_interval FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh();
  },

  async onRefreshImageInfo() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "image_info" }, { timeoutMs: 1200, retries: 3 });
      const indices = Array.isArray(r && r.indices) ? r.indices : null;
      const boolSlots = Array.isArray(r && r.slots) ? r.slots : null; // fallback

      const fsFreeB = Number(r && r.fs_free_b);
      const imgBytes = Number(r && r.img_bytes) || IMG_BYTES;
      const canAdd = (r && typeof r.can_add === "boolean") ? !!r.can_add : (Number.isFinite(fsFreeB) ? fsFreeB >= imgBytes : true);
      const nextSlot = Number.isFinite(Number(r && r.next_slot)) ? Number(r.next_slot) : -1;

      // 目标：初始 1 个槽位；每次上传完成后若还能放下一张则增加一个空槽位。
      // 这里用“已有图片索引 + (canAdd?1:0)”生成槽位列表。
      let used = [];
      if (indices) {
        used = indices.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
      } else if (boolSlots) {
        used = boolSlots.map((v, i) => (v ? i : -1)).filter((x) => x >= 0);
      }
      const slotsOut = [];
      for (const s of used) {
        const prev = (this._slotsCache || []).find((x) => x.slot === s) || (this.data.slots || []).find((x) => x.slot === s);
        slotsOut.push({
          slot: s,
          status: (prev && prev.status) || "-",
          hasImage: true,
          previewReady: !!(prev && prev.previewReady),
          busy: !!(prev && prev.busy),
          progressText: (prev && prev.progressText) || "",
          progressPct: Number.isFinite(prev && prev.progressPct) ? prev.progressPct : 0,
        });
      }
      if (canAdd) {
        const s = (nextSlot >= 0) ? nextSlot : ((used.length ? (Math.max(...used) + 1) : 0));
        const prev = (this._slotsCache || []).find((x) => x.slot === s) || (this.data.slots || []).find((x) => x.slot === s);
        slotsOut.push({
          slot: s,
          status: (prev && prev.status) || "-",
          hasImage: false,
          previewReady: false,
          busy: !!(prev && prev.busy),
          progressText: (prev && prev.progressText) || "",
          progressPct: Number.isFinite(prev && prev.progressPct) ? prev.progressPct : 0,
        });
      }

      // 关键：上传/拉取过程中，固件端 image_info 可能还没把“正在传输的 slot”计入 indices/next_slot，
      // 但 UI 仍需要保持该 slot 的 busy/progress，不要每次刷新都丢失进度导致看起来从 0 重新开始。
      const prevSlotsAll = (this._slotsCache || []).length ? (this._slotsCache || []) : (this.data.slots || []);
      for (const ps of prevSlotsAll) {
        if (!ps || !ps.busy) continue;
        if (slotsOut.find((x) => x.slot === ps.slot)) continue;
        slotsOut.push({ ...ps });
      }
      mergeBusyPullRows(slotsOut);
      if (!slotsOut.length) {
        slotsOut.push({ slot: 0, status: "-", hasImage: false, previewReady: false, busy: false, progressText: "", progressPct: 0 });
      }

      this._slotsCache = slotsOut;
      // 在图库 tab 内优先立即 setData，让 canvas 节点尽快渲染出来（否则后续 getCanvas2dById 可能拿不到）
      if (Number(this.data.activeTab) === 1) {
        this.setData({ slots: slotsOut });
      } else {
        this._slotsDirty = true;
        this.scheduleUiRefresh(true);
      }

      this._ensureThumbCanvases();
      await this._ensureThumbFromCacheOrPull();
    } catch (e) {
      ble.log("image_info FAIL: " + ((e && e.message) || String(e)));
    }
  },

  async _ensureThumbFromCacheOrPull() {
    const slots = this._slotsCache || this.data.slots || [];
    let changed = false;
    for (const s of slots) {
      if (!s || !s.hasImage) continue;
      // 切回图库时强制重绘一次（否则会出现“画布黑但 previewReady=true”导致永不重绘）
      if (!this._forceThumbRedrawOnce && s.previewReady) continue;
      // 上传/拉取过程中切 tab 可能导致 canvas 重建；允许 busy 时也从本地缓存恢复预览
      const cached = thumbCacheGet(s.slot);
      if (cached) {
        try {
          await this._renderThumbFromRgb565(s.slot, cached);
          this._slotsCache = (this._slotsCache || this.data.slots || []).map((x) =>
            (x.slot === s.slot ? { ...x, previewReady: true } : x)
          );
          changed = true;
        } catch (e) {
          // 渲染失败常见原因：切 tab 后 canvas ctx 还没 ready。
          // 这时不要立刻走拉取（会导致“缓存图片也刷新/甚至黑屏”），而是稍后重试一次。
          const msg = String((e && e.message) || "");
          const notReady = msg.includes("canvas node not found") || msg.includes("ctx not ready") || msg.includes("not ready");
          if (notReady) {
            setTimeout(() => {
              if (Number(this.data.activeTab) !== 1) return;
              this._forceThumbRedrawOnce = true;
              this._ensureThumbCanvases();
              this._ensureThumbFromCacheOrPull().catch(() => {});
            }, 120);
          }
        }
      }
    }
    this._forceThumbRedrawOnce = false;
    if (changed) {
      this._slotsDirty = true;
      this.scheduleUiRefresh(true);
    }
    enqueueMissingThumbPulls(slots);
  },

  // ---------------- Gallery pull/push (binary frames) ----------------
  async onPull(evt) {
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    if (!ble.state.connected) return;
    await startThumbPullImmediate(slot);
  },

  async onPush(evt) {
    const from = (evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.from) || "";
    // 防误触：只有点击“上传/替换”按钮才允许进入选择图片流程
    if (from !== "btn") return;
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    if (!ble.state.connected) return;
    if (this.data.uploadLock && this.data.uploadingSlot !== slot) {
      wx.showToast({ title: "上传中，请稍候", icon: "none" });
      return;
    }
    try {
      try { this._cancelUploadSlots && this._cancelUploadSlots.delete(slot); } catch (_) {}
      try { this.setData({ uploadLock: true, uploadingSlot: slot }); } catch (_) {}

      // 替换：不要一开始就删旧图；等新图片准备好、真正开始上传前再删除
      const curSlot = (this._slotsCache || this.data.slots || []).find((s) => s.slot === slot);
      const isReplace = !!(curSlot && curSlot.hasImage);

      this.setSlotStatus(slot, "choosing...");
      const r = await new Promise((resolve, reject) => {
        wx.chooseMedia({
          count: 1,
          mediaType: ["image"],
          sourceType: ["album", "camera"],
          success: resolve,
          fail: (e) => reject(new Error((e && e.errMsg) || "chooseMedia failed")),
        });
      });
      const filePath = r && r.tempFiles && r.tempFiles[0] && r.tempFiles[0].tempFilePath;
      if (!filePath) throw new Error("no image selected");

      // 关键：使用隐藏 work canvas 做缩放与取像素，避免覆盖当前缩略图（替换失败/取消仍保留原图显示）
      const wctx = await this._getWorkCtx();
      const canvas = wctx && wctx.canvas;
      const ctx2d = wctx && wctx.ctx;
      if (!canvas || !ctx2d) throw new Error("thumb canvas ctx not ready");

      this.setSlotStatus(slot, "resizing...");

      const img = canvas.createImage();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image load failed"));
        img.src = filePath;
      });

      const sw = img.width;
      const sh = img.height;
      const s = Math.min(sw, sh);
      const sx = Math.floor((sw - s) / 2);
      const sy = Math.floor((sh - s) / 2);
      ctx2d.clearRect(0, 0, 240, 240);
      // 关键：先铺底色再画图，避免 PNG 透明区域转 RGB565 后变黑（导致设备端看起来像黑屏）
      ctx2d.fillStyle = "#fff";
      ctx2d.fillRect(0, 0, 240, 240);
      ctx2d.drawImage(img, sx, sy, s, s, 0, 0, 240, 240);

      const imageData = ctx2d.getImageData(0, 0, 240, 240);
      const rgb565 = imageDataToRgb565(imageData);

      this.setSlotProgress(slot, true, "", 0);
      this.setSlotStatus(slot, "pushing...");
      await ble.sendFrameStopAndWait(
        FrameType.ImgPushBegin,
        new Uint8Array([slot & 0xff, ...le32(IMG_BYTES)]),
        { timeoutMs: 1200, retries: 3 }
      );

      // 图片上传在部分手机上“窗口并发”会更慢（系统 BLE 写队列拥塞导致 ACK 变慢）。
      // 这里恢复为停等（每块等 ACK），保证稳定吞吐与进度显示一致。
      let lastUi = 0;
      for (let off = 0; off < rgb565.length; off += CHUNK_BYTES) {
        if (this._cancelUploadSlots && this._cancelUploadSlots.has(slot)) {
          try { await ble.sendJsonStopAndWait({ cmd: "img_cancel" }, { timeoutMs: 1200, retries: 2 }); } catch (_) {}
          throw new Error("cancelled");
        }
        const chunk = rgb565.subarray(off, Math.min(rgb565.length, off + CHUNK_BYTES));
        const pl = new Uint8Array(1 + 4 + chunk.length);
        pl[0] = slot & 0xff;
        pl.set(le32(off), 1);
        pl.set(chunk, 5);
        await ble.sendFrameStopAndWait(FrameType.ImgPushChunk, pl, { timeoutMs: 1500, retries: 5 });
        const now = Date.now();
        if (now - lastUi >= 80 || off + chunk.length >= rgb565.length) {
          lastUi = now;
          const pct = Math.floor(((off + chunk.length) * 100) / IMG_BYTES);
          this.setSlotProgress(slot, true, "", pct);
        }
      }

      await ble.sendFrameStopAndWait(
        FrameType.ImgPushFinish,
        new Uint8Array([slot & 0xff, ...le32(IMG_BYTES)]),
        { timeoutMs: 1200, retries: 3 }
      );
      this.setSlotStatus(slot, "push OK");
      this.setSlotProgress(slot, false, "", 0);
      // 上传成功：本地缓存一份（下次无需拉取预览）
      thumbCacheSet(slot, rgb565);
      // 兜底：确保槽位预览立即可见（避免仅靠 drawImage 的临时画面在某些机型上不落地）
      try { await this._renderThumbFromRgb565(slot, rgb565); } catch (_) {}
      this._slotsCache = (this._slotsCache || this.data.slots || []).map((s) =>
        (s.slot === slot ? { ...s, hasImage: true, previewReady: true } : s)
      );
      this._slotsDirty = true;
      ble.log(`PUSH_FINISH slot${slot} OK`);
      this.scheduleUiRefresh(true);
      // 上传后刷新 image_info：生成下一个空槽位（若空间不足则不新增）
      this.onRefreshImageInfo().catch(() => {});
    } catch (e) {
      this.setSlotProgress(slot, false, "", 0);
      const msg = (e && e.message) || String(e);
      this.setSlotStatus(slot, msg === "cancelled" ? "cancelled" : "push fail");
      ble.log("PUSH FAIL: " + ((e && e.message) || String(e)));
      // 新增上传失败/取消：清空显示；替换失败/取消：保留原图显示与缓存
      if (!isReplace) {
        try { thumbCacheDel(slot); } catch (_) {}
        try { await this._clearThumb(slot); } catch (_) {}
        try {
          this._slotsCache = (this._slotsCache || this.data.slots || []).map((s) =>
            (s.slot === slot ? { ...s, hasImage: false, previewReady: false } : s)
          );
          this._slotsDirty = true;
        } catch (_) {}
      }
      this.scheduleUiRefresh(true);
    } finally {
      try { this.setData({ uploadLock: false, uploadingSlot: -1 }); } catch (_) {}
    }
  },

  async onDeleteImage(evt) {
    const slot = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.slot) ?? 0);
    if (!ble.state.connected) return;
    if (this.data.uploadLock) {
      wx.showToast({ title: "上传中，暂不可删除/替换", icon: "none" });
      return;
    }
    try {
      this.setSlotStatus(slot, "deleting...");
      await ble.sendJsonStopAndWait({ cmd: "delete_image", slot }, { timeoutMs: 1500, retries: 2 });
      this.setSlotStatus(slot, "deleted");
      // 清空本地预览与缓存
      thumbCacheDel(slot);
      await this._clearThumb(slot);
      // 从列表移除该槽位，末尾由 image_info 决定是否补一个空槽位
      this._slotsCache = (this._slotsCache || this.data.slots || []).filter((s) => s.slot !== slot);
      this._slotsDirty = true;
      this.scheduleUiRefresh(true);
      this.onRefreshImageInfo().catch(() => {});
    } catch (e) {
      this.setSlotStatus(slot, "delete fail");
      ble.log("delete_image FAIL: " + ((e && e.message) || String(e)));
      this.scheduleUiRefresh(true);
    }
  },

  // ---------------- Notes ----------------
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

      // 展示策略：最新笔记在最上；若置顶则置顶项永远在第一。
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
        // 置顶时轮播在设备端无效，这里也强制显示为关闭
        noteSlideshow: (pinnedOrig >= 0) ? false : noteSlideshow,
        noteInterval,
      });
      this.setData({ status: "笔记已刷新" });
    } catch (e) {
      ble.log("get_notes FAIL: " + ((e && e.message) || String(e)));
      this.setData({ status: "刷新笔记失败" });
    }
    this.scheduleUiRefresh();
  },

  onEditNote(evt) {
    const idx = Number((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.idx) ?? -1);
    const notes = this.data.notes || [];
    const item = notes.find((x) => x && x.origIndex === idx) || null;
    const text = ((item && item.content) || "").toString();
    const v = text.length > 100 ? text.slice(0, 100) : text;
    this.setData({ noteEditIndex: idx, noteText: v, noteCharCount: v.length, noteCharLeft: Math.max(0, 100 - v.length) });
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
        this.setData({ noteEditIndex: -1, noteText: "", noteCharCount: 0, noteCharLeft: 100, status: "已保存" });
        await this.onRefreshNotes();
      } else {
        this.setData({ status: "保存失败" });
      }
    } catch (e) {
      ble.log("save_note FAIL: " + ((e && e.message) || String(e)));
      this.setData({ status: "保存失败" });
    }
    this.scheduleUiRefresh(true);
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
      // 置顶后轮播无效：这里直接关掉 slideshow
      await ble.sendJsonStopAndWait(
        { cmd: "set_note_config", pinned, slideshow: (pinned >= 0) ? false : !!this.data.noteSlideshow, interval: Number(this.data.noteInterval) || 10 },
        { timeoutMs: 1200, retries: 3 }
      );
      await this.onRefreshNotes();
    } catch (e) {
      ble.log("set_note_config FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh();
  },

  onNoteSlideshowToggle(evt) {
    const v = !!(evt && evt.detail && evt.detail.value);
    // 置顶后轮播无效：直接保持关闭
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
    // 置顶时设备端轮播关闭，但仍需把 interval 等配置同步到固件（取消置顶后立即生效）
    const pinned = Number(this.data.notePinnedOrig) || -1;
    const slideshow = pinned >= 0 ? false : !!this.data.noteSlideshow;
    try {
      await ble.sendJsonStopAndWait(
        { cmd: "set_note_config", pinned, slideshow, interval: Number(this.data.noteInterval) || 10 },
        { timeoutMs: 1200, retries: 3 }
      );
    } catch (e) {
      ble.log("set_note_config FAIL: " + ((e && e.message) || String(e)));
    }
    if (force) this.scheduleUiRefresh();
  },

  // ---------------- Settings ----------------

  async onRefreshFs() {
    if (!ble.state.connected) return;
    try {
      const r = await ble.sendJsonStopAndWait({ cmd: "fs_space" }, { timeoutMs: 1200, retries: 3 });
      const total = Number(r && r.total) || 0;
      const used = Number(r && r.used) || 0;
      const free = Number(r && r.free) || 0;
      const percent = total > 0 ? Math.min(100, Math.max(0, Math.floor((used * 100) / total))) : 0;
      this.setData({ fsTotal: total, fsUsed: used, fsFree: free, fsPercent: percent });
    } catch (e) {
      ble.log("fs_space FAIL: " + ((e && e.message) || String(e)));
    }
    this.scheduleUiRefresh();
  },

  async onCheckUpdate() {
    if (!ble.state.connected) return;
    try {
      this.setData({ fwBusy: true, fwBusyMode: "check", fwPercent: 0, fwStatus: "读取本机版本..." });
      const r = await ble.sendJsonStopAndWait({ cmd: "ota_info" }, { timeoutMs: 1200, retries: 2 });
      const cur = (r && r.current) ? String(r.current) : "";
      this.setData({ fwCurrent: cur, fwStatus: "拉取远端版本..." });
      const text = await fetchTextWithFallbacks(UPDATE_VERSION_URL, { timeoutMs: 8000, retries: 2 });
      const pv = parseVersionText(text);
      const latest = pv.version || "";
      const notes = pv.notes || "";
      const up = (cur && latest) ? (cmpVer(latest, cur) > 0) : false;
      this.setData({
        fwLatest: latest || "-",
        fwNotes: notes,
        fwUpdateAvailable: up,
        fwStatus: up ? "发现新版本" : "已是最新",
      });
    } catch (e) {
      ble.log("check update FAIL: " + ((e && e.message) || String(e)));
      const msg = String((e && e.message) || "未知错误");
      this.setData({ fwStatus: "检查失败：" + msg });
    } finally {
      this.setData({ fwBusy: false, fwBusyMode: "" });
    }
    this.scheduleUiRefresh();
  },

  async onUpgrade() {
    if (!ble.state.connected) return;
    if (!this.data.fwUpdateAvailable) return;
    try {
      this.setData({ fwBusy: true, fwBusyMode: "upgrade", fwPercent: 0, fwStatus: "下载固件中..." });
      const dl = await new Promise((resolve, reject) => {
        wx.downloadFile({
          url: UPDATE_FIRMWARE_URL,
          success: resolve,
          fail: (e) => reject(new Error((e && e.errMsg) || "downloadFile failed")),
        });
      });
      if (dl.statusCode !== 200 || !dl.tempFilePath) throw new Error("download firmware.bin failed");
      const fs = wx.getFileSystemManager();
      const ab = await new Promise((resolve, reject) => {
        fs.readFile({
          filePath: dl.tempFilePath,
          success: (x) => resolve(x.data),
          fail: (e) => reject(new Error((e && e.errMsg) || "readFile failed")),
        });
      });
      const fw = new Uint8Array(ab);
      if (!fw.length) throw new Error("firmware empty");

      this.setData({ fwStatus: "发送 OTA_BEGIN..." });
      const total = (fw.length >>> 0);
      // 发送 OTA 分块：尽量大一些以提升吞吐（固件端帧上限约 180B）
      const chunkBytes = 166;
      const beginRes = await ble.sendFrameStopAndWaitDetailed(FrameType.OtaBegin, le32(total), { timeoutMs: 1200, retries: 3 });
      if (beginRes.errCode !== 0) throw new Error("OTA_BEGIN errCode=" + beginRes.errCode);

      let off = 0;
      const windowN = 8;
      const pend = [];
      while (off < total) {
        const n = Math.min(chunkBytes, total - off);
        const pl = concat(le32(off), fw.subarray(off, off + n));
        const x = await ble.sendFrameNoWaitDetailed(FrameType.OtaChunk, pl, { timeoutMs: 1500 });
        pend.push({ ackP: x.ackP, off: (off + n) });
        off += n;

        if (pend.length >= windowN) {
          const acks = await Promise.all(pend.map((p) => p.ackP));
          for (let i = 0; i < acks.length; i++) {
            const ec = acks[i];
            if (ec === null) throw new Error("OTA_CHUNK timeout");
            if (ec !== 0) throw new Error(`OTA_CHUNK errCode=${ec} off=${pend[i].off}`);
          }
          pend.length = 0;
        }

        const pct = Math.floor((off * 100) / total);
        if (pct !== this.data.fwPercent) this.setData({ fwPercent: pct });
      }
      if (pend.length) {
        const acks = await Promise.all(pend.map((p) => p.ackP));
        for (let i = 0; i < acks.length; i++) {
          const ec = acks[i];
          if (ec === null) throw new Error("OTA_CHUNK timeout");
          if (ec !== 0) throw new Error(`OTA_CHUNK errCode=${ec} off=${pend[i].off}`);
        }
      }

      this.setData({ fwStatus: "发送 OTA_FINISH..." });
      const finRes = await ble.sendFrameStopAndWaitDetailed(FrameType.OtaFinish, le32(total), { timeoutMs: 1500, retries: 3 });
      if (finRes.errCode !== 0) throw new Error("OTA_FINISH errCode=" + finRes.errCode);
      this.setData({ fwStatus: "完成：等待设备重启（会断开连接）", fwPercent: 100 });
    } catch (e) {
      ble.log("upgrade FAIL: " + ((e && e.message) || String(e)));
      this.setData({ fwStatus: "升级失败：" + ((e && e.message) || String(e)) });
    } finally {
      this.setData({ fwBusy: false, fwBusyMode: "" });
      this.scheduleUiRefresh(true);
    }
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
    if (this._brightT && !force) return;
    if (this._brightT) clearTimeout(this._brightT);
    this._brightT = setTimeout(async () => {
      this._brightT = 0;
      try {
        await ble.sendJsonStopAndWait({ cmd: "bright", v: Number(v) || 0 }, { timeoutMs: 800, retries: 2 });
      } catch (e) {
        ble.log("bright FAIL: " + ((e && e.message) || String(e)));
      }
    }, force ? 0 : 80);
  },

  onAskConfirm(evt) {
    const action = String((evt && evt.currentTarget && evt.currentTarget.dataset && evt.currentTarget.dataset.action) || "");
    this._confirmAction = action;
    const msg = (action === "format_fs")
      ? "确定要删除 Cody 上的所有数据吗？将清空图片与笔记。"
      : (action === "reset_system")
        ? "确定要恢复出厂设置吗？设备会重启并断开连接。"
        : "确定要执行该操作吗？";
    this.setData({ confirmOpen: true, confirmMsg: msg });
  },

  async onDisconnectBle() {
    // 设置页断开：先确认
    try {
      await new Promise((resolve, reject) => {
        wx.showModal({
          title: "断开连接",
          content: "确定要断开蓝牙连接吗？将清空本地缓存（图片/笔记等）。",
          confirmText: "断开",
          cancelText: "取消",
          success: (res) => {
            if (res && res.confirm) resolve();
            else reject(new Error("cancel"));
          },
          fail: () => reject(new Error("modal fail")),
        });
      });
    } catch (_) {
      return;
    }

    try {
      // 清空设备端配对记录：下次连接需要重新确认配对
      try {
        if (ble.state.connected) {
          await ble.sendJsonStopAndWait({ cmd: "ble_forget" }, { timeoutMs: 1200, retries: 1 });
        }
      } catch (_) {}

      // 清空小程序所有缓存（包含图片/笔记预览等），并移除“信任设备”记录
      clearAllCachesKeepIdentity();

      await ble.disconnect();
    } catch (_) {}

    try {
      wx.redirectTo({ url: "/pages/connect/connect" });
    } catch (_) {}
  },

  onCancelConfirm() {
    this._confirmAction = "";
    this.setData({ confirmOpen: false, confirmMsg: "" });
  },

  async onOkConfirm() {
    const action = this._confirmAction || "";
    this.setData({ confirmOpen: false });

    // delete_note is encoded as "delete_note:idx"
    if (action.startsWith("delete_note:")) {
      const idx = Number(action.split(":")[1] || -1);
      try {
        await ble.sendJsonStopAndWait({ cmd: "delete_note", index: idx }, { timeoutMs: 1500, retries: 2 });
        await this.onRefreshNotes();
      } catch (e) {
        ble.log("delete_note FAIL: " + ((e && e.message) || String(e)));
      }
      this.scheduleUiRefresh(true);
      return;
    }

    if (!ble.state.connected) return;
    try {
      if (action === "format_fs") {
        await ble.sendJsonStopAndWait({ cmd: "format_fs" }, { timeoutMs: 2000, retries: 2 });
        this.setData({ status: "已格式化" });
      } else if (action === "reset_system") {
        await ble.sendJsonStopAndWait({ cmd: "reset_system" }, { timeoutMs: 2000, retries: 1 });
        this.setData({ status: "已发送恢复出厂，等待断连..." });
      }
    } catch (e) {
      ble.log("confirm action FAIL: " + ((e && e.message) || String(e)));
      this.setData({ status: "操作失败" });
    }
    this.scheduleUiRefresh(true);
  },
});

