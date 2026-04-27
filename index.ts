import axios from "axios";
import * as cheerio from "cheerio";
import cron from "node-cron";
import "dotenv/config";

/**
 * 五行穿衣指南基础地址
 *
 * 今日页面：
 * https://cs.hanyunshi.com/wxchuanyi/
 *
 * 指定日期页面：
 * https://cs.hanyunshi.com/wxchuanyi/2026-4-28/
 */
const BASE_URL = "https://cs.hanyunshi.com/wxchuanyi";

/**
 * 企业微信群机器人 Webhook 地址
 *
 * .env 中配置：
 * WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 */
const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL;

/**
 * 如果没有配置 Webhook，直接终止程序
 */
if (!WECOM_WEBHOOK_URL) {
  throw new Error("缺少 WECOM_WEBHOOK_URL，请检查 .env 文件");
}

/**
 * 五行穿衣指南数据结构
 */
interface DressGuide {
  /** 日期，例如：2026年04月28日 三月(大)十二 星期二 */
  date: string;

  /** 干支信息，例如：丙午马年 壬辰月 壬申(金)日 冲虎 */
  ganzhi: string;

  /** 大吉色 */
  luckyColors: string[];

  /** 次吉色 */
  secondLuckyColors: string[];

  /** 平平色 */
  normalColors: string[];

  /** 慎用色 */
  cautionColors: string[];

  /** 忌用色 */
  avoidColors: string[];

  /** 大吉五行，例如：金 */
  luckyElement: string;

  /** 大吉数字，例如：4、9 */
  luckyNumbers: string;

  /** 当前日期对应的详情页地址 */
  pageUrl: string;
}

/**
 * 清洗网页文本
 *
 * 作用：
 * 1. 把特殊空格替换成普通空格
 * 2. 把多个空格、换行、制表符合并成一个空格
 * 3. 去掉首尾空格
 */
function cleanText(text: string) {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 获取明天的日期对象
 *
 * 例如：
 * 今天是 2026-04-27
 * 返回 2026-04-28
 */
function getTomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date;
}

/**
 * 根据日期生成五行穿衣指南详情页地址
 *
 * 站点 URL 格式：
 * https://cs.hanyunshi.com/wxchuanyi/2026-4-28/
 */
function buildDressGuideUrl(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  return `${BASE_URL}/${year}-${month}-${day}/`;
}

/**
 * 从网页文本中提取五组颜色
 *
 * 页面里颜色出现顺序大致是：
 *
 * 大吉色：
 * 白色、金黄、银色、灰色、米白
 *
 * 次吉色：
 * 黄色、咖色、棕色、米黄、驼色
 *
 * 平平色：
 * 绿色、青色、苍青、翠绿
 *
 * 慎用色：
 * 红色、紫色、粉色、橙红
 *
 * 忌用色：
 * 黑色、蓝色
 *
 * 注意：
 * 这里不直接使用 text.indexOf("今日五行穿衣 大吉色")
 * 因为网页解析出来后，中间可能有空格，也可能没有空格。
 *
 * 所以使用：
 * /今日五行穿衣\s*大吉色/
 *
 * \s* 表示中间可以有 0 个或多个空白字符。
 */
function extractTodayColorGroups(text: string) {
  const colorWords = [
    "白色",
    "金黄",
    "银色",
    "灰色",
    "米白",
    "黄色",
    "咖色",
    "棕色",
    "米黄",
    "驼色",
    "绿色",
    "青色",
    "苍青",
    "翠绿",
    "红色",
    "紫色",
    "粉色",
    "橙红",
    "黑色",
    "蓝色",
  ];

  /**
   * 找到颜色区域的起点
   *
   * 可能匹配：
   * 今日五行穿衣大吉色
   * 今日五行穿衣 大吉色
   * 今日五行穿衣   大吉色
   */
  const startMatch = text.match(/今日五行穿衣\s*大吉色/);

  /**
   * 找到颜色区域的终点
   *
   * 页面在颜色总览后面，会进入“今日大吉颜色解读”
   * 所以我们只截取这之前的内容，避免后面的解释文字干扰颜色解析。
   */
  const endMatch = text.match(/今日大吉颜色解读/);

  /**
   * 如果找不到颜色区域，返回空数组，避免程序报错。
   */
  if (!startMatch || typeof startMatch.index !== "number") {
    return {
      luckyColors: [],
      secondLuckyColors: [],
      normalColors: [],
      cautionColors: [],
      avoidColors: [],
    };
  }

  const startIndex = startMatch.index;

  const endIndex =
    endMatch && typeof endMatch.index === "number"
      ? endMatch.index
      : text.length;

  /**
   * 今日颜色信息块
   */
  const todayBlock = text.slice(startIndex, endIndex);

  /**
   * 按网页真实出现顺序提取颜色
   *
   * 不能直接 colorWords.filter(...)
   * 因为 filter 会按 colorWords 数组顺序返回，
   * 不一定等于网页中的实际顺序。
   */
  const foundColors = colorWords
    .map((color) => ({
      color,
      index: todayBlock.indexOf(color),
    }))
    .filter((item) => item.index !== -1)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.color);

  /**
   * 根据页面固定顺序切分颜色分组
   */
  return {
    luckyColors: foundColors.slice(0, 5),
    secondLuckyColors: foundColors.slice(5, 10),
    normalColors: foundColors.slice(10, 14),
    cautionColors: foundColors.slice(14, 18),
    avoidColors: foundColors.slice(18, 20),
  };
}

/**
 * 抓取指定日期的五行穿衣指南
 *
 * 例如传入 2026-04-28，
 * 会请求：
 * https://cs.hanyunshi.com/wxchuanyi/2026-4-28/
 */
async function fetchDressGuide(date: Date): Promise<DressGuide> {
  const pageUrl = buildDressGuideUrl(date);

  /**
   * 请求网页 HTML
   */
  const res = await axios.get(pageUrl, {
    headers: {
      /**
       * 模拟浏览器 User-Agent
       * 避免部分站点拒绝默认 Node.js 请求
       */
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    },
    timeout: 10000,
  });

  /**
   * 使用 cheerio 加载 HTML
   * cheerio 类似服务端版 jQuery
   */
  const $ = cheerio.load(res.data);

  /**
   * 提取 body 中所有可见文本并清洗
   */
  const bodyText = cleanText($("body").text());

  /**
   * 匹配日期
   *
   * 示例：
   * 2026年04月28日 三月(大)十二 星期二
   */
  const dateMatch = bodyText.match(
    /(\d{4}年\d{2}月\d{2}日\s+\S+\s+星期[一二三四五六日])/,
  );

  /**
   * 匹配干支信息
   *
   * 示例：
   * 丙午马年 壬辰月 壬申(金)日 冲虎
   */
  const ganzhiMatch = bodyText.match(
    /(甲|乙|丙|丁|戊|己|庚|辛|壬|癸).{0,8}年\s+(甲|乙|丙|丁|戊|己|庚|辛|壬|癸).{0,8}月\s+(甲|乙|丙|丁|戊|己|庚|辛|壬|癸).{0,8}日\s+冲./,
  );

  /**
   * 匹配大吉五行
   *
   * 示例：
   * 大吉五行 金
   */
  const luckyElementMatch = bodyText.match(/大吉五行\s*([金木水火土])/);

  /**
   * 匹配大吉数字
   *
   * 示例：
   * 大吉数字 4、9
   */
  const luckyNumbersMatch = bodyText.match(/大吉数字\s*([0-9、]+)/);

  /**
   * 提取颜色分组
   */
  const colorGroups = extractTodayColorGroups(bodyText);

  /**
   * 返回统一结构的数据
   */
  return {
    date: dateMatch?.[1] || "明日",
    ganzhi: ganzhiMatch?.[0] || "",
    luckyColors: colorGroups.luckyColors,
    secondLuckyColors: colorGroups.secondLuckyColors,
    normalColors: colorGroups.normalColors,
    cautionColors: colorGroups.cautionColors,
    avoidColors: colorGroups.avoidColors,
    luckyElement: luckyElementMatch?.[1] || "",
    luckyNumbers: luckyNumbersMatch?.[1] || "",
    pageUrl,
  };
}

/**
 * 构建企业微信 Markdown 消息内容
 *
 * 企业微信群机器人支持 markdown 消息，
 * 这里会把解析到的数据拼成群里可读的格式。
 */
function buildMarkdownMessage(guide: DressGuide) {
  return `
# 明日五行穿衣指南

> ${guide.date}

${guide.ganzhi ? `**明日干支**：${guide.ganzhi}` : ""}

**大吉色**
${guide.luckyColors.map((item) => `- ${item}`).join("\n")}

**次吉色**
${guide.secondLuckyColors.map((item) => `- ${item}`).join("\n")}

**平平色**
${guide.normalColors.map((item) => `- ${item}`).join("\n")}

**慎用色**
${guide.cautionColors.map((item) => `- ${item}`).join("\n")}

**忌用色**
${guide.avoidColors.map((item) => `- ${item}`).join("\n")}

${guide.luckyElement ? `**大吉五行**：${guide.luckyElement}` : ""}
${guide.luckyNumbers ? `**大吉数字**：${guide.luckyNumbers}` : ""}

[查看完整指南](${guide.pageUrl})
`;
}

/**
 * 发送企业微信 Markdown 消息
 *
 * 企业微信机器人接口要求：
 *
 * POST Webhook 地址
 *
 * {
 *   "msgtype": "markdown",
 *   "markdown": {
 *     "content": "消息内容"
 *   }
 * }
 */
async function sendWeComMarkdown(content: string) {
  const res = await axios.post(WECOM_WEBHOOK_URL!, {
    msgtype: "markdown",
    markdown: {
      content,
    },
  });

  return res.data;
}

/**
 * 主执行函数
 *
 * 当前逻辑：
 * 1. 获取明天日期
 * 2. 抓取明天的五行穿衣指南
 * 3. 构建 Markdown 消息
 * 4. 发送到企业微信群
 */
async function run() {
  const tomorrow = getTomorrowDate();

  const guide = await fetchDressGuide(tomorrow);

  const message = buildMarkdownMessage(guide);

  const result = await sendWeComMarkdown(message);

  console.log("发送结果：", result);
}

/**
 * 手动测试入口
 *
 * 第一次测试时可以打开这段：
 *
 * run().catch((error) => {
 *   console.error("执行失败：", error.response?.data || error.message);
 * });
 *
 * 正式部署时建议注释掉，
 * 避免程序启动时立刻发送一次。
 */
// run().catch((error) => {
//   console.error("执行失败：", error.response?.data || error.message);
// });

/**
 * 定时任务
 *
 * cron 表达式：
 * 20 17 * * *
 *
 * 含义：
 * 每天 17:20 执行一次
 *
 * 注意：
 * node-cron 依赖 Node.js 进程持续运行。
 * 如果终端关闭、服务器关机、进程退出，定时任务就不会执行。
 */
cron.schedule("0 17 * * *", () => {
  run().catch((error) => {
    console.error("定时任务失败：", error.response?.data || error.message);
  });
});

console.log("五行穿衣提醒定时任务已启动，每天下午 17:20 发送明日指南");
