// ===== 试卷事实核查服务 - 全自动核查后端 =====
// 接收前端提取的PDF文本 → 自动识别可核查内容 → 联网搜索比对 → 返回结果

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// ===== 自动暂停（节省 Railway 额度）=====
// 核查完成 + 5分钟无新请求 → 自动暂停服务
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN || '';
const RAILWAY_DEPLOYMENT_ID = process.env.RAILWAY_DEPLOYMENT_ID || '';
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5分钟
let idleTimer = null;

async function pauseService() {
  if (!RAILWAY_TOKEN || !RAILWAY_DEPLOYMENT_ID) {
    console.log('[自动暂停] 未配置 RAILWAY_TOKEN 或 RAILWAY_DEPLOYMENT_ID，跳过');
    return false;
  }
  console.log('[自动暂停] 正在暂停服务...');
  try {
    const resp = await axios.post('https://backboard.railway.app/graphql/v2', {
      query: `mutation { deploymentPause(input: {id: "${RAILWAY_DEPLOYMENT_ID}"}) { id } }`
    }, {
      headers: { 'Authorization': `Bearer ${RAILWAY_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    if (resp.data.errors) {
      console.error('[自动暂停] GraphQL错误:', JSON.stringify(resp.data.errors));
      return false;
    }
    console.log('[自动暂停] 服务已暂停');
    return true;
  } catch (e) {
    console.error('[自动暂停] 失败:', e.response?.data?.errors || e.message);
    return false;
  }
}

function scheduleAutoPause() {
  if (idleTimer) clearTimeout(idleTimer);
  if (!RAILWAY_TOKEN || !RAILWAY_DEPLOYMENT_ID) return;
  idleTimer = setTimeout(() => pauseService(), IDLE_TIMEOUT_MS);
  console.log(`[自动暂停] ${IDLE_TIMEOUT_MS / 60000}分钟后无活动将自动暂停`);
}

// ===== 浏览器请求头 =====
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

// ===== 查证网站优先级 =====
// 注意：只放能返回稳定可访问内容的权威站；排除结果质量差或常返回搜索占位页的站点
const PRIORITY_SITES = [
  'basic.smartedu.cn', 'smartedu.cn',
  'cihai.com.cn',
  'zdic.net',
  'people.com.cn', 'gmw.cn', 'xinhuanet.com',
  'termonline.cn',
  'gushiwen.org',
  '12371.cn',
  'baike.baidu.com',
];

// ===== 工具函数 =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeText(text) {
  return (text || '')
    .replace(/[\s\u3000\r\n\t]+/g, '')
    .replace(/[，。、；：！？.""''（）《》【】「」〔〕…—·\-~～\(\)\[\],;:!?'"]/g, '')
    .trim();
}

function truncate(s, n) { return s && s.length > n ? s.substring(0, n) + '...' : s; }

// 排除单字词典/无关词条（如"梁（汉字）_百度百科"、"雨（自然现象）"）
function isLowQualityTitle(title) {
  if (!title) return false;
  // 单字/短语+括号注释的词典条目（关键词可在括号内任意位置，前缀1-3字）
  if (/^.{1,3}[（(][^）)]*?(汉字|汉语文字|汉语汉字|词语|字义|释义|网络用语|自然现象|建筑施工|肉类|姓氏|政治术语|流行歌曲|美国|综艺|完整版视频|世界三大|第一大城市)[^）)]*[）)]/.test(title)) return true;
  // 纯英文站（如阿里巴巴）
  if (/^Alibaba|^Amazon|^eBay/i.test(title)) return true;
  // "X的意思,X的解释,X的拼音" 类字典条目
  if (/^.[的]意思[,，]/.test(title)) return true;
  return false;
}

async function getValidSources(results, item, max = 3) {
  const tokens = [];
  if (item.author) tokens.push(normalizeText(item.author));
  if (item.title) tokens.push(normalizeText(item.title));
  if (item.quoteText) tokens.push(normalizeText(item.quoteText).substring(0, 6));
  if (item.citationText) tokens.push(normalizeText(item.citationText).substring(0, 10));
  if (item.definition) tokens.push(normalizeText(item.definition).substring(0, 6));
  if (item.content) tokens.push(normalizeText(item.content).substring(0, 10));

  const sorted = sortByPriority(results);
  const valid = [];
  for (const r of sorted) {
    if (valid.length >= max) break;
    const v = await validateSource(r, tokens);
    if (v) valid.push(v);
  }

  // 兜底1：验证都失败时，只返回看起来相关的原始搜索结果
  if (valid.length === 0 && results.length > 0) {
    const related = results.filter(r => {
      if (isLowQualityTitle(r.title)) return false;
      const nt = normalizeText((r.title || '') + ' ' + (r.snippet || ''));
      return tokens.some(t => t && t.length >= 2 && nt.includes(t));
    }).slice(0, max);
    if (related.length > 0) {
      return related.map(r => ({
        title: (r.title || '相关搜索结果').replace(/[\s\n]+/g, ' ').trim(),
        url: r.url,
        snippet: r.snippet || '',
        verified: false,
      }));
    }
  }

  // 兜底2：如果连标题/snippet匹配都没有，返回前2条原始结果（排除低质量）
  if (valid.length === 0 && results.length > 0) {
    const topResults = results.filter(r => {
      const url = r.url || '';
      return /^https?:\/\//.test(url) && !/search\?|s\?|so\?|query=|\.pdf$/i.test(url) && !isLowQualityTitle(r.title);
    }).slice(0, 2);
    if (topResults.length > 0) {
      return topResults.map(r => ({
        title: (r.title || '相关搜索结果').replace(/[\s\n]+/g, ' ').trim(),
        url: r.url,
        snippet: r.snippet || '',
        verified: false,
      }));
    }
  }

  return valid;
}

function sortByPriority(results) {
  return results.sort((a, b) => {
    const ap = PRIORITY_SITES.findIndex(s => (a.url || '').includes(s));
    const bp = PRIORITY_SITES.findIndex(s => (b.url || '').includes(s));
    if (ap === -1 && bp === -1) return 0;
    if (ap === -1) return 1;
    if (bp === -1) return -1;
    return ap - bp;
  });
}

// 从整页文本提取所有题号标签（带位置）
function extractQuestionLabels(text) {
  const labels = [];
  const patterns = [
    { re: /[（(][一二三四五六七八九十百][）)]/g, type: 'sub' },      // （一）
    { re: /[一二三四五六七八九十]+[、．.]/g, type: 'main' },          // 一、
    { re: /\(\s*\d+\s*\)/g, type: 'sub' },                            // (1)
    { re: /\d+\s*[\.．、]/g, type: 'num' },                          // 1. / 7.
    { re: /第\s*\d+\s*题/g, type: 'sub' },                            // 第1题
    { re: /[甲乙丙丁]文/g, type: 'sub' },                               // 丙文
  ];
    for (const { re, type } of patterns) {
      let m;
      while ((m = re.exec(text)) !== null) {
        labels.push({ pos: m.index, label: m[0].replace(/[．.\s]+$/, '').replace(/\s+/g, '').trim(), type });
      }
    }
  labels.sort((a, b) => a.pos - b.pos);
  return labels;
}

// 找到pos之前最近的题号，并尝试与大题组合
function findNearestQuestionLabel(labels, pos, maxDistance = 400) {
  if (!labels || labels.length === 0) return '';
  let best = null;
  let bestDist = Infinity;
  for (const lab of labels) {
    if (lab.pos > pos) break;
    const dist = pos - lab.pos;
    if (dist <= maxDistance && dist < bestDist) {
      bestDist = dist;
      best = lab;
    }
  }
  if (!best) return '';

  // 如果最近的是小题号，向前找大题号/小题区组合
  // num 可以接在 main 或 sub 后面，如"一、7.""（一）7."
  // sub 只接在 main 后面，避免"（一）（5）"这种重复
  let prefix = '';
  if (best.type === 'num') {
    for (let i = labels.length - 1; i >= 0; i--) {
      const lab = labels[i];
      if (lab.pos >= best.pos) continue;
      if ((lab.type === 'main' || lab.type === 'sub') && best.pos - lab.pos < 350) {
        prefix = lab.label;
        break;
      }
    }
  } else if (best.type === 'sub') {
    for (let i = labels.length - 1; i >= 0; i--) {
      const lab = labels[i];
      if (lab.pos >= best.pos) continue;
      if (lab.type === 'main' && best.pos - lab.pos < 350) {
        prefix = lab.label;
        break;
      }
    }
  }
  return prefix ? prefix + best.label : best.label;
}

// ===== 搜索引擎 =====
// 主用百度搜索，结果更准；Bing 作为备用
async function searchBaidu(query, num = 8) {
  try {
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
    const resp = await axios.get(url, { headers: HEADERS, timeout: 12000, maxRedirects: 5 });
    const $ = cheerio.load(resp.data);
    const results = [];
    $('.result, .c-container').each((i, el) => {
      if (i >= num) return false;
      const a = $(el).find('h3 a, .t a').first();
      const title = a.text().trim();
      const link = a.attr('href') || '';
      const snippet = $(el).find('.c-abstract, .content-right_8Zs40, .abstract, span[class*="abstract"]').text().trim();
      if (title && link) results.push({ title, url: link, snippet });
    });
    return results;
  } catch (e) {
    console.error('  [百度搜索失败]', e.message);
    return [];
  }
}

async function searchBing(query, num = 8) {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-Hans&cc=CN&count=${num}`;
    const resp = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const $ = cheerio.load(resp.data);
    const results = [];
    $('.b_algo').each((i, el) => {
      if (i >= num) return false;
      const title = $(el).find('h2').text().trim();
      const link = $(el).find('h2 a').attr('href') || '';
      const snippet = $(el).find('.b_caption p').text().trim() || $(el).find('p').text().trim();
      if (title && link) results.push({ title, url: link, snippet });
    });
    return results;
  } catch (e) {
    console.error('  [Bing搜索失败]', e.message);
    return [];
  }
}

async function searchWeb(query, num = 8) {
  let results = await searchBaidu(query, num);
  if (results.length === 0) {
    results = await searchBing(query, num);
  }
  return results;
}

async function fetchPageText(url) {
  try {
    // 百度站点使用移动版更容易取到正文
    let finalUrl = url;
    if (url.includes('baike.baidu.com')) {
      finalUrl = url.replace('baike.baidu.com', 'm.baike.baidu.com');
    } else if (url.includes('zhidao.baidu.com')) {
      finalUrl = url.replace('zhidao.baidu.com', 'm.zhidao.baidu.com');
    }
    const resp = await axios.get(finalUrl, { headers: HEADERS, timeout: 10000, maxRedirects: 3 });
    const $ = cheerio.load(resp.data);
    $('script, style, nav, footer, header, aside, .sidebar, .ad, .comment, #header, #footer').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  } catch (e) {
    return '';
  }
}

// 验证来源是否有效：优先权威站；页面抓不到时标题匹配也保留（标记未验证）
async function validateSource(resultItem, queryTokens, minTextLength = 50) {
  const url = resultItem.url || '';
  const title = (resultItem.title || '').replace(/[\s\n]+/g, ' ').trim();
  // 排除常见搜索占位页、聚合页
  const badPathPatterns = [/search\?/, /s\?/, /so\?/, /query=/, /\.pdf$/i, /download/i, /\/image\?/];
  if (!url || badPathPatterns.some(re => re.test(url))) return null;
  if (!/^https?:\/\//.test(url)) return null;

  // 排除单字词典条目和低质量来源
  if (isLowQualityTitle(title)) return null;

  const normTitle = normalizeText(title);
  // 标题匹配即认为相关
  const titleMatch = queryTokens.some(t => t && t.length >= 2 && normTitle.includes(t));

  // 百度系站点常被反爬，标题匹配即可直接作为来源
  const baiduSites = ['baike.baidu.com', 'zhidao.baidu.com', 'wk.baidu.com', 'baijiahao.baidu.com'];
  if (baiduSites.some(s => url.includes(s)) && titleMatch) {
    return { title, url, snippet: resultItem.snippet || '', verified: true };
  }

  const pageText = await fetchPageText(url);
  if (!pageText || pageText.length < minTextLength) {
    // 页面正文取不到，但标题相关，保留为"未验证"来源
    if (titleMatch) return { title, url, snippet: resultItem.snippet || '', verified: false };
    return null;
  }

  const normPage = normalizeText(pageText);
  const hasToken = queryTokens.some(t => t && t.length >= 2 && normPage.includes(t));
  if (!hasToken) {
    if (titleMatch) return { title, url, snippet: resultItem.snippet || '', verified: false };
    return null;
  }

  return { title, url, snippet: resultItem.snippet || '', verified: true };
}

// ===== 识别可核查内容 =====
function identifyItems(pages) {
  const items = [];
  let id = 0;

  // 每页题号map
  const pageLabelMap = new Map();

  for (const { pageNum, text } of pages) {
    const pageLabel = `P${pageNum}`;
    const pageLabels = extractQuestionLabels(text);
    pageLabelMap.set(pageNum, pageLabels);

    // 1. 作者+标题: "朱绛《春女怨》"
    const authorTitleRe = /([\u4e00-\u9fa5·]{2,6})[^\u4e00-\u9fa5《]{0,3}《([^》]{2,20})》/g;
    let m;
    while ((m = authorTitleRe.exec(text)) !== null) {
      let author = m[1];
      const title = m[2];
      // 清理朝代/称谓/动词后缀，提取真实人名
      // 注意：长前缀必须排在短前缀前面，否则"明"会先于"明人"匹配
      const authorPrefixes = /^(代文人|明人|清人|宋人|唐人|元人|古人|今人|文人|作家|诗人|学者|先生|女士|教授|博士|学家|北宋|南宋|近代|现代|当代|明|清|唐|宋|元|人)/;
      author = author.replace(authorPrefixes, '').replace(/[的著在是了和与而之于这首]+$/g, '').trim();
      if (!author || author.length < 2 || author.length > 5) continue;
      // 排除非作者词（动词短语、常用词、描述性词语）
      const notAuthor = ['课文','选自','出自','摘自','原文','阅读','以下','文章','这篇','根据','关于','参见','参考','来源','出处','载于','节选','有的','一次','编辑','写作','收进','更能','体会','忙之','深沉','期盼','源头','最终','著成','并撰文','教学','相长','就拿','再比如','就拿','更如','又如','正如','好比','就像','如同','例如','诸如','即如','便如','乃是','便是','就是','均为','皆为','系为','属为','称为','叫做','名为','题为','名为','书名','篇名','文名','诗名','题名','载于','刊于','发表于','选编','编选','收录','辑录','摘录','节录','转录','迻译'];
      if (notAuthor.includes(author)) continue;
      // 作者里不能包含明显非人名用字（如动词/量词/形容词）
      if (/[一次编辑套写收进忙能体会的这在是为以可与而之于深沉期盼最终源头教学相长拿比如更又正便即乃均皆系属称叫做名题书篇文诗刊发收辑摘录节转迻]/.test(author)) continue;
      // 找附近引号内的诗句
      const after = text.substring(m.index, m.index + 200);
      const quoteMatch = after.match(/["""']([^""""']{4,50})["""']/);
      const quoteText = quoteMatch ? quoteMatch[1] : '';
      id++;
      items.push({
        id, page: pageLabel, type: '古诗文献',
        content: `${author}《${title}》${quoteText ? '："' + quoteText + '"' : ''}`,
        author, title, quoteText,
        context: text.substring(Math.max(0, m.index - 30), m.index + 120),
        position: m.index,
        pageNum,
      });
    }

    // 1b. 单独书名号标题（无作者）：《陋室铭》《木兰诗》等
    const titleOnlyRe = /《([^》]{2,20})》/g;
    while ((m = titleOnlyRe.exec(text)) !== null) {
      const rawTitle = m[1];
      const title = rawTitle.replace(/[∙·•‧]/g, '');
      // 排除已被作者+标题覆盖的
      const covered = items.some(it => it.title === title);
      if (covered) continue;
      // 排除常见非核查标题
      const skipTitles = ['语文','数学','英语','物理','化学','历史','地理','政治','生物','试卷','试题','答案','解析','练习','作业','课本','教材','选文','例文','范文','丛书','丛刊'];
      if (skipTitles.includes(title)) continue;
      // 排除乱码/非中文标题：标题中文字占比不足50%的跳过
      const chineseChars = (title.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (chineseChars < title.length * 0.5) continue;
      // 排除含特殊符号过多的标题
      if (/[!@#$%^&*+=<>?/\\|~`]/.test(title)) continue;
      // 排除纯数字或数字开头的标题
      if (/^\d/.test(title)) continue;
      id++;
      items.push({
        id, page: pageLabel, type: '古诗文献',
        content: `《${title}》`,
        author: '', title,
        quoteText: '',
        context: text.substring(Math.max(0, m.index - 30), m.index + 80),
        position: m.index,
        pageNum,
      });
    }

    // 2. 出处标注: "选自/原载/出处..."
    // 匹配体限定为书名号内容，或含4位年份的短文本，避免吞入正文
    const citeRe = /(选自|原载|出处|摘自|引自|来源|载于|节选自|有删改)[：:]?\s*(《[^》]+》|[^\n。；，！？]{0,15}\d{4}[^\n。；，！？]{0,15}|[^\n。；，！？]{3,25})/g;
    while ((m = citeRe.exec(text)) !== null) {
      const citeBody = m[2].trim();
      // 必须包含书名号，或带"年"的4位年份（防止"2025 ,"这种碎片通过）
      const hasBook = /《[^》]+》/.test(citeBody);
      const hasYear = /\d{4}年/.test(citeBody);
      if (!hasBook && !hasYear) continue;
      // 如果是书名号内容，检查中文占比，排除乱码
      if (hasBook) {
        const bookMatch = citeBody.match(/《([^》]+)》/);
        if (bookMatch) {
          const bookContent = bookMatch[1];
          const cnChars = (bookContent.match(/[\u4e00-\u9fa5]/g) || []).length;
          if (bookContent.length >= 3 && cnChars < bookContent.length * 0.4) continue;
          if (/[!@#$%^&*+=<>?/\\|~`]/.test(bookContent)) continue;
        }
      }
      // 避免与作者+标题重复
      const existSimilar = items.some(it => it.context.includes(m[0]));
      if (existSimilar) continue;
      id++;
      items.push({
        id, page: pageLabel, type: '出处标注',
        content: m[0],
        citationText: citeBody,
        context: text.substring(Math.max(0, m.index - 50), m.index + m[0].length + 50),
        position: m.index,
        pageNum,
      });
    }

    // 3. 引号引用的古诗文（排除已有作者+标题覆盖的）
    const quoteRe = /["""']([^""""'\n]{5,50})["""']/g;
    while ((m = quoteRe.exec(text)) !== null) {
      const qt = m[1].trim();
      // 过滤：太短或不像古诗文
      if (qt.length < 5) continue;
      // 检查是否已被作者+标题覆盖
      const covered = items.some(it => it.quoteText && normalizeText(it.quoteText).includes(normalizeText(qt).substring(0, 6)));
      if (covered) continue;
      // 检查是否像古诗/文言文：至少2个文言虚词/意象词，或有逗号且含文言词
      const classicalMatches = qt.match(/[之乎者也兮矣焉哉琴棋书画风花雪月山水云天玉金石竹梅兰菊松柳荷]/g) || [];
      const hasComma = /[，,]/.test(qt);
      const looksLikePoem = (classicalMatches.length >= 2) || (hasComma && classicalMatches.length >= 1);
      if (!looksLikePoem && qt.length < 10) continue;
      // 排除非引用（如题目说明文字）
      if (/^(以下|下列|根据|阅读|回答|请|结合|分析|说明|概括|简述|阐述|谈谈|写出|填空|选择|判断|连线|排序|补全|仿写|改写|翻译|赏析|品味|体会|感受|理解|体会)/.test(qt)) continue;
      id++;
      items.push({
        id, page: pageLabel, type: '引用文本',
        content: `"${qt}"`,
        quoteText: qt,
        context: text.substring(Math.max(0, m.index - 40), m.index + m[0].length + 40),
        position: m.index,
        pageNum,
      });
    }

    // 4. 统计数据：只保留带中文单位或百分比有上下文的数据
    const dataRe = /(\d+(?:\.\d+)?)\s*(亿|千万|百万|万|千|百|十)?\s*(度|吨|棵|人|名|个|分贝|平方公里|千米|公里|米|秒|km\/h|km|%) /g;
    while ((m = dataRe.exec(text)) !== null) {
      const num = m[1];
      const unit1 = m[2] || '';
      const unit2 = m[3] || '';
      const fullNum = `${num}${unit1}${unit2}`;
      // 排除小数字（可能是题号、选项等）
      if (parseFloat(num) < 10 && !unit1) continue;
      // 百分比必须有上下文才保留
      if (unit2 === '%') {
        const ctxBefore = text.substring(Math.max(0, m.index - 25), m.index);
        if (!/(增长|比例|约占|占比|达到|约为|上升|下降|提高|降低|折扣|概率|频率|浓度)/.test(ctxBefore)) continue;
      }
      // 必须有有效单位
      const validUnits = ['度','吨','棵','人','名','个','分贝','平方公里','千米','公里','米','秒','km/h','km','%'];
      if (!validUnits.includes(unit2)) continue;
      id++;
      items.push({
        id, page: pageLabel, type: '统计数据',
        content: fullNum,
        number: num, unit: unit1 + unit2,
        context: text.substring(Math.max(0, m.index - 40), m.index + m[0].length + 40),
        position: m.index,
        pageNum,
      });
    }

    // 5. 《说文解字》字词注释
    const defRe = /《说文解字》[：:]?\s*["""']?([^"""\n。；]{3,40})/g;
    while ((m = defRe.exec(text)) !== null) {
      id++;
      items.push({
        id, page: pageLabel, type: '字词注释',
        content: `《说文解字》${m[1]}`,
        definition: m[1],
        context: text.substring(Math.max(0, m.index - 20), m.index + m[0].length + 20),
        position: m.index,
        pageNum,
      });
    }

    // 6. 完整日期
    const dateRe = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g;
    while ((m = dateRe.exec(text)) !== null) {
      // 排除已覆盖的出处标注
      const covered = items.some(it => it.context.includes(m[0]));
      if (covered) continue;
      id++;
      items.push({
        id, page: pageLabel, type: '历史日期',
        content: m[0],
        year: m[1], month: m[2], day: m[3],
        context: text.substring(Math.max(0, m.index - 40), m.index + m[0].length + 40),
        position: m.index,
        pageNum,
      });
    }
  }

  // 去重（基于content相似度 + 同标题去重）并提取题号
  const seen = new Set();
  const seenTitles = new Set(); // 同类型同标题只保留一条（有作者的优先）
  const deduped = [];
  for (const item of items) {
    const key = normalizeText(item.content).substring(0, 20);
    if (seen.has(key)) continue;
    // 同类型下，如果标题相同，只保留第一条（通常第一条是有作者的，更完整）
    if (item.title) {
      const titleKey = item.type + ':' + normalizeText(item.title);
      if (seenTitles.has(titleKey)) continue;
      seenTitles.add(titleKey);
    }
    seen.add(key);
    const labels = pageLabelMap.get(item.pageNum) || [];
    item.question = findNearestQuestionLabel(labels, item.position);
    // 清理内部字段
    delete item.position;
    delete item.pageNum;
    deduped.push(item);
  }
  // 重排编号
  deduped.forEach((it, i) => it.id = i + 1);
  return deduped;
}

// ===== 文本比对 =====
function findInText(needle, haystack) {
  const n = normalizeText(needle);
  const h = normalizeText(haystack);
  if (!n || !h) return { found: false };
  if (h.includes(n)) return { found: true, exact: true };
  // 模糊匹配：取前4字搜索
  if (n.length >= 4) {
    const prefix = n.substring(0, 4);
    const pos = h.indexOf(prefix);
    if (pos >= 0) {
      const extracted = h.substring(pos, pos + n.length);
      if (extracted === n) return { found: true, exact: true };
      // 找到相似文本，比对差异
      const diffs = [];
      for (let i = 0; i < Math.min(n.length, extracted.length); i++) {
        if (n[i] !== extracted[i]) {
          diffs.push({ pos: i, pdf: n[i], source: extracted[i] });
        }
      }
      if (diffs.length > 0 && diffs.length <= 3) {
        return { found: true, exact: false, diffs, sourceText: extracted };
      }
    }
  }
  return { found: false };
}

// ===== 核查各类内容 =====
async function verifyItem(item) {
  const result = {
    idx: item.id,
    page: item.question ? `${item.page} ${item.question}` : item.page,
    content: item.content,
    verdict: '无法核实',
    sources: [],
    notes: '',
    suggestion: '',
  };

  try {
    if (item.type === '古诗文献') {
      // 搜索原文（清理间隔号等特殊字符）
      const cleanAuthor = (item.author || '').replace(/[∙·•‧]/g, '');
      const cleanTitle = (item.title || '').replace(/[∙·•‧]/g, '');
      // 有引文时搜"作者 标题 原文"以找到完整原文；无引文时搜"作者 标题"即可
      const query = item.quoteText
        ? `${cleanAuthor} ${cleanTitle} 原文`
        : `${cleanAuthor} ${cleanTitle}`.trim();
      console.log(`  [搜索] ${query}`);
      const results = await searchWeb(query, 8);
      await sleep(800);

      // 用snippet比对
      const allSnippets = results.map(r => r.snippet).join(' ');

      if (item.quoteText) {
        // 有引文，精确比对
        let found = findInText(item.quoteText, allSnippets);

        // 如果snippet没找到，取前2个已验证来源的页面内容再比对
        if (!found.found && results.length > 0) {
          const pageSources = await getValidSources(results, item, 2);
          for (const src of pageSources) {
            const pageText = await fetchPageText(src.url);
            await sleep(400);
            found = findInText(item.quoteText, pageText);
            if (found.found) break;
          }
        }

        if (found.found && found.exact) {
          result.verdict = '内容无误';
          result.notes = '引用文本与搜索到的原文一致';
        } else if (found.found && !found.exact && found.diffs) {
          result.verdict = '存在错误';
          const diffStr = found.diffs.map(d => `"${d.pdf}"→"${d.source}"`).join('，');
          result.notes = `原文为"${found.sourceText}"，试卷作"${item.quoteText}"。差异：${diffStr}`;
          result.suggestion = `建议改为原文"${found.sourceText}"`;
        } else {
          // 没找到精确匹配，但找到了相关结果
          if (results.length > 0) {
            result.verdict = '存疑待商';
            result.notes = '搜索到相关结果但未在摘要中找到完全匹配的原文，建议人工核查';
          } else {
            result.verdict = '无法核实';
            result.notes = '未搜索到相关结果';
          }
        }
      } else {
        // 无引文，仅核实作者+标题是否存在
        if (results.length > 0) {
          // 检查搜索结果标题/摘要中是否包含作者名和标题
          const allText = results.map(r => r.title + ' ' + r.snippet).join(' ');
          const normAll = normalizeText(allText);
          const normTitle = normalizeText(item.title);
          const normAuthor = item.author ? normalizeText(item.author) : '';
          const titleInResults = normTitle && normTitle.length >= 2 && normAll.includes(normTitle);
          const authorInResults = !normAuthor || normAll.includes(normAuthor);

          if (titleInResults) {
            // 标题在搜索结果中找到，即认为存在
            result.verdict = '内容无误';
            result.notes = `${item.author ? item.author + '·' : ''}《${item.title}》存在，标题与搜索结果一致`;
          } else if (results.length >= 3) {
            // 标题未在摘要中直接找到，但搜索到多条结果
            result.verdict = '存疑待商';
            result.notes = '搜索到相关结果，但未在摘要中明确确认标题，建议人工核查';
          } else {
            result.verdict = '存疑待商';
            result.notes = '搜索结果较少，建议人工核查';
          }
        }
      }
      result.sources = await getValidSources(results, item);

    } else if (item.type === '出处标注') {
      // 搜索出处信息（清理间隔号）
      const query = (item.citationText || '').replace(/[∙·•‧]/g, '').substring(0, 40);
      console.log(`  [搜索] ${query}`);
      const results = await searchWeb(query, 5);
      await sleep(800);

      if (results.length > 0) {
        // 检查出处中的关键信息是否匹配
        const allText = results.map(r => r.title + ' ' + r.snippet).join(' ');
        const normalizedCite = normalizeText(item.citationText);
        const normalizedAll = normalizeText(allText);

        // 检查是否包含出处中的年份/期刊名
        const yearMatch = item.citationText.match(/(\d{4})/);
        const hasYear = yearMatch && normalizedAll.includes(yearMatch[1]);

        if (hasYear || normalizedAll.includes(normalizedCite.substring(0, 10))) {
          result.verdict = '内容无误';
          result.notes = '出处信息与搜索结果一致';
        } else {
          result.verdict = '存疑待商';
          result.notes = '搜索到相关结果，但出处细节未能完全确认，建议人工核查';
        }
      }
      result.sources = await getValidSources(results, item);

    } else if (item.type === '引用文本') {
      // 搜索引用的文本
      const query = `"${item.quoteText.substring(0, 20)}"`;
      console.log(`  [搜索] ${query}`);
      const results = await searchWeb(item.quoteText.substring(0, 25), 6);
      await sleep(800);

      const allSnippets = results.map(r => r.snippet).join(' ');
      const found = findInText(item.quoteText, allSnippets);

      if (found.found && found.exact) {
        result.verdict = '内容无误';
        result.notes = '引用文本与搜索结果一致';
      } else if (found.found && !found.exact && found.diffs) {
        result.verdict = '存在错误';
        const diffStr = found.diffs.map(d => `"${d.pdf}"→"${d.source}"`).join('，');
        result.notes = `原文为"${found.sourceText}"，试卷作"${item.quoteText}"。差异：${diffStr}`;
        result.suggestion = `建议改为"${found.sourceText}"`;
      } else if (results.length > 0) {
        // 尝试取页面内容
        let pageFound = false;
        for (let i = 0; i < Math.min(2, results.length); i++) {
          const pageText = await fetchPageText(results[i].url);
          await sleep(400);
          const f = findInText(item.quoteText, pageText);
          if (f.found) {
            pageFound = true;
            if (f.exact) {
              result.verdict = '内容无误';
              result.notes = '引用文本与原文一致';
            } else if (f.diffs) {
              result.verdict = '存在错误';
              const diffStr = f.diffs.map(d => `"${d.pdf}"→"${d.source}"`).join('，');
              result.notes = `原文为"${f.sourceText}"，试卷作"${item.quoteText}"。差异：${diffStr}`;
              result.suggestion = `建议改为"${f.sourceText}"`;
            }
            break;
          }
        }
        if (!pageFound) {
          result.verdict = '存疑待商';
          result.notes = '搜索到相关结果，但未找到完全匹配文本，建议人工核查';
        }
      }
      result.sources = await getValidSources(results, item);

    } else if (item.type === '统计数据') {
      // 提取上下文关键词搜索
      const ctxWords = item.context.replace(item.content, '').trim().substring(0, 15);
      const query = `${ctxWords} ${item.content}`;
      console.log(`  [搜索] ${query}`);
      const results = await searchWeb(query, 5);
      await sleep(800);

      if (results.length > 0) {
        const allText = results.map(r => r.snippet).join(' ');
        const found = findInText(item.number, allText);
        if (found.found) {
          result.verdict = '内容无误';
          result.notes = `数据"${item.content}"与搜索结果一致`;
        } else {
          result.verdict = '存疑待商';
          result.notes = '搜索到相关结果，但未确认到具体数据，建议人工核查';
        }
      }
      result.sources = await getValidSources(results, item);

    } else if (item.type === '字词注释') {
      // 搜索《说文解字》释义
      const char = item.definition.match(/[\u4e00-\u9fa5]/);
      if (char) {
        const query = `${char[0]} 说文解字`;
        console.log(`  [搜索] ${query}`);
        const results = await searchWeb(query, 5);
        await sleep(800);

        const allText = results.map(r => r.snippet).join(' ');
        const found = findInText(item.definition.substring(0, 10), allText);

        if (found.found) {
          result.verdict = '内容无误';
          result.notes = '释义与《说文解字》一致';
        } else if (results.length > 0) {
          result.verdict = '存疑待商';
          result.notes = '搜索到相关结果，建议人工核查释义';
        }
        result.sources = await getValidSources(results, item);
      }

    } else if (item.type === '历史日期') {
      // 搜索日期相关事件
      const ctxWords = item.context.replace(item.content, '').trim().substring(0, 15);
      const query = `${ctxWords} ${item.year}年${item.month}月${item.day}日`;
      console.log(`  [搜索] ${query}`);
      const results = await searchWeb(query, 5);
      await sleep(800);

      if (results.length > 0) {
        const allText = results.map(r => r.snippet).join(' ');
        if (allText.includes(item.year) && (allText.includes(item.month + '月') || allText.includes(item.month))) {
          result.verdict = '内容无误';
          result.notes = `日期"${item.content}"与搜索结果一致`;
        } else {
          result.verdict = '存疑待商';
          result.notes = '搜索到相关结果，但日期未完全确认，建议人工核查';
        }
      }
      result.sources = await getValidSources(results, item);
    }
  } catch (e) {
    result.verdict = '无法核实';
    result.notes = '核查过程出错: ' + e.message;
  }

  return result;
}

// ===== API =====
app.get('/api/health', (req, res) => {
  // 健康检查不计入活动，不重置暂停计时器
  res.json({ status: 'ok', time: new Date().toISOString(), autoPause: !!(RAILWAY_TOKEN && RAILWAY_DEPLOYMENT_ID) });
});

// 手动暂停端点（前端可调用）
app.post('/api/pause', async (req, res) => {
  const ok = await pauseService();
  res.json({ success: ok });
});

app.post('/api/check', async (req, res) => {
  const { pages } = req.body;

  if (!pages || !Array.isArray(pages)) {
    return res.status(400).json({ error: '需要 pages 数组' });
  }

  // 有核查活动，重置暂停计时器
  scheduleAutoPause();

  // SSE
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    // 1. 识别内容
    console.log(`\n[${new Date().toLocaleTimeString()}] 收到 ${pages.length} 页文本，开始识别...`);
    const items = identifyItems(pages);
    console.log(`  识别到 ${items.length} 项可核查内容`);

    res.write(`data: ${JSON.stringify({ type: 'start', count: items.length, items: items.map(it => ({ idx: it.id, page: it.question ? `${it.page} ${it.question}` : it.page, content: it.content })) })}\n\n`);

    // 2. 逐项核查
    const results = [];
    for (let i = 0; i < items.length; i++) {
      console.log(`  [${i + 1}/${items.length}] 核查: ${truncate(items[i].content, 30)}`);
      const result = await verifyItem(items[i]);
      results.push(result);
      res.write(`data: ${JSON.stringify({ type: 'result', index: i, total: items.length, result })}\n\n`);
    }

    // 3. 汇总
    const summary = {
      total: results.length,
      ok: results.filter(r => r.verdict === '内容无误').length,
      error: results.filter(r => r.verdict === '存在错误').length,
      doubt: results.filter(r => r.verdict === '存疑待商').length,
      unknown: results.filter(r => r.verdict === '无法核实').length,
    };
    console.log(`  完成: 正确${summary.ok} 错误${summary.error} 存疑${summary.doubt} 无法核实${summary.unknown}\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', summary })}\n\n`);
    res.end();
    // 核查完成后重新计时
    scheduleAutoPause();
  } catch (e) {
    console.error('核查出错:', e);
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
    scheduleAutoPause();
  }
});

// ===== 启动 =====
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`  文件核查服务已启动`);
  console.log(`  端口: ${PORT}`);
  console.log(`  本地访问: http://localhost:${PORT}/文件核查.html`);
  console.log(`  自动暂停: ${RAILWAY_TOKEN && RAILWAY_DEPLOYMENT_ID ? '已启用（5分钟无活动）' : '未启用（需配置环境变量）'}`);
  console.log(`========================================\n`);
  // 启动时开始计时
  scheduleAutoPause();
});
