import { getSettings, setSettings } from '../common/settings.js';

const $ = (id) => document.getElementById(id);
let words = [];

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const shown = q
    ? words.filter((w) => w.word.toLowerCase().includes(q) || (w.brief || '').includes(q))
    : words;

  $('count').textContent = words.length;
  $('empty').hidden = shown.length > 0;
  $('empty').textContent = words.length && !shown.length ? '没有匹配的生词。' : '还没有收藏的单词。';
  $('list').innerHTML = shown
    .map(
      (w) => `<li data-word="${encodeURIComponent(w.word)}">
        <span class="w">${escapeHtml(w.word)}</span>
        <span class="b" title="${escapeHtml(w.brief || '')}">${escapeHtml(w.brief || '')}</span>
        <button class="del" title="删除">×</button>
      </li>`
    )
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

async function load() {
  const res = await send({ type: 'book:list' });
  words = res?.ok ? res.data : [];
  render();
}

/* -------------------------------------------------------- 整页翻译 */

let pageTabId = null;
let pagePoll = null;
// 整页翻译的快捷键，初始化时向浏览器问一次：用户改过就显示改后的，
// macOS 上 Chrome 给的是 ⌥T 这样的符号写法。没设置快捷键时留空，只字不提。
let pageShortcut = '';

/** 只发给主框架：整页翻译不管 iframe，状态也就只有一份。 */
function tabSend(msg) {
  return new Promise((resolve) => {
    if (pageTabId == null) return resolve(null);
    chrome.tabs.sendMessage(pageTabId, msg, { frameId: 0 }, (res) => {
      void chrome.runtime.lastError; // 内容脚本跑不到的页面（chrome:// 等）
      resolve(res);
    });
  });
}

/** 按钮上的字随状态走：没开→整页翻译，翻译中→进度，已翻译→恢复原文。 */
function renderPage(state) {
  const btn = $('pageBtn');
  const label = $('pageLabel');
  const note = $('pageNote');

  if (!state) {
    btn.disabled = true;
    label.textContent = '整页翻译';
    note.textContent = '此页面不支持整页翻译（刷新后再试）';
    return;
  }
  btn.disabled = false;
  btn.classList.toggle('on', state.on);
  if (!state.on) {
    label.textContent = '整页翻译';
    note.textContent = '把当前英文网页变成中英对照' + (pageShortcut ? `（${pageShortcut}）` : '');
    return;
  }
  label.textContent = '恢复原文';
  const rest = state.total - state.done - state.failed;
  if (state.error) note.textContent = `翻译中断：${state.error}`;
  else if (rest > 0) note.textContent = `翻译中 ${state.done} / ${state.total} 段…`;
  else note.textContent = `已翻译 ${state.done} 段` + (state.failed ? `，${state.failed} 段没译出` : '');
}

/** 翻译过程中轮询进度；翻完就停下，别让弹窗一直忙。 */
function watchPage(state) {
  clearInterval(pagePoll);
  renderPage(state);
  if (!state?.on) return;
  pagePoll = setInterval(async () => {
    const next = await tabSend({ type: 'page:status' });
    renderPage(next);
    const rest = next ? next.total - next.done - next.failed : 0;
    if (!next?.on || (!next.busy && rest <= 0)) clearInterval(pagePoll);
  }, 500);
}

async function initPage() {
  const commands = (await chrome.commands?.getAll?.().catch(() => [])) || [];
  pageShortcut = commands.find((c) => c.name === 'toggle-page')?.shortcut || '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pageTabId = tab?.id ?? null;
  watchPage(await tabSend({ type: 'page:status' }));

  $('pageBtn').addEventListener('click', async () => {
    $('pageBtn').disabled = true;
    watchPage(await tabSend({ type: 'page:toggle' }));
  });
}

async function init() {
  const settings = await getSettings();
  $('enabled').checked = settings.enabled;
  $('tip').classList.toggle('off', !settings.enabled);
  if (!settings.enabled) $('tip').textContent = '划词功能已关闭。';

  $('enabled').addEventListener('change', async (e) => {
    await setSettings({ enabled: e.target.checked });
    $('tip').classList.toggle('off', !e.target.checked);
    $('tip').textContent = e.target.checked
      ? '选中英文单词或句子，停留片刻即可查询。'
      : '划词功能已关闭。';
  });

  $('search').addEventListener('input', render);

  $('list').addEventListener('click', async (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    if (e.target.classList.contains('del')) {
      const word = decodeURIComponent(li.dataset.word);
      await send({ type: 'book:remove', word });
      words = words.filter((w) => w.word !== word);
      render();
    }
  });

  $('clear').addEventListener('click', async () => {
    if (!words.length) return;
    await send({ type: 'book:clear' });
    words = [];
    render();
  });

  $('export').addEventListener('click', () => {
    if (!words.length) return;
    const text = words.map((w) => `${w.word}\t${w.brief || ''}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    chrome.downloads?.download
      ? chrome.downloads.download({ url, filename: 'lightdict-wordbook.txt' })
      : Object.assign(document.createElement('a'), { href: url, download: 'lightdict-wordbook.txt' }).click();
  });

  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  initPage();
  load();
}

init();
