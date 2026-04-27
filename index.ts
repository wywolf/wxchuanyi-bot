import axios from "axios";
import * as cheerio from "cheerio";
import cron from "node-cron";
import "dotenv/config";

const PAGE_URL = "https://cs.hanyunshi.com/wxchuanyi/";
const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL;

if (!WECOM_WEBHOOK_URL) {
  throw new Error("缺少 WECOM_WEBHOOK_URL，请检查 .env 文件");
}

interface DressGuide {
  date: string;
  ganzhi: string;
  luckyColors: string[];
  secondLuckyColors: string[];
  normalColors: string[];
  cautionColors: string[];
  avoidColors: string[];
  luckyElement: string;
  luckyNumbers: string;
}

function cleanText(text: string) {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchDressGuide(): Promise<DressGuide> {
  const res = await axios.get(PAGE_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    },
    timeout: 10000,
  });

  const $ = cheerio.load(res.data);
  const bodyText = cleanText($("body").text());

  const dateMatch = bodyText.match(
    /(\d{4}年\d{2}月\d{2}日\s+\S+\s+星期[一二三四五六日])/,
  );
  const ganzhiMatch = bodyText.match(
    /(甲|乙|丙|丁|戊|己|庚|辛|壬|癸).{0,8}年\s+(甲|乙|丙|丁|戊|己|庚|辛|壬|癸).{0,8}月\s+(甲|乙|丙|丁|戊|己|庚|辛|壬|癸).{0,8}日\s+冲./,
  );

  const luckyElementMatch = bodyText.match(/大吉五行\s*([金木水火土])/);
  const luckyNumbersMatch = bodyText.match(/大吉数字\s*([0-9、]+)/);

  const colorGroups = extractTodayColorGroups(bodyText);

  const {
    luckyColors,
    secondLuckyColors,
    normalColors,
    cautionColors,
    avoidColors,
  } = colorGroups;

  console.log("是否包含大吉色：", bodyText.includes("今日五行穿衣 大吉色"));
  console.log(
    "是否包含今日大吉颜色解读：",
    bodyText.includes("今日大吉颜色解读"),
  );
  console.log("颜色解析结果：", colorGroups);
  return {
    date: dateMatch?.[1] || "今日",
    ganzhi: ganzhiMatch?.[0] || "",
    luckyColors,
    secondLuckyColors,
    normalColors,
    cautionColors,
    avoidColors,
    luckyElement: luckyElementMatch?.[1] || "",
    luckyNumbers: luckyNumbersMatch?.[1] || "",
  };
}

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
   * 关键点：
   * 不要用 text.indexOf("今日五行穿衣 大吉色")
   * 因为页面文本可能是：
   * 今日五行穿衣 大吉色
   * 今日五行穿衣大吉色
   * 今日五行穿衣   大吉色
   */
  const startMatch = text.match(/今日五行穿衣\s*大吉色/);
  const endMatch = text.match(/今日大吉颜色解读/);

  if (!startMatch || typeof startMatch.index !== "number") {
    console.warn("没有找到：今日五行穿衣 + 大吉色");
    console.log("调试片段：", text.slice(0, 500));

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

  const todayBlock = text.slice(startIndex, endIndex);

  /**
   * 按页面出现顺序提取颜色
   * 不用 filter，因为 filter 是按 colorWords 数组顺序，不是按页面真实出现顺序。
   */
  const foundColors = colorWords
    .map((color) => ({
      color,
      index: todayBlock.indexOf(color),
    }))
    .filter((item) => item.index !== -1)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.color);

  console.log("todayBlock:", todayBlock.slice(0, 500));
  console.log("foundColors:", foundColors);

  return {
    luckyColors: foundColors.slice(0, 5),
    secondLuckyColors: foundColors.slice(5, 10),
    normalColors: foundColors.slice(10, 14),
    cautionColors: foundColors.slice(14, 18),
    avoidColors: foundColors.slice(18, 20),
  };
}

function buildMarkdownMessage(guide: DressGuide) {
  return `
# 今日五行穿衣指南

> ${guide.date}

${guide.ganzhi ? `**今日干支**：${guide.ganzhi}` : ""}

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

[查看完整指南](${PAGE_URL})
`;
}

async function sendWeComMarkdown(content: string) {
  const res = await axios.post(WECOM_WEBHOOK_URL!, {
    msgtype: "markdown",
    markdown: {
      content,
    },
  });

  return res.data;
}

async function run() {
  const guide = await fetchDressGuide();
  const message = buildMarkdownMessage(guide);

  console.log(message);

//   const result = await sendWeComMarkdown(message);
//   console.log("发送结果：", result);
}

// 手动执行一次
run().catch((error) => {
  console.error("执行失败：", error.response?.data || error.message);
});

// 每天早上 8 点发送
cron.schedule("0 8 * * *", () => {
  run().catch((error) => {
    console.error("定时任务失败：", error.response?.data || error.message);
  });
});
