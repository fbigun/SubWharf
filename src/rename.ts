// 节点名清洗：识别地区并保留倍率与特殊标识。
// 地区表/别名规则移植自 Keywos/rule rename.js；按内部模型重写为纯函数，未识别地区时保留原名。

type Region = readonly [flag: string, en: string, zh: string, full: string];

const REGIONS: readonly Region[] = [
  ["🇭🇰", "HK", "香港", "Hong Kong"],
  ["🇲🇴", "MO", "澳门", "Macao"],
  ["🇹🇼", "TW", "台湾", "Taiwan"],
  ["🇯🇵", "JP", "日本", "Japan"],
  ["🇰🇷", "KR", "韩国", "Korea"],
  ["🇸🇬", "SG", "新加坡", "Singapore"],
  ["🇺🇸", "US", "美国", "United States"],
  ["🇬🇧", "GB", "英国", "United Kingdom"],
  ["🇫🇷", "FR", "法国", "France"],
  ["🇩🇪", "DE", "德国", "Germany"],
  ["🇦🇺", "AU", "澳大利亚", "Australia"],
  ["🇦🇪", "AE", "阿联酋", "Dubai"],
  ["🇦🇫", "AF", "阿富汗", "Afghanistan"],
  ["🇦🇱", "AL", "阿尔巴尼亚", "Albania"],
  ["🇩🇿", "DZ", "阿尔及利亚", "Algeria"],
  ["🇦🇴", "AO", "安哥拉", "Angola"],
  ["🇦🇷", "AR", "阿根廷", "Argentina"],
  ["🇦🇲", "AM", "亚美尼亚", "Armenia"],
  ["🇦🇹", "AT", "奥地利", "Austria"],
  ["🇦🇿", "AZ", "阿塞拜疆", "Azerbaijan"],
  ["🇧🇭", "BH", "巴林", "Bahrain"],
  ["🇧🇩", "BD", "孟加拉国", "Bangladesh"],
  ["🇧🇾", "BY", "白俄罗斯", "Belarus"],
  ["🇧🇪", "BE", "比利时", "Belgium"],
  ["🇧🇿", "BZ", "伯利兹", "Belize"],
  ["🇧🇯", "BJ", "贝宁", "Benin"],
  ["🇧🇹", "BT", "不丹", "Bhutan"],
  ["🇧🇴", "BO", "玻利维亚", "Bolivia"],
  ["🇧🇦", "BA", "波斯尼亚和黑塞哥维那", "Bosnia and Herzegovina"],
  ["🇧🇼", "BW", "博茨瓦纳", "Botswana"],
  ["🇧🇷", "BR", "巴西", "Brazil"],
  ["🇻🇬", "VG", "英属维京群岛", "British Virgin Islands"],
  ["🇧🇳", "BN", "文莱", "Brunei"],
  ["🇧🇬", "BG", "保加利亚", "Bulgaria"],
  ["🇧🇫", "BF", "布基纳法索", "Burkina-faso"],
  ["🇧🇮", "BI", "布隆迪", "Burundi"],
  ["🇰🇭", "KH", "柬埔寨", "Cambodia"],
  ["🇨🇲", "CM", "喀麦隆", "Cameroon"],
  ["🇨🇦", "CA", "加拿大", "Canada"],
  ["🇨🇻", "CV", "佛得角", "CapeVerde"],
  ["🇰🇾", "KY", "开曼群岛", "CaymanIslands"],
  ["🇨🇫", "CF", "中非共和国", "Central African Republic"],
  ["🇹🇩", "TD", "乍得", "Chad"],
  ["🇨🇱", "CL", "智利", "Chile"],
  ["🇨🇴", "CO", "哥伦比亚", "Colombia"],
  ["🇰🇲", "KM", "科摩罗", "Comoros"],
  ["🇨🇬", "CG", "刚果(布)", "Congo-Brazzaville"],
  ["🇨🇩", "CD", "刚果(金)", "Congo-Kinshasa"],
  ["🇨🇷", "CR", "哥斯达黎加", "CostaRica"],
  ["🇭🇷", "HR", "克罗地亚", "Croatia"],
  ["🇨🇾", "CY", "塞浦路斯", "Cyprus"],
  ["🇨🇿", "CZ", "捷克", "Czech Republic"],
  ["🇩🇰", "DK", "丹麦", "Denmark"],
  ["🇩🇯", "DJ", "吉布提", "Djibouti"],
  ["🇩🇴", "DO", "多米尼加共和国", "Dominican Republic"],
  ["🇪🇨", "EC", "厄瓜多尔", "Ecuador"],
  ["🇪🇬", "EG", "埃及", "Egypt"],
  ["🇸🇻", "SV", "萨尔瓦多", "EISalvador"],
  ["🇬🇶", "GQ", "赤道几内亚", "Equatorial Guinea"],
  ["🇪🇷", "ER", "厄立特里亚", "Eritrea"],
  ["🇪🇪", "EE", "爱沙尼亚", "Estonia"],
  ["🇪🇹", "ET", "埃塞俄比亚", "Ethiopia"],
  ["🇫🇯", "FJ", "斐济", "Fiji"],
  ["🇫🇮", "FI", "芬兰", "Finland"],
  ["🇬🇦", "GA", "加蓬", "Gabon"],
  ["🇬🇲", "GM", "冈比亚", "Gambia"],
  ["🇬🇪", "GE", "格鲁吉亚", "Georgia"],
  ["🇬🇭", "GH", "加纳", "Ghana"],
  ["🇬🇷", "GR", "希腊", "Greece"],
  ["🇬🇱", "GL", "格陵兰", "Greenland"],
  ["🇬🇹", "GT", "危地马拉", "Guatemala"],
  ["🇬🇳", "GN", "几内亚", "Guinea"],
  ["🇬🇾", "GY", "圭亚那", "Guyana"],
  ["🇭🇹", "HT", "海地", "Haiti"],
  ["🇭🇳", "HN", "洪都拉斯", "Honduras"],
  ["🇭🇺", "HU", "匈牙利", "Hungary"],
  ["🇮🇸", "IS", "冰岛", "Iceland"],
  ["🇮🇳", "IN", "印度", "India"],
  ["🇮🇩", "ID", "印尼", "Indonesia"],
  ["🇮🇷", "IR", "伊朗", "Iran"],
  ["🇮🇶", "IQ", "伊拉克", "Iraq"],
  ["🇮🇪", "IE", "爱尔兰", "Ireland"],
  ["🇮🇲", "IM", "马恩岛", "Isle of Man"],
  ["🇮🇱", "IL", "以色列", "Israel"],
  ["🇮🇹", "IT", "意大利", "Italy"],
  ["🇨🇮", "CI", "科特迪瓦", "Ivory Coast"],
  ["🇯🇲", "JM", "牙买加", "Jamaica"],
  ["🇯🇴", "JO", "约旦", "Jordan"],
  ["🇰🇿", "KZ", "哈萨克斯坦", "Kazakstan"],
  ["🇰🇪", "KE", "肯尼亚", "Kenya"],
  ["🇰🇼", "KW", "科威特", "Kuwait"],
  ["🇰🇬", "KG", "吉尔吉斯斯坦", "Kyrgyzstan"],
  ["🇱🇦", "LA", "老挝", "Laos"],
  ["🇱🇻", "LV", "拉脱维亚", "Latvia"],
  ["🇱🇧", "LB", "黎巴嫩", "Lebanon"],
  ["🇱🇸", "LS", "莱索托", "Lesotho"],
  ["🇱🇷", "LR", "利比里亚", "Liberia"],
  ["🇱🇾", "LY", "利比亚", "Libya"],
  ["🇱🇹", "LT", "立陶宛", "Lithuania"],
  ["🇱🇺", "LU", "卢森堡", "Luxembourg"],
  ["🇲🇰", "MK", "马其顿", "Macedonia"],
  ["🇲🇬", "MG", "马达加斯加", "Madagascar"],
  ["🇲🇼", "MW", "马拉维", "Malawi"],
  ["🇲🇾", "MY", "马来", "Malaysia"],
  ["🇲🇻", "MV", "马尔代夫", "Maldives"],
  ["🇲🇱", "ML", "马里", "Mali"],
  ["🇲🇹", "MT", "马耳他", "Malta"],
  ["🇲🇷", "MR", "毛利塔尼亚", "Mauritania"],
  ["🇲🇺", "MU", "毛里求斯", "Mauritius"],
  ["🇲🇽", "MX", "墨西哥", "Mexico"],
  ["🇲🇩", "MD", "摩尔多瓦", "Moldova"],
  ["🇲🇨", "MC", "摩纳哥", "Monaco"],
  ["🇲🇳", "MN", "蒙古", "Mongolia"],
  ["🇲🇪", "ME", "黑山共和国", "Montenegro"],
  ["🇲🇦", "MA", "摩洛哥", "Morocco"],
  ["🇲🇿", "MZ", "莫桑比克", "Mozambique"],
  ["🇲🇲", "MM", "缅甸", "Myanmar(Burma)"],
  ["🇳🇦", "NA", "纳米比亚", "Namibia"],
  ["🇳🇵", "NP", "尼泊尔", "Nepal"],
  ["🇳🇱", "NL", "荷兰", "Netherlands"],
  ["🇳🇿", "NZ", "新西兰", "New Zealand"],
  ["🇳🇮", "NI", "尼加拉瓜", "Nicaragua"],
  ["🇳🇪", "NE", "尼日尔", "Niger"],
  ["🇳🇬", "NG", "尼日利亚", "Nigeria"],
  ["🇰🇵", "KP", "朝鲜", "NorthKorea"],
  ["🇳🇴", "NO", "挪威", "Norway"],
  ["🇴🇲", "OM", "阿曼", "Oman"],
  ["🇵🇰", "PK", "巴基斯坦", "Pakistan"],
  ["🇵🇦", "PA", "巴拿马", "Panama"],
  ["🇵🇾", "PY", "巴拉圭", "Paraguay"],
  ["🇵🇪", "PE", "秘鲁", "Peru"],
  ["🇵🇭", "PH", "菲律宾", "Philippines"],
  ["🇵🇹", "PT", "葡萄牙", "Portugal"],
  ["🇵🇷", "PR", "波多黎各", "PuertoRico"],
  ["🇶🇦", "QA", "卡塔尔", "Qatar"],
  ["🇷🇴", "RO", "罗马尼亚", "Romania"],
  ["🇷🇺", "RU", "俄罗斯", "Russia"],
  ["🇷🇼", "RW", "卢旺达", "Rwanda"],
  ["🇸🇲", "SM", "圣马力诺", "SanMarino"],
  ["🇸🇦", "SA", "沙特阿拉伯", "SaudiArabia"],
  ["🇸🇳", "SN", "塞内加尔", "Senegal"],
  ["🇷🇸", "RS", "塞尔维亚", "Serbia"],
  ["🇸🇱", "SL", "塞拉利昂", "SierraLeone"],
  ["🇸🇰", "SK", "斯洛伐克", "Slovakia"],
  ["🇸🇮", "SI", "斯洛文尼亚", "Slovenia"],
  ["🇸🇴", "SO", "索马里", "Somalia"],
  ["🇿🇦", "ZA", "南非", "SouthAfrica"],
  ["🇪🇸", "ES", "西班牙", "Spain"],
  ["🇱🇰", "LK", "斯里兰卡", "SriLanka"],
  ["🇸🇩", "SD", "苏丹", "Sudan"],
  ["🇸🇷", "SR", "苏里南", "Suriname"],
  ["🇸🇿", "SZ", "斯威士兰", "Swaziland"],
  ["🇸🇪", "SE", "瑞典", "Sweden"],
  ["🇨🇭", "CH", "瑞士", "Switzerland"],
  ["🇸🇾", "SY", "叙利亚", "Syria"],
  ["🇹🇯", "TJ", "塔吉克斯坦", "Tajikstan"],
  ["🇹🇿", "TZ", "坦桑尼亚", "Tanzania"],
  ["🇹🇭", "TH", "泰国", "Thailand"],
  ["🇹🇬", "TG", "多哥", "Togo"],
  ["🇹🇴", "TO", "汤加", "Tonga"],
  ["🇹🇹", "TT", "特立尼达和多巴哥", "TrinidadandTobago"],
  ["🇹🇳", "TN", "突尼斯", "Tunisia"],
  ["🇹🇷", "TR", "土耳其", "Turkey"],
  ["🇹🇲", "TM", "土库曼斯坦", "Turkmenistan"],
  ["🇻🇮", "VI", "美属维尔京群岛", "U.S.Virgin Islands"],
  ["🇺🇬", "UG", "乌干达", "Uganda"],
  ["🇺🇦", "UA", "乌克兰", "Ukraine"],
  ["🇺🇾", "UY", "乌拉圭", "Uruguay"],
  ["🇺🇿", "UZ", "乌兹别克斯坦", "Uzbekistan"],
  ["🇻🇪", "VE", "委内瑞拉", "Venezuela"],
  ["🇻🇳", "VN", "越南", "Vietnam"],
  ["🇾🇪", "YE", "也门", "Yemen"],
  ["🇿🇲", "ZM", "赞比亚", "Zambia"],
  ["🇿🇼", "ZW", "津巴布韦", "Zimbabwe"],
  ["🇦🇩", "AD", "安道尔", "Andorra"],
  ["🇷🇪", "RE", "留尼汪", "Reunion"],
  ["🇵🇱", "PL", "波兰", "Poland"],
  ["🇬🇺", "GU", "关岛", "Guam"],
  ["🇻🇦", "VA", "梵蒂冈", "Vatican"],
  ["🇱🇮", "LI", "列支敦士登", "Liechtensteins"],
  ["🇨🇼", "CW", "库拉索", "Curacao"],
  ["🇸🇨", "SC", "塞舌尔", "Seychelles"],
  ["🇦🇶", "AQ", "南极", "Antarctica"],
  ["🇬🇮", "GI", "直布罗陀", "Gibraltar"],
  ["🇨🇺", "CU", "古巴", "Cuba"],
  ["🇫🇴", "FO", "法罗群岛", "Faroe Islands"],
  ["🇦🇽", "AX", "奥兰群岛", "Ahvenanmaa"],
  ["🇧🇲", "BM", "百慕达", "Bermuda"],
  ["🇹🇱", "TL", "东帝汶", "Timor-Leste"],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 按长度倒序拼成 alternation，避免短名覆盖长名（如 Korea / NorthKorea） */
function alternation(keys: Iterable<string>): string {
  return [...keys]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
}

const FLAG_RE = /\p{Regional_Indicator}{2}/u;
const FLAG_MAP = new Map(REGIONS.map(([flag, , zh]) => [flag, zh]));
const ZH_MAP = new Map(REGIONS.map(([, , zh]) => [zh, zh]));
const EN_MAP = new Map(REGIONS.map(([, en, zh]) => [en, zh]));
const QC_MAP = new Map(REGIONS.map(([, , zh, full]) => [full.toLowerCase(), zh]));

const ZH_RE = new RegExp(alternation(ZH_MAP.keys()));
// 英文缩写/全称加前后非字母边界：避免 NODE-01 里的 DE、TROJAN 里的 TR 被误识别
const wordBound = (body: string) => `(?:^|[^A-Za-z])(${body})(?![A-Za-z])`;
const EN_RE = new RegExp(wordBound(alternation(EN_MAP.keys())));
const QC_RE = new RegExp(wordBound(alternation(QC_MAP.keys())), 'i');

// 城市/别名（取自 rename.js 的 rurekey，收敛了单字误匹配）
const ALIASES: readonly (readonly [RegExp, string])[] = [
  [/澳洲|墨尔本|悉尼|土澳|[深沪呼京广杭]澳/, '澳大利亚'],
  [/法兰克福|滬德|[深沪呼京广杭]德/, '德国'],
  [/[深沪呼京广杭]港/, '香港'],
  [/东京|大坂|大阪|[深沪呼京广杭中辽]日/, '日本'],
  [/狮城|[深沪呼京广杭]新/, '新加坡'],
  [
    /\bPortland\b|\bChicago\b|\bColumbus\b|\bNew York\b|\bSilicon Valley\b|\bOregon\b|\bSeattle\b|\bLos Angeles\b|\bSan Jose\b|\bMichigan\b|波特兰|芝加哥|哥伦布|纽约|硅谷|俄勒冈|西雅图|洛杉矶|圣何塞|[深沪呼京广杭]美/i,
    '美国',
  ],
  [/\bLAX\b|\bSFO\b|\bSJC\b|\bJFK\b|\bSEA\b|\bORD\b/i, '美国'],
  [/波黑共和国/, '波斯尼亚和黑塞哥维那'],
  [/印度尼西亚|雅加达|\bJakarta\b/i, '印尼'],
  [/孟买|\bMumbai\b/i, '印度'],
  [/迪拜|阿拉伯联合酋长国|\bUnited Arab Emirates\b/i, '阿联酋'],
  [/孟加拉/, '孟加拉国'],
  [/捷克共和国/, '捷克'],
  [/台湾|臺灣|台北|臺北|新北|新台|台中|高雄|\bTaipei\b/i, '台湾'],
  [/春川|首尔|\bChuncheon\b|\bSeoul\b/i, '韩国'],
  [/\bTokyo\b|\bOsaka\b/i, '日本'],
  [/伦敦|\bLondon\b|\bGreat Britain\b/i, '英国'],
  [/\bUK\b/i, '英国'],
  [/莫斯科|\bMoscow\b/i, '俄罗斯'],
  [/伊斯坦布尔|\bIstanbul\b/i, '土耳其'],
  [/泰國|曼谷|\bBangkok\b/i, '泰国'],
  [/巴黎|\bParis\b/i, '法国'],
  [/苏黎世|\bZurich\b/i, '瑞士'],
  [/\bFrankfurt\b/i, '德国'],
  [/\bHong\s?Kong\b/i, '香港'],
];

// 合并成单条正则，避免每个节点逐条跑 20+ 个别名规则（免费版 CPU 预算）
const ALIAS_RE = new RegExp(ALIASES.map(([re], i) => `(?<a${i}>${re.source})`).join('|'), 'i');
const ALIAS_REGIONS = ALIASES.map(([, region]) => region);

function detectAlias(name: string): string | undefined {
  const groups = ALIAS_RE.exec(name)?.groups;
  if (!groups) return undefined;
  for (let i = 0; i < ALIAS_REGIONS.length; i++) {
    if (groups[`a${i}`] !== undefined) return ALIAS_REGIONS[i];
  }
  return undefined;
}

// 倍率：0.1x / x0.2 / 6x / 3倍 / 2×，数值 1 不保留
const RATE_RE = /(\d{1,3}(?:\.\d+)?)\s*(?:倍|[xX×])|[xX×]\s*(\d{1,3}(?:\.\d+)?)/g;

// 特殊标识：长写法在前，matchAll 非重叠匹配（ˣ²⁰ 不会被拆成 ˣ²）
const SPECIAL_RE =
  /ˣ²⁰|ˣ³⁰|ˣ⁴⁰|ˣ⁵⁰|ˣ¹⁰|ˣ²|ˣ³|ˣ⁴|ˣ⁵|ˣ⁶|ˣ⁷|ˣ⁸|ˣ⁹|IPLC|IEPL|\bKern\b|\bEdge\b|\bPro\b|\bStd\b|\bExp\b|\bBiz\b|\bFam\b|游戏|\bGame\b|\bBuy\b|\bZx\b|\bLB\b|cloudflare|\bUDP\b|\bGPT\b|UDPN|核心|边缘|高级|标准|实验|商宽|家宽|购物|专线/gi;
const SPECIAL_MAP = new Map<string, string>([
  ['ˣ²⁰', '20×'],
  ['ˣ³⁰', '30×'],
  ['ˣ⁴⁰', '40×'],
  ['ˣ⁵⁰', '50×'],
  ['ˣ¹⁰', '10×'],
  ['ˣ²', '2×'],
  ['ˣ³', '3×'],
  ['ˣ⁴', '4×'],
  ['ˣ⁵', '5×'],
  ['ˣ⁶', '6×'],
  ['ˣ⁷', '7×'],
  ['ˣ⁸', '8×'],
  ['ˣ⁹', '9×'],
  ['iplc', 'IPLC'],
  ['iepl', 'IEPL'],
  ['kern', 'Kern'],
  ['edge', 'Edge'],
  ['pro', 'Pro'],
  ['std', 'Std'],
  ['exp', 'Exp'],
  ['biz', 'Biz'],
  ['fam', 'Fam'],
  ['game', 'Game'],
  ['buy', 'Buy'],
  ['zx', 'Zx'],
  ['lb', 'LB'],
  ['cloudflare', 'CF'],
  ['udp', 'UDP'],
  ['gpt', 'GPT'],
  ['udpn', 'UDPN'],
  ['核心', '核心'],
  ['边缘', '边缘'],
  ['高级', '高级'],
  ['标准', '标准'],
  ['实验', '实验'],
  ['商宽', '商宽'],
  ['家宽', '家宽'],
  ['购物', '购物'],
  ['专线', '专线'],
  ['游戏', '游戏'],
]);

function detectRegion(name: string): string | undefined {
  // 与 rename.js 的自动判断顺序一致：城市别名 → 中文 → 国旗 → 英文全称 → 英文缩写
  const alias = detectAlias(name);
  if (alias) return alias;
  const zh = ZH_RE.exec(name)?.[0];
  if (zh) return ZH_MAP.get(zh);
  const flag = FLAG_RE.exec(name)?.[0];
  if (flag) {
    const fromFlag = FLAG_MAP.get(flag);
    if (fromFlag) return fromFlag;
  }
  const qc = QC_RE.exec(name)?.[1];
  if (qc) return QC_MAP.get(qc.toLowerCase());
  const en = EN_RE.exec(name)?.[1];
  if (en) return EN_MAP.get(en);
  return undefined;
}

/**
 * 清洗节点名：地区 + 倍率 + 特殊标识。
 * 无法识别地区时返回原名，避免丢弃信息。
 */
export function cleanNodeName(raw: string): string {
  const name = raw.trim();
  if (!name) return name;
  const region = detectRegion(name);
  if (!region) return name;

  const markers: string[] = [];
  for (const m of name.matchAll(RATE_RE)) {
    const num = m[1] ?? m[2];
    if (!num || Number(num) === 1) continue;
    markers.push(`${Number(num)}×`);
  }
  for (const m of name.matchAll(SPECIAL_RE)) {
    const v = SPECIAL_MAP.get(m[0].toLowerCase());
    if (v) markers.push(v);
  }

  const seen = new Set<string>();
  const rateParts: string[] = [];
  const specialParts: string[] = [];
  for (const v of markers) {
    if (seen.has(v)) continue;
    seen.add(v);
    (v.endsWith('×') ? rateParts : specialParts).push(v);
  }
  return [region, ...rateParts, ...specialParts].join(' ');
}
