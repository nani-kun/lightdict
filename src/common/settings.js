/** 全局默认配置。修改这里即可改变首次安装时的默认行为。 */
export const DEFAULTS = {
  enabled: true,            // 总开关
  delay: 400,               // 选中后延迟多少毫秒弹出卡片
  trigger: 'auto',          // auto | shift | ctrl | alt —— 需要按住的修饰键
  theme: 'auto',            // auto | light | dark
  engine: 'google',         // google | mymemory —— 首选翻译引擎
  showEnglishDef: true,     // 单词卡片是否显示英文释义
  autoSpeak: false,         // 单词卡片弹出时自动发音
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
