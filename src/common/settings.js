/** 全局默认配置。修改这里即可改变首次安装时的默认行为。 */
export const DEFAULTS = {
  enabled: true,            // 总开关
  delay: 400,               // 选中后延迟多少毫秒弹出卡片
  trigger: 'auto',          // auto | shift | ctrl | alt —— 需要按住的修饰键
  theme: 'auto',            // auto | light | dark
  engine: 'google',         // 首选翻译引擎 id，见 engines.js 的 TRANSLATE_ENGINES
  cnDictEngine: 'youdao',   // 首选英汉词典 id，见 engines.js 的 CN_DICT_ENGINES
  enDictEngine: 'youdaoee', // 首选英英词典 id，见 engines.js 的 EN_DICT_ENGINES
  zhToEn: false,            // 中译英：关闭时只响应英文选区，打开后中文选区也查
  zhTransEngine: 'google',  // 首选中译英翻译引擎 id，见 ZH_TRANSLATE_ENGINES
  zhDictEngine: 'youdaoce', // 首选汉英词典 id，见 ZH_DICT_ENGINES
  fallback: true,           // 首选引擎失败时自动改用其它引擎
  showEnglishDef: true,     // 单词卡片是否显示英文释义（默认展开，可在卡片上折叠）
  autoSpeak: false,         // 单词卡片弹出时自动发音
  voiceEn: '',              // 语音合成读英文用的嗓音名，空 = 自动挑（见 voices.js）
  voiceZh: '',              // 语音合成读中文用的嗓音名，空 = 自动挑
  pageEngine: 'google',     // 整页翻译用的引擎 id，见 TRANSLATE_ENGINES（量大，和划词分开选）
  pageStyle: 'plain',       // 译文样式：plain 与原文一致 | muted 略淡 | dotted 虚线下划线
  maxTranslateChars: 2000,  // 超过该长度的选区不翻译
  blocklist: []             // 不生效的域名列表，如 ["mail.google.com"]
};

/** 读取配置（自动补齐缺失字段）。 */
export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}

/** 域名是否被用户禁用。 */
export function isBlocked(host, blocklist) {
  if (!host || !Array.isArray(blocklist)) return false;
  return blocklist.some((raw) => {
    const rule = String(raw).trim().toLowerCase().replace(/^\*\./, '');
    if (!rule) return false;
    return host === rule || host.endsWith('.' + rule);
  });
}
