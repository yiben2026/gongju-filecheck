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

//（Railway 自动暂停已移除，当前部署在 Sealos）

// ===== 浏览器请求头 =====
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

// ===== 查证网站优先级（按查证资料方式.docx）=====
// 查证顺序：教材 → 辞海 → 权威媒体 → 领导人讲话库 → 术语在线 → 植物图像库 → 汉典 → 识典古籍 → 国学大师 → 行政区划 → 古诗文网 → 百度百科
const PRIORITY_SITES = [
  // (1) 最新教材 - 中小学智慧平台
  'basic.smartedu.cn', 'smartedu.cn',
  // (4a) 辞海网络版 - 各种词条
  'cihai.com.cn',
  // (4b) 人民网、光明网、新华网、解放军报、政府官网 - 时政/统计/机构名
  'people.com.cn', 'gmw.cn', 'xinhuanet.com', '81.cn', 'gov.cn',
  // (4c) 国家领导人讲话数据库
  'jhsjk.people.cn',
  // (4d) 术语在线 - 专业术语
  'termonline.cn',
  // (4e) 中国植物图像库 - 植物名称
  'ppbc.iplant.cn',
  // (4f) 汉典 - 字词/文言文
  'zdic.net',
  // 识典古籍 - 古籍扫描
  'shidianguji.com',
  // (4g) 国学大师 - 汉典补充
  'guoxuedashi.com',
  // (4h) 全国行政区划信息查询 - 国家标准地名
  'xzqh.mca.gov.cn',
  // 古诗文网 - 古诗文原文
  'gushiwen.org',
  // 党建网 - 领导人讲话/政策
  '12371.cn',
  // 百度百科 - 通用参考
  'baike.baidu.com',
];

// 按内容类型映射优先查证网站（优先级从高到低）
const CONTENT_TYPE_SITES = {
  '古诗文献':   ['gushiwen.org', 'shidianguji.com', 'guoxuedashi.com', 'zdic.net', 'cihai.com.cn', 'basic.smartedu.cn'],
  '出处标注':   ['basic.smartedu.cn', 'cihai.com.cn', 'gushiwen.org', 'shidianguji.com'],
  '引用文本':   ['jhsjk.people.cn', 'people.com.cn', 'gushiwen.org', 'shidianguji.com', 'guoxuedashi.com', 'zdic.net'],
  '统计数据':   ['people.com.cn', 'gmw.cn', 'xinhuanet.com', 'gov.cn', '81.cn'],
  '字词注释':   ['zdic.net', 'cihai.com.cn', 'guoxuedashi.com'],
  '历史日期':   ['people.com.cn', 'gmw.cn', 'xinhuanet.com', 'baike.baidu.com'],
  '领导人讲话': ['jhsjk.people.cn', 'people.com.cn', 'gov.cn', 'xinhuanet.com'],
  '术语':       ['termonline.cn', 'cihai.com.cn', 'baike.baidu.com'],
  '植物名称':   ['ppbc.iplant.cn', 'baike.baidu.com'],
  '地名':       ['xzqh.mca.gov.cn', 'baike.baidu.com', 'people.com.cn'],
  '人名':       ['cihai.com.cn', 'baike.baidu.com', 'people.com.cn'],
  // 区块识别新增类型
  '文言文':     ['basic.smartedu.cn', 'cihai.com.cn', 'zdic.net', 'shidianguji.com', 'guoxuedashi.com', 'gushiwen.org'],
  '现代文':     ['basic.smartedu.cn', 'people.com.cn', 'gmw.cn', 'xinhuanet.com', '81.cn'],
  '会议名称':   ['people.com.cn', 'xinhuanet.com', 'gov.cn', '12371.cn', 'baike.baidu.com'],
  '机构名称':   ['gov.cn', 'people.com.cn', 'xinhuanet.com', '81.cn', 'baike.baidu.com'],
};

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
  if (item.nameText) tokens.push(normalizeText(item.nameText));
  if (item.content) tokens.push(normalizeText(item.content).substring(0, 10));

  const sorted = sortByPriority(results, item.type);
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

function sortByPriority(results, contentType = '') {
  const typeSites = CONTENT_TYPE_SITES[contentType] || [];
  return results.sort((a, b) => {
    const aUrl = a.url || '';
    const bUrl = b.url || '';
    // 优先：内容类型专属网站
    const aTypeIdx = typeSites.findIndex(s => aUrl.includes(s));
    const bTypeIdx = typeSites.findIndex(s => bUrl.includes(s));
    if (aTypeIdx !== -1 && bTypeIdx !== -1) return aTypeIdx - bTypeIdx;
    if (aTypeIdx !== -1) return -1;
    if (bTypeIdx !== -1) return 1;
    // 其次：通用优先级
    const ap = PRIORITY_SITES.findIndex(s => aUrl.includes(s));
    const bp = PRIORITY_SITES.findIndex(s => bUrl.includes(s));
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
// 主用 360 搜索（中文结果好、对境外云 IP 相对友好）；百度/Bing 作为备用
function stripHtmlTags(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function search360(query, num = 8) {
  try {
    const url = `https://www.so.com/s?q=${encodeURIComponent(query)}`;
    const resp = await axios.get(url, { headers: HEADERS, timeout: 12000, maxRedirects: 5 });
    const $ = cheerio.load(resp.data);
    const results = [];
    $('.res-list').each((i, el) => {
      if (i >= num) return false;
      const a = $(el).find('h3 a, .res-title a').first();
      const title = a.text().trim();
      const link = a.attr('href') || '';
      let snippet = $(el).find('.res-desc, .res-summary').text().trim();
      // fallback：取第一个非空段落文本
      if (!snippet) {
        snippet = $(el).find('p').map((_, p) => $(p).text().trim()).get().filter(Boolean).join(' ');
      }
      if (title && link) results.push({ title, url: link, snippet });
    });
    console.log(`  [360搜索] ${query} => ${results.length} 条`);
    return results;
  } catch (e) {
    console.error('  [360搜索失败]', e.message);
    return [];
  }
}

async function searchBaidu(query, num = 8) {
  try {
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
    const resp = await axios.get(url, { headers: HEADERS, timeout: 12000, maxRedirects: 5 });
    const $ = cheerio.load(resp.data);
    const results = [];

    // 旧版结果
    $('.result, .c-container').each((i, el) => {
      if (i >= num) return false;
      const a = $(el).find('h3 a, .t a').first();
      const title = a.text().trim();
      const link = a.attr('href') || '';
      let snippet = $(el).find('.c-abstract, .content-right_8Zs40, .abstract, span[class*="abstract"]').text().trim();
      if (!snippet) {
        snippet = $(el).find('p').map((_, p) => $(p).text().trim()).get().filter(Boolean).join(' ');
      }
      if (title && link) results.push({ title, url: link, snippet });
    });

    // 新版 aladdin/card 结果：从 s-data JSON 或文本兜底
    if (results.length === 0) {
      const regex = /<!--s-data:({[\s\S]*?})-->/g;
      let m;
      while ((m = regex.exec(resp.data)) !== null && results.length < num) {
        try {
          const data = JSON.parse(m[1]);
          const collect = (obj) => {
            if (!obj) return null;
            const title = stripHtmlTags(obj.title || obj.cardTitle || '').trim();
            const summary = stripHtmlTags(obj.summary || obj.aiAbstract || '').trim();
            const url = obj.url || obj.tcUrl || (obj.urlParams && obj.urlParams.tcUrl) || '';
            if (title && url) return { title, url, snippet: summary };
            return null;
          };
          const r = collect(data);
          if (r && !results.some(x => x.url === r.url)) results.push(r);
          if (data.mainItem) {
            const r2 = collect(data.mainItem);
            if (r2 && !results.some(x => x.url === r2.url)) results.push(r2);
          }
          if (data.docList && Array.isArray(data.docList)) {
            for (const doc of data.docList) {
              const r3 = collect(doc);
              if (r3 && !results.some(x => x.url === r3.url)) results.push(r3);
              if (results.length >= num) break;
            }
          }
        } catch (e) {}
      }
    }

    console.log(`  [百度搜索] ${query} => ${results.length} 条`);
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
    console.log(`  [Bing搜索] ${query} => ${results.length} 条`);
    return results;
  } catch (e) {
    console.error('  [Bing搜索失败]', e.message);
    return [];
  }
}

// ===== 搜索 API（境外云 IP 被百度/360/Bing 屏蔽时启用）=====
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const BING_SEARCH_KEY = process.env.BING_SEARCH_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_CX = process.env.GOOGLE_CX || '';
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || '';

async function searchSerpAPI(query, num = 8) {
  if (!SERPAPI_KEY) return [];
  try {
    const params = new URLSearchParams({
      api_key: SERPAPI_KEY,
      q: query,
      engine: 'baidu',
      num: String(num),
      hl: 'zh-cn'
    });
    const resp = await axios.get(`https://serpapi.com/search?${params.toString()}`, { timeout: 15000 });
    const data = resp.data;
    const organic = data.organic_results || [];
    const results = organic.slice(0, num).map(r => ({
      title: r.title || '',
      url: r.link || r.url || '',
      snippet: r.snippet || r.description || ''
    })).filter(r => r.title && r.url);
    console.log(`  [SerpAPI] ${query} => ${results.length} 条`);
    return results;
  } catch (e) {
    console.error('  [SerpAPI失败]', e.response?.data?.error || e.message);
    return [];
  }
}

async function searchBingAPI(query, num = 8) {
  if (!BING_SEARCH_KEY) return [];
  try {
    const params = new URLSearchParams({
      q: query,
      count: String(num),
      mkt: 'zh-CN',
      setLang: 'zh',
      responseFilter: 'Webpages',
      safeSearch: 'Off'
    });
    const resp = await axios.get(`https://api.bing.microsoft.com/v7.0/search?${params.toString()}`, {
      headers: { 'Ocp-Apim-Subscription-Key': BING_SEARCH_KEY },
      timeout: 15000
    });
    const results = (resp.data.webPages?.value || []).map(r => ({
      title: r.name || '',
      url: r.url || '',
      snippet: r.snippet || ''
    })).filter(r => r.title && r.url);
    console.log(`  [Bing API] ${query} => ${results.length} 条`);
    return results;
  } catch (e) {
    console.error('  [Bing API失败]', e.response?.data?.message || e.message);
    return [];
  }
}

async function searchGoogleAPI(query, num = 8) {
  if (!GOOGLE_API_KEY || !GOOGLE_CX) return [];
  try {
    const params = new URLSearchParams({
      key: GOOGLE_API_KEY,
      cx: GOOGLE_CX,
      q: query,
      num: String(Math.min(num, 10)),
      hl: 'zh-CN'
    });
    const resp = await axios.get(`https://www.googleapis.com/customsearch/v1?${params.toString()}`, { timeout: 15000 });
    const results = (resp.data.items || []).map(r => ({
      title: r.title || '',
      url: r.link || '',
      snippet: r.snippet || ''
    })).filter(r => r.title && r.url);
    console.log(`  [Google API] ${query} => ${results.length} 条`);
    return results;
  } catch (e) {
    console.error('  [Google API失败]', e.response?.data?.error?.message || e.message);
    return [];
  }
}

async function searchBraveAPI(query, num = 8) {
  if (!BRAVE_API_KEY) return [];
  try {
    const resp = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: { q: query, count: num, search_lang: 'zh', text_decorations: 'false' },
      headers: { 'X-Subscription-Token': BRAVE_API_KEY, 'Accept': 'application/json' },
      timeout: 15000
    });
    const results = (resp.data.web?.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || ''
    })).filter(r => r.title && r.url);
    console.log(`  [Brave API] ${query} => ${results.length} 条`);
    return results;
  } catch (e) {
    console.error('  [Brave API失败]', e.response?.data?.message || e.message);
    return [];
  }
}

async function searchWeb(query, num = 8) {
  // 优先使用搜索 API（云 IP 做 HTML 抓取容易被屏蔽）
  let results = [];
  if (SERPAPI_KEY) results = await searchSerpAPI(query, num);
  if (results.length === 0 && BING_SEARCH_KEY) results = await searchBingAPI(query, num);
  if (results.length === 0 && GOOGLE_API_KEY && GOOGLE_CX) results = await searchGoogleAPI(query, num);
  if (results.length === 0 && BRAVE_API_KEY) results = await searchBraveAPI(query, num);
  // 兜底：直接抓取搜索引擎结果页（仅本地/非云 IP 环境通常有效）
  if (results.length === 0) {
    results = await search360(query, num);
  }
  if (results.length === 0) {
    results = await searchBaidu(query, num);
  }
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
// ===== 区块识别（古诗/文言文/现代文，无书名号排版）常量与工具 =====
// 常见姓氏（用于作者名验证）
const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴郁胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍却璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公' +
  '欧阳司马上官诸葛东方独孤南宫万俟闻人夏侯呼延赫连皇甫尉迟公羊澹台公冶宗政濮阳淳于单于太叔申屠公孙仲孙轩辕令狐钟离宇文长孙慕容司徒司空';

// 标题候选跳过词（startsWith 匹配）
const TITLE_SKIP = ['考点','部分','语文','数学','英语','物理','化学','历史','地理','政治','生物','时间','分值','分钟','总分','满分','姓名','学校','班级','座位号','准考证','密封线','注意事项','试卷','答案','解析','题目','试题','阅读','请','根据','结合','分析','概括','简述','阐述','谈谈','写出','填空','选择','判断','连线','排序','补全','仿写','改写','翻译','赏析','品味','体会','感受','理解','说明','要求','注意','下列','以下','上面','下面','本文','课文','选自','摘自','出处','来源','作用','效果','原因','方法','特点','意义','价值','表现','结构','表达','方式','角度','关系','影响','过程','结果','背景','目的','意图','好处','妙处','内容','标题','开头','结尾','段落','句子','词语','文化','常识','古诗文','现代文','文言文','说明文','议论文','记叙文','散文','小说','诗歌','戏剧','名著','整本书','文学','写作','作文','微写作','材料','表格','图示','附录','目录','考查','检测','练习','作业','单元','期中','期末','月考','模拟','真题','汇编','冲刺','优秀','良好','合格','卷面','规范','工整','字数','左右','以上','以下','不少于','不多于','正确','错误','恰当','合适','最','更','再','只','仅','都','就','才','又','还','也','并','而','且','或','若','虽','然','因为','所以','但是','如果','那么','因此','于是','然后','接着','同时','此外','另外','总之','综上','可见','显然','尤其','特别','甚至','乃至','以及','关于','对于','通过','经过','凭借','借助','利用','使用','采用','采取','进行','实施','开展','举行','举办','召开','设立','建立','成立','形成','成为','作为','当作','认为','以为','指出','提出','表明','显示','说明','证明','体现','反映','传达','传递','抒发','寄托','蕴含','包含','包括','涉及','相关','有关','无关','影响','功效','功能','用途','用处','好处','坏处','利弊','优劣','得失','成败','是非','对错','真假','虚实','深浅','高低','大小','多少','远近','长短','宽窄','厚薄','轻重','缓急','先后','主次','本末','因果','源流','始末','始终','前后','上下','内外','东西','南北','古今','中外','第一步','第二步','第三步','过考点','易错','高频','逆袭','核心','任务','文本','小贴士','聚焦','感知','体悟','批注','探究','专题','活动','场景','画面','步骤','评价','标准','提示','注释','示例','范例','要点','思路','技巧','策略','规则','格式','写法','手法','特色','风格','语言','情感','主旨','观点','态度','形象','意象','意境','线索','脉络','层次','顺序','详略','品读','细读','精读','研读','速读','略读','跳读','审题','作答','答题','书写','检查','复查','校对','修改','润色','美化','完善','补充','扩展','延伸','拓展','深化','升华','点题','照应','呼应','伏笔','悬念','铺垫','过渡','衔接','对比','衬托','象征','拟人','比喻','排比','对偶','反复','夸张','设问','反问','借代','双关','反语','夸张','通感','顶真','互文','用典','白描','工笔','渲染','烘托','抑扬','卒章显志','开门见山','以小见大','以动衬静','动静结合','情景交融','借景抒情','托物言志','直抒胸臆','寓情于景','移步换景','定点观察','修辞','句式','句式','词语运用','字音','字形','字义','词义','注音','释义','断句','翻译','默写','背诵','诵读','朗读','朗诵','吟诵','吟咏','咏唱','品味','咀嚼','推敲','斟酌','锤炼','打磨','雕琢','构思','立意','选材','布局','谋篇','成文','定稿','修改意见','阅读提示','知识卡片','助读资料','学习任务','活动任务','写作任务','探究任务','综合实践','实践活动','单元提示','课前预习','课后练习','随堂检测','阶段测试','专项训练','综合训练','基础训练','能力提升','素养发展','思维训练','语言运用','文化传承','审美鉴赏','审美创造','时候','我们','人们','你们','他们','它们','自己','什么','怎么','怎样','如何','地方','现在','这里','那里','其实','只是','但是','然而','于是','然后','接着','最后','终于','突然','忽然','总是','经常','常常','往往','一般','通常','大致','大约','几乎','似乎','好像','仿佛','居然','竟然','果然','当然','不过','还是','就是','便是','却是','可是','虽然','即使','即便','无论','不管','只要','只有','除非','如果','假如','要是','若是','倘若','万一','既然','因为','所以','因而','因此','从而','以致','以便','以免','为了','由于','在于','至于','关于','对于','随着','沿着','顺着','凭着','靠着','经过','通过','除了','除去','包括','包含','例如','比如','譬如','诸如','犹如','如同','好比','就像','回来','回去','起来','过去','出来','进来','上去','下去','学生','老师','同学','家长','父母','朋友','个','文言','说说','见闻','逆温','现象','相矛盾','方法借鉴','方法提示','名字','游踪','章结尾','结尾处']; // 末尾补充高频功能词，过滤双栏拼接碎片误报

// 标题候选按行提取时的额外排除（词尾出现即拒绝）
const TITLE_SKIP_TAIL = ['效果','作用','原因','方法','特点','意义','价值','表现','结构','表达','方式','角度','关系','影响','过程','结果','背景','目的','意图','好处','妙处','内容','标题','开头','结尾','段落','句子','词语','文化','常识','风格','语言','情感','主旨','观点','态度','形象','意象','意境','线索','脉络','层次','顺序','详略','修辞','写法','手法','特色','思路','技巧','策略','规则','格式','标准','要点','提示','注释','示例','范例','任务','文本','材料','小贴士','批注','评价','步骤','场景','画面','专题','活动','探究','经历','见闻','关键','原则','准绳'];

// 笔名/知名作家白名单（首字不是常见姓也能识别：老舍/冰心/巴金/莫泊桑等）
const KNOWN_AUTHORS = ['老舍','冰心','巴金','茅盾','鲁迅','曹禺','艾青','舒婷','顾城','海子','三毛','莫言','铁凝','余华','贾平凹','沈从文','徐志摩','戴望舒','张爱玲','金庸','琼瑶','古龙','丁玲','萧红','郁达夫','林语堂','钱钟书','杨绛','张恨水','丰子恺','叶圣陶','汪曾祺','史铁生','冯骥才','梁实秋','周作人','胡适','林清玄','毕淑敏','迟子建','季羡林','秦牧','孙犁','赵树理','柳青','路遥','陈忠实','王小波','阿来','格非','毕飞宇','刘震云','莫泊桑','契诃夫','马克·吐温','马克吐温','安徒生','法布尔','雨果','都德','普希金','泰戈尔','高尔基','屠格涅夫','培根','奥斯特洛夫斯基','茨威格','川端康成','海明威','莎士比亚','托尔斯泰','叶赛宁','济慈','雪莱','普里什文'];

// 朝代（多字朝代在前，供作者行「［唐］韩愈」「（宋）苏轼」等识别）
const DYNASTY_RE_STR = '春秋|战国|西汉|东汉|西晋|东晋|南北朝|北魏|北宋|南宋|晚清|清末|民国|先秦|五代|秦|汉|三国|晋|隋|唐|宋|辽|金|元|明|清|近代|现代|当代';

// 重大会议名称（保守列表：含全称「中国共产党第X届中央委员会第X次全体会议」「中国共产党第X次全国代表大会」与简称）
const MEETING_RE = /(中国共产党第[一二三四五六七八九十]{1,3}次全国代表大会|中国共产党第[一二三四五六七八九十]{1,3}届中央委员会第[一二三四五六七八九十]{1,3}次全体会议|第[一二三四五六七八九十]{1,3}届中央委员会第[一二三四五六七八九十]{1,3}次全体会议|党的二十大|十九大|二十大|[一二三四五六七八九十]{1,3}届[一二三四五六七八九十]{1,3}中全会|全国两会|全国人民代表大会|中国人民政治协商会议|国务院常务会议|国务院全体会议|中央经济工作会议|中央农村工作会议|全国教育大会|全国宣传思想文化工作会议|全国网络安全和信息化工作会议|博鳌亚洲论坛|二十国集团峰会|世界互联网大会|亚太经合组织领导人非正式会议|金砖国家领导人会晤|全国科技创新大会|两院院士大会|全国劳动模范和先进工作者表彰大会)/g;

// 权威机构/单位名称（保守列表：政府、部委、媒体、高校等）
const ORG_RE = /(中华人民共和国国务院|中华人民共和国教育部|国务院|教育部|外交部|国防部|公安部|民政部|财政部|自然资源部|生态环境部|住房和城乡建设部|交通运输部|水利部|农业农村部|商务部|文化和旅游部|国家卫生健康委员会|应急管理部|中国人民银行|审计署|国家统计局|中国气象局|国家市场监督管理总局|国家广播电视总局|国家体育总局|国家林业和草原局|国家药品监督管理局|国家知识产权局|国家新闻出版署|中国科学院|中国工程院|中国社会科学院|中国作家协会|中国科学技术协会|中华全国总工会|共青团中央|全国妇联|新华社|人民日报社|光明日报社|中央广播电视总台|清华大学|北京大学|中国人民大学|北京师范大学|复旦大学|浙江大学|南京大学|武汉大学|中山大学|四川大学|山东大学|上海交通大学|同济大学|华东师范大学|东北师范大学|华中师范大学|西南大学|陕西师范大学|湖南大学|兰州大学|吉林大学|厦门大学)/g;

// 行政区划地名（省/自治区/直辖市/特别行政区/市，排除常见非地名词）
const PLACE_RE = /([\u4e00-\u9fa5]{2,6}省|[\u4e00-\u9fa5]{1,5}自治区|[\u4e00-\u9fa5]{1,5}直辖市|[\u4e00-\u9fa5]{2,6}特别行政区|[\u4e00-\u9fa5]{1,5}市)(?!场)/g;
const NON_PLACE_NAMES = ['城市','都市','市场','市区','市郊','市内','市面','市井','市集','市价','市容','市貌','楼市','股市','两市','全市','本市','该市','各市','城市','城','全县','镇乡','市区','城区','夜市','集市','早市','市上','市里'];

// 人名判断：以常见姓开头且长度 2-4（笔名/知名作家白名单优先通过）
function isLikelyName(name) {
  if (!name) return false;
  if (KNOWN_AUTHORS.includes(name)) return true;
  if (name.length < 2 || name.length > 4) return false;
  const compound = ['欧阳','司马','上官','诸葛','东方','独孤','南宫','万俟','闻人','夏侯','呼延','赫连','皇甫','尉迟','公羊','澹台','公冶','宗政','濮阳','淳于','单于','太叔','申屠','公孙','仲孙','轩辕','令狐','钟离','宇文','长孙','慕容','司徒','司空'];
  if (compound.some(s => name.startsWith(s))) return true;
  return SURNAMES.includes(name[0]);
}

// 排除非人名（双栏拼接碎片/题目标签被误判为作者，如「文言语句」「温层」「和谐之美」「任务三」）
function isBadName(name) {
  if (!name) return true;
  if (name.length > 4) return true;
  if (/语句|温层|游踪|任务|结尾|开头|修辞|赏析|和谐|之美|经历|见闻|上亿|个名字|说说|方法|借鉴|释义|提示|现象|相矛盾|名字|效果|作用|原因|特点|意义|价值|层次|结构|表现|风格|语言|情感|主旨|观点|态度|形象|意象|意境|线索|脉络|顺序|详略|写法|手法|特色|思路|技巧|策略|规则|格式|标准|要点|注释|示例|范例|步骤|场景|画面|专题|活动|探究|评价|秦时官|代在/.test(name)) return true;
  return false;
}

// 标题候选跳过检查
function skipTitleCheck(title) {
  if (TITLE_SKIP.some(w => title.startsWith(w))) return true;
  if (TITLE_SKIP_TAIL.some(w => title.endsWith(w))) return true;
  if (title.includes('卷')) return true; // 卷名（考点卷/逆袭卷等）
  if (/^[一-龥]{1}$/.test(title)) return true; // 单字
  return false;
}

// 从一行文本提取标题候选（返回 { title, src } 或 null；src: whole整行/head行首/tail行尾）
// 支持三种形态：整行标题「送杜少府之任蜀州」/「马 说」；行首标题+邻栏内容「烟雨龙虎山 醇厚留在唇齿之间。」；行尾标题「! 有趣的人不苟且」；带(其一)后缀
function extractTitleFromLine(lineText) {
  // 先去掉常见的甲乙丙丁分组标签前缀（如【甲】马说、(乙) 猫号）
  const s = lineText.replace(/^[【】][甲乙丙丁戊己庚辛壬癸][【】]\s*/, '').replace(/^[(（][甲乙丙丁戊己庚辛壬癸][)）]\s*/, '');
  // 0) 书名号标题行「《我的叔叔于勒》」或「《春望》杜甫」（后跟作者名/行尾；排除「《兑命》曰…」引用句式）
  const m0 = s.match(/^《([^》]{2,20})》/);
  if (m0) {
    const rest = s.slice(m0[0].length).replace(/\s/g, '');
    if (!rest) return { title: m0[1], src: 'whole' };
    if (/^[\u4e00-\u9fa5·]{2,4}$/.test(rest) && (isLikelyName(rest) || KNOWN_AUTHORS.includes(rest))) return { title: m0[1], src: 'whole' };
  }
  const whole = s.replace(/\s/g, '');
  // 1) 整行去空格后为纯汉字（可含·），2-12字（词牌「水调歌头·明月几时有」后缀允许最长8字）
  if (/^[\u4e00-\u9fa5·]{2,12}$/.test(whole)) {
    if (whole.includes('·')) {
      const parts = whole.split('·');
      if (parts.length !== 2 || parts.some(p => p.length < 2 || p.length > 8)) return null;
    }
    return { title: whole, src: 'whole' };
  }
  // 2) 行首段：汉字+可选(后缀括号)，后跟空格或开括号或行尾（双栏拼接处通常有空格）
  const m = s.match(/^([\u4e00-\u9fa5·]{2,12})(?:[（(][^）)]{0,6}[）)])?(?=\s|[（(]|$)/);
  if (m) {
    let title = m[1];
    const suffix = m[0].slice(m[1].length);
    if (suffix && /[（(]/.test(suffix)) title += suffix; // 并入「(其一)」等后缀
    if (title.includes('·')) {
      const parts = title.split('·');
      if (parts.length !== 2 || parts.some(p => p.length < 2 || p.length > 8)) return null;
    }
    return { title, src: 'head' };
  }
  // 3) 行中单字间隔标题「马 说 从语言风格上看…」：双栏拼接时标题字间被空格隔开且紧跟邻栏内容。
  //    排除断句题连续单字间隔「云 霭 蔽 天 风 倏 散」、排除虚词/序数/人称等单字、排除常见合成词首字
  const m3 = s.match(/(?:^|\s)([\u4e00-\u9fa5])\s([\u4e00-\u9fa5])(?=\s|$)(?![ \u3000][\u4e00-\u9fa5]\s)/);
  if (m3) {
    const EXCL = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥一二三四五六七八九十百千万你我他她它们这那之乎者也矣焉哉兮欤耳的了得地是在有和与或及并且而且虽然但是如果因为所以因此于是然则皆悉咸俱若乃其此斯彼夫惟盖故犹且曾尝每各某诸凡候们时岁年日月刻点处里中上下左右前后东西南北内外面间旁侧边际头尾端样般种回遍次场番阵顿批簇束捧捆件块座条根枝棵株朵片张页章节卷册篇项目界域带区段队班排行经手开来去进出入过起止';
    const c1 = m3[1], c2 = m3[2];
    if (!EXCL.includes(c1) && !EXCL.includes(c2) && !EXCL.includes(c1 + c2)) {
      const t3 = c1 + c2;
      if (!skipTitleCheck(t3)) return { title: t3, src: 'mid' };
    }
  }
  // 4) 行尾段：空格/标点分隔后的 3-12 字纯汉字（双栏反向拼接，如「! 有趣的人不苟且」；2字多为碎片词，排除）
  const m2 = s.match(/(?:^|[\s，。；：！？、""''》】…—,.;:!?"'])([\u4e00-\u9fa5·]{3,12})$/);
  if (m2 && !/[，。；：！？、""''《》（）【】…—,.;:!?"'·]/.test(m2[1])) {
    return { title: m2[1], src: 'tail' };
  }
  return null;
}

// 从一行文本提取作者名（返回 name 或 null）
function extractAuthorFromLine(lineText) {
  const t = lineText;
  const whole = t.replace(/\s/g, '');
  // 1) 朝代格式（多字朝代优先）：［唐］韩愈 / 【唐】韩愈 / （宋）苏轼 / (清) 龚自珍 等
  let m = t.match(new RegExp('[\\[【［(（]\\s*(' + DYNASTY_RE_STR + ')\\s*[\\]】］)）]\\s*([\\u4e00-\\u9fa5·]{2,4})'));
  if (m && (isLikelyName(m[2]) || KNOWN_AUTHORS.includes(m[2])) && !isBadName(m[2])) return m[2];
  // 1b) 国家前缀格式：[法]莫泊桑 / （俄）契诃夫 等（外国译作，可带「著/译」后缀）
  m = t.match(/[\[【［(（]\s*(法|美|英|俄|德|日|意|西|古希腊|古罗马|苏联|印度|阿拉伯)\s*[\]】］)）]\s*([\u4e00-\u9fa5·]{2,5})(?:\s*[著译编著]|$)/);
  if (m && (isLikelyName(m[2]) || KNOWN_AUTHORS.includes(m[2])) && !isBadName(m[2])) return m[2];
  // 1c) 无前缀「作者 著/译」：如「莫泊桑 著」「老舍 著」
  m = t.match(/^([\u4e00-\u9fa5·]{2,5})\s*[著译编著]$/);
  if (m && (isLikelyName(m[1]) || KNOWN_AUTHORS.includes(m[1])) && !isBadName(m[1])) return m[1];
  // 2) 整行 2-4 字人名（如「王 勃」「施施然」）
  if (/^[\u4e00-\u9fa5·]{2,4}$/.test(whole) && isLikelyName(whole) && !isBadName(whole)) return whole;
  // 3) 行首 2-4 字人名（后跟空格/标注/数字，如「朱干金 竹筏在桃花洲登岸...」）
  //    2 字人名要求后跟 >=4 字长内容（排除「严谨 王选的」这类选项碎片）
  m = t.match(/^[\u4e00-\u9fa5·]{3,4}(?=[\s①-⑳0-9A-Za-z]|$)/);
  if (m && isLikelyName(m[0]) && !isBadName(m[0])) return m[0];
  m = t.match(/^[\u4e00-\u9fa5·]{2}(?=\s+\S{4,})/);
  if (m && isLikelyName(m[0]) && !isBadName(m[0])) return m[0];
  // 4) 行尾 2-4 字人名：前面必须是句读符号（! 孟祥夫）或文言虚词（之 司空曙），排除空格分隔的普通词（ 庄重 / 丁肇）
  m = t.match(/(?:[!！?？。;；]\s*|[之乎者也矣焉哉兮欤耳]\s)([\u4e00-\u9fa5·]{2,4})$/);
  if (m && isLikelyName(m[1]) && !isBadName(m[1])) return m[1];
  // 5) 作者+创作动词（如「杜甫创作这首诗时」）
  m = t.match(/([\u4e00-\u9fa5·]{2,4})(?:创作|写下|著有|写过|写作|作诗|写道)/);
  if (m && isLikelyName(m[1]) && !isBadName(m[1])) return m[1];
  return null;
}

// 收集标题/作者之后的正文字（古诗/文言文）
function collectBodyFromLines(lines, fromIdx) {
  const parts = [];
  for (let k = fromIdx; k < lines.length && k < fromIdx + 10; k++) {
    const t = lines[k].t;
    const whole = t.replace(/\s/g, '');
    if (!whole) continue;
    if (/^[\d.,，。、；：！？【】（）()①-⑳\s]+$/.test(whole)) continue; // 纯符号/数字/题号碎片行（半角/全角标点混合）
    if (/^\d+[.、)）]/.test(t) || /^\d+\s/.test(t)) break; // 题号行（含「5 下面这段即席讲话」）
    if (/^[\u4e00-\u9fa5·]{2,12}$/.test(whole) && !/[，。！？；：]/.test(t)) break; // 又是标题行
    if (/^(阅读|请|根据|结合|分析|概括|简述|写出|填空|选择|判断|翻译|赏析|下列|以下|按要求)/.test(t)) break; // 题目指令
    // 出处标注行「（选自《礼记·学记》）」/分组标签行「【乙】」：已收集到正文则截断（防跨篇混入），否则跳过
    if (/^[【】][甲乙丙丁戊己庚辛壬癸][【】]$/.test(t) || /^[(（]?(选自|原载|出处|摘自|引自|来源|载于|节选自|摘编自|有删改)/.test(t)) {
      if (parts.length > 0) break;
      continue;
    }
    // 正文特征：含中文标点、长度>=8、至少4个汉字（排除纯符号行）
    if (/[，。！？；：]/.test(t) && whole.length >= 8 && (whole.match(/[\u4e00-\u9fa5·]/g) || []).length >= 4) {
      // 双栏拼接行：取「最后一个空格分隔段」作为左栏正文（如「如今,我 红烛津亭 夜见君,繁弦急管两纷纷。」
      // → 取「夜见君,繁弦急管两纷纷。」），避免右栏文本混入；无拼接痕迹则整行收集
      const segs = t.split(/\s+/);
      const lastSeg = segs[segs.length - 1];
      const lastHanzi = (lastSeg.match(/[\u4e00-\u9fa5·]/g) || []).length;
      if (segs.length >= 2 && lastHanzi >= 4 && /[，。！？；：]/.test(lastSeg) && !/^[\d①-⑳]+$/.test(lastSeg)) {
        parts.push(lastSeg.replace(/\s/g, ''));
        if (parts.length >= 4) break;
        continue;
      }
      parts.push(whole);
      if (parts.length >= 4) break;
    }
  }
  return parts.join('');
}

// 根据朝代标记与正文特征判断类型
function classifyBlockType(hasDynasty, bodyText) {
  // 注意：pdfplumber 提取的标点半角/全角混合（如「城阙辅三秦,风烟望五津。」），分句需兼容
  const sentences = (bodyText || '').split(/[,，.。!！?？;；:：、]/).filter(s => s.length >= 4);
  const poemLike = sentences.length >= 2 && sentences.filter(s => s.length === 5 || s.length === 7).length / sentences.length >= 0.6;
  if (poemLike) return '古诗文献';
  const classicalCount = (bodyText || '').match(/[之乎者也矣焉哉兮欤耳]/g) || [];
  if (classicalCount.length >= 3 || hasDynasty) return '文言文';
  return '现代文';
}

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
      if (isBadName(author)) continue;
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
      // 排除明显是工具书/教材/杂志/报刊/典籍丛书的书名（这些应归出处标注识别）
      const bookOnlyTitles = ['唐诗鉴赏辞典','宋词鉴赏辞典','元曲鉴赏辞典','纽约客','生物学','人教版','部编版','苏教版','语文版','沪教版','粤教版','鲁教版','浙教版','外研版','译林版','新概念英语','人民日报','光明日报','新华日报','中国青年报','中国教育报','人民教育','读者','青年文摘','意林','故事会','科幻世界','博物','环球科学','科学美国人','自然','细胞','柳叶刀','新英格兰医学杂志','美国国家地理','国家地理','三联生活周刊','南方周末','澎湃新闻','新华社','新华网','人民网','光明网','中国新闻网','央视网','中国日报','环球时报','求是','半月谈','瞭望','咬文嚼字','辞海','汉语大词典','现代汉语词典','古代汉语词典','牛津高阶英汉双解词典','成语大词典','百科全书','大百科全书','菌生百态','医学编年史专栏'];
      // 也排除以“辞典/词典/字典/大全/百科/年鉴/年选/选刊/丛刊/学报/杂志/期刊/周刊/月刊/季刊/年刊/年报/日报/晚报/晨报/商报/时报/邮报/信报/快报/导报/早报/都市报/青年报/少年报/教育报/科学报/医学报/健康报/法制报/公安报/农民报/工人报/妇女报/老年报/书画报/摄影报/邮报/时报/商报”结尾的书名，或书名中包含黑名单关键词
      if (bookOnlyTitles.some(w => title.includes(w)) || /(辞典|词典|字典|辞书|大全|百科|年鉴|年选|选刊|丛刊|学报|杂志|期刊|周刊|月刊|季刊|年刊|年报|日报|晚报|晨报|商报|时报|邮报|信报|快报|导报|早报|都市报|青年报|少年报|教育报|科学报|医学报|健康报|法制报|公安报|农民报|工人报|妇女报|老年报|书画报|摄影报)$/.test(title)) continue;
      // 如果该书名号紧跟在“选自/摘自/节选自/摘编自...”之后，让出处标注步骤识别，避免重复/误分类
      const beforeBook = text.substring(Math.max(0, m.index - 25), m.index);
      if (/(选自|原载|出处|摘自|引自|来源|载于|节选自|摘编自|有删改)[：:]?\s*$/.test(beforeBook)) continue;
      // 排除乱码/非中文标题：标题中文字占比不足50%的跳过
      const chineseChars = (title.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (chineseChars < title.length * 0.5) continue;
      // 排除含特殊符号过多的标题
      if (/[!@#$%^&*+=<>?/\\|~`]/.test(title)) continue;
      // 排除纯数字或数字开头的标题
      if (/^\d/.test(title)) continue;
      // 标题后 160 字符内有引号诗句（含句读/文言虚词）→ 古诗文献，否则按现代文（如外国译作《我的叔叔于勒》）
      const afterBook = text.substring(m.index + m[0].length, m.index + m[0].length + 160);
      const bookQuote = afterBook.match(/["""']([^""""'\n]{4,50})["""']/);
      const bookQuoteText = bookQuote ? bookQuote[1] : '';
      const poemLikeTitle = bookQuoteText && (/[之乎者也矣焉哉兮]/.test(bookQuoteText) || /[，,]/.test(bookQuoteText) && (bookQuoteText.match(/[\u4e00-\u9fa5]/g) || []).length >= 8);
      id++;
      items.push({
        id, page: pageLabel, type: poemLikeTitle ? '古诗文献' : '现代文',
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
      // 必须包含书名号，或带"年"的4位年份（或"2025 5 14"式纯数字日期）
      const hasBook = /《[^》]+》/.test(citeBody);
      const hasYear = /\d{4}\s*(年|\d{1,2}\s*月|\d{1,2}\s+\d{1,2})/.test(citeBody);
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
      // 避免与作者+标题重复（不依赖过宽的 context，防止书名号标题的 context 窗口吞掉同段出处标注）
      const existSimilar = items.some(it => it.content === m[0] || (it.citationText && it.citationText === citeBody));
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

    // 7. 领导人讲话引用：提到领导人+引号引用
    const leaderNames = '(习近平|李克强|李强|栗战书|汪洋|王沪宁|赵乐际|韩正|胡锦涛|温家宝|江泽民|朱镕基|邓小平|毛泽东|周恩来|国家主席|总书记|总理|总理说|主席说|总书记说';
    const leaderRe = new RegExp(leaderNames + ')[^""""\'\\n]{0,30}["""\'\']([^""""\'\\n]{5,80})["""\'\']', 'g');
    while ((m = leaderRe.exec(text)) !== null) {
      const leader = m[1];
      const quote = m[2].trim();
      // 排除已被引用文本覆盖的
      const covered = items.some(it => it.quoteText && normalizeText(it.quoteText).includes(normalizeText(quote).substring(0, 8)));
      if (covered) continue;
      id++;
      items.push({
        id, page: pageLabel, type: '领导人讲话',
        content: `${leader}："${quote}"`,
        leader, quoteText: quote,
        context: text.substring(Math.max(0, m.index - 20), m.index + m[0].length + 20),
        position: m.index,
        pageNum,
      });
    }

    // 8. 科技术语/专业术语：带"称为/叫做/是指/术语"等标注的
    const termRe = /(?:称为|叫做|是指|术语|简称|缩写|定义)[：:]?\s*([^\n。；，！？""""''《》【】]{2,15})/g;
    while ((m = termRe.exec(text)) !== null) {
      const term = m[1].trim();
      // 排除太短或纯数字
      if (term.length < 2) continue;
      // 排除以虚词/程度副词开头的碎片（如「定义也很独特」→「也很独特」）
      if (/^(也|很|更|最|都|就|才|又|还|并|而|且|或|若|虽|然|因为|所以|但是|如果|那么|因而|因此|于是|然后|接着|同时|此外|另外|只要|只有|除非|即使|无论|不管)/.test(term)) continue;
      // 排除已被其他类型覆盖的
      const covered = items.some(it => it.context.includes(m[0]));
      if (covered) continue;
      id++;
      items.push({
        id, page: pageLabel, type: '术语',
        content: term,
        termText: term,
        context: text.substring(Math.max(0, m.index - 30), m.index + m[0].length + 30),
        position: m.index,
        pageNum,
      });
    }

    // ===== 9. 古诗文/现代文区块识别（标题行+作者行，无书名号排版）=====
    // 试卷常见排版：标题独立行「送杜少府之任蜀州」→ 作者行「王 勃」/「[唐]韩愈」→ 诗句正文
    // 双栏 PDF 会把相邻栏内容拼在同一行，因此支持行首/行尾片段提取
    {
      const lines = (() => {
        const out = [];
        let pos = 0;
        for (const part of text.split('\n')) {
          const t = part.trim();
          if (t) out.push({ t, pos });
          pos += part.length + 1;
        }
        return out;
      })();

      // 收集标题候选与作者候选（带行号）
      const titleHits = [];
      const authorHits = [];
      const dynastyBracketRe = new RegExp('[\\[【［(（]\\s*(' + DYNASTY_RE_STR + ')\\s*[\\]】］)）]');
      for (let li = 0; li < lines.length; li++) {
        const lineText = lines[li].t;
        const title = extractTitleFromLine(lineText);
        const author = extractAuthorFromLine(lineText);
        const pureNameLine = /^[\u4e00-\u9fa5·]{2,4}$/.test(lineText.replace(/\s/g, ''));
        // 消歧：整行纯汉字行（「孟浩然」「江雪」「王 勃」）同时命中标题和作者时看下一行——
        // 下一行是正文（含句读的长句）→ 本行是作者行；否则（下一行是人名/空）→ 本行是标题行。
        // 修复「江雪」被当作者配「孟浩然」、「孟浩然」被当标题产生 江雪《孟浩然》 误配对。
        let asTitle = true, asAuthor = true;
        if (pureNameLine && title && author) {
          const nxt = (li + 1 < lines.length) ? lines[li + 1].t : '';
          const nxtWhole = nxt.replace(/\s/g, '');
          const nextIsBody = nxt && /[，。！？；：]/.test(nxt) && nxtWhole.length >= 8 && !/^[\u4e00-\u9fa5·]{2,4}$/.test(nxtWhole);
          if (nextIsBody) { asTitle = false; asAuthor = true; } else { asTitle = true; asAuthor = false; }
        }
        if (title && !skipTitleCheck(title.title) && asTitle) titleHits.push({ title, idx: li });
        if (author && asAuthor) authorHits.push({
          name: author, idx: li,
          strong: dynastyBracketRe.test(lineText),
          creation: /(创作|写下|著有|写过|写作|作诗|写道)/.test(lineText),
        });
      }

      // 全局贪心配对：先生成所有（标题,作者）候选组合，按【标题来源可信度 → 距离】升序（同优先级强格式作者优先）逐个确认
      // src 加权：whole整行/head行首=0（最可信）、mid行中单字间隔=1、tail行尾碎片=2（最不可信）
      const srcWeight = { whole: 0, head: 0, mid: 1, tail: 2 };
      const pairs = [];
      for (const th of titleHits) {
        for (const ah of authorHits) {
          if (ah.name === th.title.title) continue; // 标题与作者同名（如行尾人名误判）
          const dist = ah.idx - th.idx;
          if (dist < -2 || dist > 6) continue;
          // 作者在标题上方时要求强证据（朝代标注或「创作」动词），排除跨栏错配（如杜甫传的「李邕」配《北冥有鱼》）
          if (dist < 0 && !(ah.strong || ah.creation)) continue;
          pairs.push({ th, ah, dist: Math.abs(dist) });
        }
      }
      pairs.sort((a, b) => {
        const wa = srcWeight[a.th.title.src] ?? 2;
        const wb = srcWeight[b.th.title.src] ?? 2;
        if (wa !== wb) return wa - wb;
        if (a.dist !== b.dist) return a.dist - b.dist;
        return (b.ah.strong ? 1 : 0) - (a.ah.strong ? 1 : 0);
      });

      const usedTitles = new Set();
      const usedAuthors = new Set();
      const blockSeenTitles = new Set();
      for (const p of pairs) {
        if (usedTitles.has(p.th.idx) || usedAuthors.has(p.ah.idx)) continue;
        if (blockSeenTitles.has(p.th.title.title)) continue;
        usedTitles.add(p.th.idx);
        usedAuthors.add(p.ah.idx);
        blockSeenTitles.add(p.th.title.title);

        // 收集正文（古诗/文言文原文）
        const bodyText = collectBodyFromLines(lines, p.ah.idx + 1);
        const type = classifyBlockType(p.ah.strong, bodyText);
        id++;
        items.push({
          id, page: pageLabel, type,
          content: `${p.ah.name}《${p.th.title.title}》${bodyText ? '："' + bodyText.substring(0, 60) + '"' : ''}`,
          author: p.ah.name, title: p.th.title.title,
          quoteText: bodyText.substring(0, 80),
          context: text.substring(Math.max(0, lines[p.th.idx].pos - 20), Math.min(text.length, lines[p.ah.idx].pos + 60)),
          position: lines[p.th.idx].pos,
          pageNum,
        });
      }
    }

    // ===== 10. 重大会议名称 =====
    while ((m = MEETING_RE.exec(text)) !== null) {
      const name = m[0];
      // 去重：仅当已有条目的正文内容本身包含该会议名（如同句日期/古诗正文混入），或已有同名会议条目时才跳过；
      // 不能只看 context——日期等条目的 ±25 字符窗口会把同句会议全称包进去造成误伤
      const covered = items.some(it => it.content.includes(name) || (it.type === '会议名称' && it.context.includes(name)));
      if (covered) continue;
      id++;
      items.push({
        id, page: pageLabel, type: '会议名称',
        content: name,
        nameText: name,
        context: text.substring(Math.max(0, m.index - 25), m.index + m[0].length + 25),
        position: m.index,
        pageNum,
      });
    }

    // ===== 11. 权威机构/单位名称 =====
    while ((m = ORG_RE.exec(text)) !== null) {
      const name = m[0];
      const covered = items.some(it => it.context && it.context.includes(name));
      if (covered) continue;
      id++;
      items.push({
        id, page: pageLabel, type: '机构名称',
        content: name,
        nameText: name,
        context: text.substring(Math.max(0, m.index - 25), m.index + m[0].length + 25),
        position: m.index,
        pageNum,
      });
    }

    // ===== 12. 行政区划地名 =====
    while ((m = PLACE_RE.exec(text)) !== null) {
      const name = m[0];
      // 排除常见非地名（城市/市场/全市 等）与碎片（含"的"如「水泥的城市」）
      if (NON_PLACE_NAMES.includes(name)) continue;
      if (name.includes('的')) continue;
      if (/外省|向外|该省|全省|各省|本省|邻省|外市|该市|全市|本市|各市|城市|市场|市区|市郊|市内|市面|市井|市集|市价|市容|市貌|楼市|股市|两市|夜市|集市|早市|市上|市里|县区|全镇|城区/.test(name)) continue;
      // 排除被引用/书名号覆盖的
      const covered = items.some(it => it.context && it.context.includes(name));
      if (covered) continue;
      id++;
      items.push({
        id, page: pageLabel, type: '地名',
        content: name,
        nameText: name,
        context: text.substring(Math.max(0, m.index - 25), m.index + m[0].length + 25),
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
    // 标题相同的条目只保留一条（跨类型合并：如 1b 书名号《XX》与区块配对 作者《XX》）；若当前条目带作者而已有条目无作者，则替换（区块识别补充作者）
    if (item.title) {
      const titleKey = normalizeText(item.title);
      if (seenTitles.has(titleKey)) {
        const existing = deduped.find(d => d.title && normalizeText(d.title) === normalizeText(item.title));
        if (existing && !existing.author && item.author) {
          const idx = deduped.indexOf(existing);
          deduped[idx] = item;
        }
        continue;
      }
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
    if (item.type === '古诗文献' || item.type === '文言文') {
      // 古诗/文言文：搜索原文（清理间隔号等特殊字符）
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

    } else if (item.type === '领导人讲话') {
      // 优先搜索国家领导人讲话数据库
      const query = `${item.leader} 讲话 ${item.quoteText.substring(0, 20)}`;
      console.log(`  [搜索] ${query}`);
      const results = await searchWeb(query, 8);
      await sleep(800);

      const allSnippets = results.map(r => r.snippet).join(' ');
      const found = findInText(item.quoteText, allSnippets);

      if (found.found && found.exact) {
        result.verdict = '内容无误';
        result.notes = '领导人讲话引用与搜索结果一致';
      } else if (found.found && !found.exact && found.diffs) {
        result.verdict = '存在错误';
        const diffStr = found.diffs.map(d => `"${d.pdf}"→"${d.source}"`).join('，');
        result.notes = `原文为"${found.sourceText}"，稿件作"${item.quoteText}"。差异：${diffStr}`;
        result.suggestion = `建议改为原文"${found.sourceText}"`;
      } else if (results.length > 0) {
        // 尝试取页面内容精确比对
        let pageFound = false;
        const pageSources = await getValidSources(results, item, 2);
        for (const src of pageSources) {
          const pageText = await fetchPageText(src.url);
          await sleep(400);
          const f = findInText(item.quoteText, pageText);
          if (f.found) {
            pageFound = true;
            if (f.exact) {
              result.verdict = '内容无误';
              result.notes = '领导人讲话引用与原文一致';
            } else if (f.diffs) {
              result.verdict = '存在错误';
              const diffStr = f.diffs.map(d => `"${d.pdf}"→"${d.source}"`).join('，');
              result.notes = `原文为"${f.sourceText}"，稿件作"${item.quoteText}"。差异：${diffStr}`;
              result.suggestion = `建议改为原文"${f.sourceText}"`;
            }
            break;
          }
        }
        if (!pageFound) {
          result.verdict = '存疑待商';
          result.notes = '搜索到相关结果，但未找到完全匹配的讲话原文，建议人工核查';
        }
      }
      result.sources = await getValidSources(results, item);

    } else if (item.type === '术语') {
      // 优先搜索术语在线
      const query = `${item.termText} 术语 定义`;
      console.log(`  [搜索] ${query}`);
      const results = await searchWeb(query, 5);
      await sleep(800);

      if (results.length > 0) {
        const allText = results.map(r => r.title + ' ' + r.snippet).join(' ');
        const normAll = normalizeText(allText);
        const normTerm = normalizeText(item.termText);
        if (normAll.includes(normTerm)) {
          result.verdict = '内容无误';
          result.notes = `术语"${item.termText}"在搜索结果中找到`;
        } else {
          result.verdict = '存疑待商';
          result.notes = '搜索到相关结果，但未完全确认术语，建议人工核查';
        }
      }
      result.sources = await getValidSources(results, item);

    } else if (item.type === '现代文') {
      // 现代文：验证作者+标题真实存在（对应权威出处）
      const cleanAuthor = (item.author || '').replace(/[∙·•‧]/g, '');
      const cleanTitle = (item.title || '').replace(/[∙·•‧]/g, '');
      const query = `${cleanAuthor} ${cleanTitle}`.trim();
      console.log(`  [搜索] ${query}`);
      const results = await searchWeb(query, 6);
      await sleep(800);

      if (results.length > 0) {
        const allText = results.map(r => r.title + ' ' + r.snippet).join(' ');
        const normAll = normalizeText(allText);
        const normTitle = normalizeText(item.title);
        const normAuthor = item.author ? normalizeText(item.author) : '';
        const titleInResults = normTitle && normTitle.length >= 2 && normAll.includes(normTitle);
        const authorInResults = !normAuthor || normAll.includes(normAuthor);
        if (titleInResults && authorInResults) {
          result.verdict = '内容无误';
          result.notes = `${item.author}《${item.title}》与搜索结果一致`;
        } else if (titleInResults || results.length >= 3) {
          result.verdict = '存疑待商';
          result.notes = '搜索到相关结果，但作者/标题未能完全确认，建议人工核查';
        }
      } else {
        result.verdict = '无法核实';
        result.notes = '未搜索到相关结果';
      }
      result.sources = await getValidSources(results, item);

    } else if (item.type === '会议名称' || item.type === '机构名称' || item.type === '地名') {
      // 会议/机构/地名：搜索名称验证存在与官方表述
      const name = item.nameText || item.content;
      const query = name;
      console.log(`  [搜索] ${query}`);
      const results = await searchWeb(query, 5);
      await sleep(800);

      if (results.length > 0) {
        const allText = results.map(r => r.title + ' ' + r.snippet).join(' ');
        const normAll = normalizeText(allText);
        const normName = normalizeText(name);
        if (normAll.includes(normName)) {
          result.verdict = '内容无误';
          result.notes = `"${name}"与搜索结果一致`;
        } else {
          result.verdict = '存疑待商';
          result.notes = '搜索到相关结果，但名称未完全确认，建议人工核查';
        }
      } else {
        result.verdict = '无法核实';
        result.notes = '未搜索到相关结果';
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
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 调试：测试各搜索引擎连通性
app.get('/api/debug/search', async (req, res) => {
  const query = req.query.q || '朱绛《春女怨》原文';
  const results = {
    '360': { status: 'pending', count: 0, sample: [] },
    baidu: { status: 'pending', count: 0, sample: [] },
    bing: { status: 'pending', count: 0, sample: [] },
    apis: {
      serpapi: !!SERPAPI_KEY,
      bingApi: !!BING_SEARCH_KEY,
      googleApi: !!(GOOGLE_API_KEY && GOOGLE_CX),
      braveApi: !!BRAVE_API_KEY
    }
  };
  try {
    const r360 = await search360(query, 2);
    results['360'] = { status: 'ok', count: r360.length, sample: r360.slice(0, 1).map(x => ({ title: x.title, snippet: x.snippet?.slice(0, 80) })) };
  } catch (e) {
    results['360'] = { status: 'error', error: e.message };
  }
  try {
    const rbaidu = await searchBaidu(query, 2);
    results.baidu = { status: 'ok', count: rbaidu.length, sample: rbaidu.slice(0, 1).map(x => ({ title: x.title, snippet: x.snippet?.slice(0, 80) })) };
  } catch (e) {
    results.baidu = { status: 'error', error: e.message };
  }
  try {
    const rbing = await searchBing(query, 2);
    results.bing = { status: 'ok', count: rbing.length, sample: rbing.slice(0, 1).map(x => ({ title: x.title, snippet: x.snippet?.slice(0, 80) })) };
  } catch (e) {
    results.bing = { status: 'error', error: e.message };
  }
  res.json({ query, results, env: { node: process.version } });
});

app.post('/api/check', async (req, res) => {
  const { pages } = req.body;

  if (!pages || !Array.isArray(pages)) {
    return res.status(400).json({ error: '需要 pages 数组' });
  }

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
  } catch (e) {
    console.error('核查出错:', e);
    res.write(`data: ${JSON.stringify({ type: 'error', message: e.message })}\n\n`);
    res.end();
  }
});

// ===== 导出（供本地测试/模块化使用）=====
module.exports = { identifyItems, extractTitleFromLine, extractAuthorFromLine, isLikelyName };

// ===== 启动 =====
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`  文件核查服务已启动`);
    console.log(`  端口: ${PORT}`);
    console.log(`  本地访问: http://localhost:${PORT}/文件核查.html`);
    const apiList = [];
    if (SERPAPI_KEY) apiList.push('SerpAPI');
    if (BING_SEARCH_KEY) apiList.push('BingSearch');
    if (GOOGLE_API_KEY && GOOGLE_CX) apiList.push('GoogleCSE');
    if (BRAVE_API_KEY) apiList.push('Brave');
    console.log(`  搜索API: ${apiList.length ? apiList.join('/') : '未配置（依赖HTML抓取，在云IP下可能被屏蔽）'}`);
    console.log(`  查证网站: ${PRIORITY_SITES.length}个优先站 + ${Object.keys(CONTENT_TYPE_SITES).length}种内容类型映射`);
    console.log(`========================================\n`);
  });
}

