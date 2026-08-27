/**
 * 发音的两条共用规则：用哪一档发音（ttsAllows）、系统嗓音挑哪个（pick）。
 *
 * 这个文件被三处以「普通脚本」的方式加载 —— 内容脚本（manifest 里排在 content.js
 * 之前）、弹窗和设置页（各自 HTML 里的 <script>）—— 所以它不用 ES 模块语法，
 * 只往全局挂一个对象。三边共用同一套规则，设置页「试听」听到的才和卡片上真正
 * 读出来的是同一个嗓音，划词卡片和弹窗里点发音走的也是同一条候选链。
 */
(() => {
  /**
   * 明显是玩笑 / 特效的系统嗓音，自动挑选时一律避开。
   * macOS 自带一大把这种嗓音，全都标着 localService，而 Albert 恰好排在 en-US 列表最前面：
   * 不挡掉的话，「优先本地嗓音」挑中的就是它，听起来像机器人在捏着嗓子说话。
   */
  const NOVELTY =
    /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|jester|junior|kathy|organ|ralph|superstar|trinoids|whisper|wobble|zarvox|fred|grandma|grandpa|princess|bruce|agnes|victoria|rocko|sandy|shelley|reed|eddy|flo)\b/i;

  /** 各平台上正常好听的嗓音，按优先级排；命中一个就用它。 */
  const PREFERRED = {
    en: [
      /^ava\b/i, /^allison\b/i, /^samantha\b/i, /^alex$/i, /^susan\b/i, /^nicky\b/i, /^tom\b/i,
      /^google us english/i, /^microsoft (aria|jenny|michelle|guy)/i,
      /^daniel\b/i, /^kate\b/i, /^serena\b/i, /^oliver\b/i, /^google uk english/i,
      /^karen\b/i, /^moira\b/i, /^microsoft (zira|david|mark)/i
    ],
    zh: [
      /^(ting-?ting|tingting)/i, /^婷婷/i, /^li-?mu\b/i, /^lilian\b/i,
      /^google 普通话/i, /^google 国语/i,
      /^microsoft (xiaoxiao|yaoyao|huihui|kangkang)/i, /^meijia\b/i, /^sinji\b/i
    ]
  };

  /**
   * 设置页「发音来源」选的那一项，决定哪几档网络发音能用。kind 是候选的出处：
   *   dict    词典给的真人录音（英汉 / 英英词典随查词结果一起返回的）
   *   bing    必应朗读，Azure 的神经网络嗓音
   *   youdao  有道通用发音接口
   *   baidu   百度朗读
   * 系统嗓音是任何设置下的最后一档，不归这里管。
   */
  function ttsAllows(source, kind) {
    if (source === 'local') return false; // 完全离线：一档网络发音都不取
    if (kind === 'dict') return true;     // 真人录音是查词结果的一部分，始终可用
    if (source === 'bing' || source === 'baidu') return kind === source;
    return true;                          // auto：从优到劣全都试
  }

  /** 'zh-CN' / 'en_GB' → 'zh' / 'en'。 */
  function baseOf(lang) {
    return String(lang || 'en').split(/[-_]/)[0].toLowerCase().replace(/[^a-z]/g, '') || 'en';
  }

  /** 同语言的嗓音（不分地区）。 */
  function matching(voices, lang) {
    const base = baseOf(lang);
    return (voices || []).filter((v) => new RegExp(`^${base}([-_]|$)`, 'i').test(v.lang || ''));
  }

  /**
   * 挑一个嗓音。chosen 是用户在设置里指定的嗓音名，空字符串表示自动。
   * 自动的顺序：先在目标口音里找推荐名单，再放宽到同语言的推荐名单，
   * 都没有就避开特效音、优先本地嗓音。
   */
  function pick(voices, lang, region, chosen) {
    const base = baseOf(lang);
    const same = matching(voices, lang);
    if (!same.length) return null;

    if (chosen) {
      const hit = same.find((v) => v.name === chosen || v.voiceURI === chosen);
      if (hit) return hit; // 指定的嗓音在本机不存在时，继续往下自动挑
    }

    const want = base === 'en' ? (region === 'uk' ? /^en[-_]GB/i : /^en[-_]US/i) : null;
    const inRegion = want ? same.filter((v) => want.test(v.lang)) : [];
    for (const tier of [inRegion, same]) {
      for (const preferred of PREFERRED[base] || []) {
        const hit = tier.find((v) => preferred.test(v.name));
        if (hit) return hit;
      }
    }

    const sane = same.filter((v) => !NOVELTY.test(v.name));
    const pool = sane.length ? sane : same;
    const regional = want ? pool.filter((v) => want.test(v.lang)) : [];
    const rest = regional.length ? regional : pool;
    return rest.find((v) => v.localService) || rest[0];
  }

  globalThis.LightDictVoices = { baseOf, matching, pick, ttsAllows, NOVELTY, PREFERRED };
})();
