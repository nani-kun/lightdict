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

  load();
}

init();
