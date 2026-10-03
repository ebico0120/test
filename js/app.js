'use strict';

/* ================================================================
 * ベトナム語 5級 練習ツール
 * ================================================================ */

const $ = (sel, el = document) => el.querySelector(sel);
const DAY = 86400000;
const STORE_KEY = 'vn5-trainer-v1';
// 復習間隔（日）。正解するたびに箱が1つ進む。
const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
const MASTERED_BOX = 3;
const MAX_NEW_PER_SESSION = 5;

/* ---------- データ ---------- */

const CAT_LABEL = Object.fromEntries(VN_CATEGORIES.map(c => [c.id, c.label]));

const ITEMS = [];
for (const [cat, rows] of Object.entries(VN_WORDS)) {
  rows.forEach(([vi, ja], i) => ITEMS.push({ id: `w-${cat}-${i}`, kind: 'word', cat, vi, ja }));
}
VN_PHRASES.forEach(([vi, ja], i) => ITEMS.push({ id: `p-${i}`, kind: 'phrase', cat: 'phrase', vi, ja }));
VN_DIALOGS.forEach(([vi, ja, ans, ansJa], i) =>
  ITEMS.push({ id: `d-${i}`, kind: 'dialog', cat: 'dialog', vi, ja, ans, ansJa }));
const ITEM_BY_ID = Object.fromEntries(ITEMS.map(it => [it.id, it]));

/* ---------- 保存 ---------- */

const state = {
  settings: { mode: 'home', earphone: false, rate: 0.9, count: 10, cats: [] },
  progress: {}, // id -> { box, due, ok, ng, last }
  daily: {},    // 'YYYY-MM-DD' -> 回答数
};

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) {
      Object.assign(state.settings, saved.settings || {});
      state.progress = saved.progress || {};
      state.daily = saved.daily || {};
    }
  } catch (e) { /* 保存領域が使えなくても動くようにする */ }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* noop */ }
}

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ---------- 間隔反復 ---------- */

function record(item, correct) {
  const p = state.progress[item.id] || { box: 0, due: 0, ok: 0, ng: 0, last: 0 };
  const now = Date.now();
  if (correct) {
    p.ok++;
    p.box = Math.min(p.box + 1, INTERVALS.length - 1);
  } else {
    p.ng++;
    p.box = 0;
  }
  p.due = now + INTERVALS[p.box] * DAY;
  p.last = now;
  state.progress[item.id] = p;
  const k = todayKey();
  state.daily[k] = (state.daily[k] || 0) + 1;
  save();
}

const isDue = it => { const p = state.progress[it.id]; return p && p.due <= Date.now(); };
const isNew = it => !state.progress[it.id];
const dueItems = () => ITEMS.filter(isDue);

/* ---------- ベトナム語の声調 ---------- */

// 平声(ngang) 下降(huyền) 上昇(sắc) 問(hỏi) 転(ngã) 重(nặng)
const TONE_MARKS = ['', '̀', '́', '̉', '̃', '̣'];
const TONE_NAMES = ['ngang（平らに）', 'huyền（低く下がる）', 'sắc（高く上がる）',
  'hỏi（下がって上がる）', 'ngã（途中で途切れて上がる）', 'nặng（低く短く止める）'];
const TONE_RE = /[̣̀́̃̉]/g;

function toneOf(str) {
  const m = str.normalize('NFD').match(TONE_RE);
  return m ? TONE_MARKS.indexOf(m[0]) : 0;
}
// 1文字の声調を付け替える
function setToneChar(ch, tone) {
  return (ch.normalize('NFD').replace(TONE_RE, '') + TONE_MARKS[tone]).normalize('NFC');
}
// 声調記号の付いた1音節の、他の声調の綴りを作る
function toneVariants(syllable) {
  const chars = [...syllable.normalize('NFC')];
  const pos = chars.findIndex(c => toneOf(c) > 0);
  if (pos < 0) return null;
  // p/t/c/ch で終わる音節は sắc と nặng しか取らない
  const tones = /(p|t|c|ch)$/i.test(syllable) ? [2, 5] : [0, 1, 2, 3, 4, 5];
  return tones.map(t => {
    const c = chars.slice();
    c[pos] = setToneChar(c[pos], t);
    return { tone: t, text: c.join('') };
  });
}

const VOWELS = 'aăâeêioôơuưy';
function isVowelChar(ch) {
  return VOWELS.includes(ch.normalize('NFD').replace(TONE_RE, '').normalize('NFC').toLowerCase());
}

/* ---------- 音声（読み上げ・音声認識） ---------- */

const Speech = {
  voice: null,
  ready: false,
  init() {
    if (!('speechSynthesis' in window)) { this.ready = true; return; }
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      this.voice = voices.find(v => /^vi([-_]|$)/i.test(v.lang)) || null;
      if (voices.length) this.ready = true;
      updateVoiceBanner();
    };
    pick();
    speechSynthesis.onvoiceschanged = pick;
    setTimeout(() => { this.ready = true; updateVoiceBanner(); }, 2000);
  },
  speak(text, rate) {
    return new Promise(resolve => {
      if (!('speechSynthesis' in window)) return resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'vi-VN';
      if (this.voice) u.voice = this.voice;
      u.rate = rate || state.settings.rate;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  },
  stop() { if ('speechSynthesis' in window) speechSynthesis.cancel(); },
};

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function recognize() {
  return new Promise((resolve, reject) => {
    if (!SR) return reject(new Error('unsupported'));
    const r = new SR();
    r.lang = 'vi-VN';
    r.interimResults = false;
    r.maxAlternatives = 5;
    let done = false;
    r.onresult = e => { done = true; resolve([...e.results[0]].map(a => a.transcript)); };
    r.onerror = e => { done = true; reject(new Error(e.error)); };
    r.onend = () => { if (!done) resolve([]); };
    r.start();
  });
}

// 家モード、またはイヤホン使用中なら音を出してよい
const audioAllowed = () => state.settings.mode === 'home' || state.settings.earphone;

function play(text, { auto = false, rate } = {}) {
  if (!audioAllowed()) {
    if (auto) return Promise.resolve();
    if (!confirm('電車モードです。音が出ますが再生しますか？\n（イヤホンを使うなら設定で「イヤホン使用」をONにしてください）')) {
      return Promise.resolve();
    }
  }
  return Speech.speak(text, rate);
}

/* ---------- 小さなユーティリティ ---------- */

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const pickOne = a => a[Math.floor(Math.random() * a.length)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function normalizeVi(s) {
  return s.normalize('NFC').toLowerCase().replace(/[.,!?;:"'“”…]/g, '').replace(/\s+/g, ' ').trim();
}
function similarity(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - d[m][n] / Math.max(m, n);
}

const speakerBtn = (text, label = '🔊') =>
  h('button', { class: 'icon-btn', type: 'button', 'aria-label': '再生', onclick: e => { e.stopPropagation(); play(text); } }, label);

/* ---------- 出題形式 ---------- */

const QTYPES = {
  mix:    { label: 'おまかせ練習', icon: '🎲', desc: 'いろいろな形式をまぜて出題' },
  vi2ja:  { label: '単語（ベトナム語→日本語）', icon: '🇻🇳', desc: '意味を4択で選ぶ' },
  ja2vi:  { label: '単語（日本語→ベトナム語）', icon: '🇯🇵', desc: 'ベトナム語を4択で選ぶ' },
  listen: { label: 'ヒアリング', icon: '🎧', desc: '聞いて意味を選ぶ', audio: true },
  tone:   { label: '声調の聞き分け', icon: '〰️', desc: '聞こえた声調の綴りを選ぶ', audio: true },
  spell:  { label: 'つづり（文字を選ぶ）', icon: '🔤', desc: '文字タイルを並べて綴る' },
  order:  { label: '文の並べ替え', icon: '🧩', desc: '単語を並べて文を作る' },
  dialog: { label: '会話の受け答え', icon: '💬', desc: '相手の発話に合う返事を選ぶ' },
  speak:  { label: '発話練習', icon: '🎤', desc: '声に出して言う' },
};

function eligible(item, qt) {
  switch (qt) {
    case 'vi2ja': case 'ja2vi': case 'speak':
      return item.kind !== 'dialog';
    case 'listen':
      return item.kind !== 'dialog' && audioAllowed();
    case 'tone':
      return audioAllowed() && item.kind === 'word' && !item.vi.includes(' ') && toneOf(item.vi) > 0;
    case 'spell':
      return item.kind === 'word' && item.vi.replace(/ /g, '').length <= 10;
    case 'order':
      return item.kind === 'phrase' && item.vi.split(' ').length >= 3;
    case 'dialog':
      return item.kind === 'dialog';
    case 'mix':
      return true;
  }
  return false;
}

function mixTypes(item) {
  const all = ['vi2ja', 'ja2vi', 'listen', 'tone', 'spell', 'order', 'dialog', 'speak'];
  return all.filter(t => eligible(item, t));
}

/* ---------- 出題セットを作る ---------- */

function inCats(item) {
  const cats = state.settings.cats;
  return !cats.length || cats.includes(item.cat);
}

function buildQueue(qt, reviewOnly = false) {
  const pool = ITEMS.filter(it => inCats(it) && eligible(it, qt));
  const n = state.settings.count;
  const byDue = (a, b) => state.progress[a.id].due - state.progress[b.id].due;
  const due = shuffle(pool.filter(isDue)).sort(byDue);
  let picked = due.slice(0, n);
  if (!reviewOnly) {
    // 新しい単語はカテゴリ順に少しずつ
    const fresh = pool.filter(isNew).slice(0, Math.min(MAX_NEW_PER_SESSION, n - picked.length));
    picked = picked.concat(fresh);
    if (picked.length < n) {
      // 足りないぶんは苦手なもの（箱が小さいもの）から追加練習
      const rest = shuffle(pool.filter(it => !picked.includes(it)))
        .sort((a, b) => (state.progress[a.id]?.box ?? 0) - (state.progress[b.id]?.box ?? 0));
      picked = picked.concat(rest.slice(0, n - picked.length));
    }
  }
  return shuffle(picked).map(item => {
    const type = qt === 'mix' ? pickOne(mixTypes(item)) : qt;
    return { item, type };
  });
}

/* ---------- 画面の切り替え ---------- */

const app = () => $('#app');
let session = null;

function go(hash) {
  if (location.hash === hash) render(); else location.hash = hash;
}

function render() {
  Speech.stop();
  const route = location.hash.replace(/^#\/?/, '') || 'home';
  renderHeader();
  const main = app();
  main.replaceChildren();
  window.scrollTo(0, 0);
  if (route === 'quiz' && session) renderQuiz(main);
  else if (route === 'result' && session) renderResult(main);
  else if (route === 'stats') renderStats(main);
  else if (route === 'list') renderList(main);
  else if (route === 'settings') renderSettings(main);
  else renderHome(main);
}

function renderHeader() {
  const seg = $('#mode-toggle');
  seg.replaceChildren(
    h('button', { type: 'button', class: state.settings.mode === 'home' ? 'on' : '', 'aria-pressed': String(state.settings.mode === 'home'),
      onclick: () => setMode('home') }, '🏠 家（声あり）'),
    h('button', { type: 'button', class: state.settings.mode === 'train' ? 'on' : '', 'aria-pressed': String(state.settings.mode === 'train'),
      onclick: () => setMode('train') }, '🚃 電車（声なし）'),
  );
  document.body.dataset.mode = state.settings.mode;
}

function setMode(mode) {
  if (state.settings.mode === mode) return;
  state.settings.mode = mode;
  save();
  if (session) {
    // 練習中に切り替えたら、今の問題から先を新しいモードに合わせて作り直す
    session.queue = session.queue.map((q, i) => {
      if (i < session.idx || eligible(q.item, q.type)) return q;
      return { item: q.item, type: pickOne(mixTypes(q.item)) };
    });
  }
  render();
}

/* ---------- ホーム ---------- */

function renderHome(main) {
  const dueN = dueItems().length;
  const seen = Object.keys(state.progress).length;
  const today = state.daily[todayKey()] || 0;
  const mode = state.settings.mode;

  main.append(...[
    h('div', { id: 'voice-banner' }),
    h('section', { class: 'summary' },
      stat(today, '今日の回答'),
      stat(dueN, '復習待ち'),
      stat(`${seen}/${ITEMS.length}`, '学習した語'),
    ),
    dueN ? h('button', { class: 'primary big', type: 'button', onclick: () => start('mix', true) },
      `🔁 今日の復習をする（${Math.min(dueN, state.settings.count)}問）`) : null,
    h('p', { class: 'mode-note' }, mode === 'home'
      ? '🏠 家モード：音声が自動で流れ、声に出す練習もできます。'
      : state.settings.earphone
        ? '🚃 電車モード（イヤホン使用）：声は出さずに、音声はイヤホンで聞きます。'
        : '🚃 電車モード：音は出しません。発話は「心の中で言う」練習になります。'),
    h('h2', {}, 'カテゴリ'),
    catChips(),
    h('h2', {}, '練習メニュー'),
    h('div', { class: 'menu' }, Object.entries(QTYPES).map(([qt, def]) => {
      const disabled = def.audio && !audioAllowed();
      const label = qt === 'speak' && mode === 'train' ? '心の中で発話' : def.label;
      const desc = disabled ? 'イヤホン使用をONにすると使えます'
        : qt === 'speak' && mode === 'train' ? '言ってみてから答えを確認' : def.desc;
      return h('button', { type: 'button', class: 'menu-item', disabled, onclick: () => start(qt) },
        h('span', { class: 'menu-icon', 'aria-hidden': 'true' }, def.icon),
        h('span', {}, h('strong', {}, label), h('small', {}, desc)));
    })),
    h('nav', { class: 'bottom-links' },
      h('a', { href: '#/list' }, '📖 単語一覧'),
      h('a', { href: '#/stats' }, '📊 記録'),
      h('a', { href: '#/settings' }, '⚙️ 設定')),
  ].filter(Boolean));
  updateVoiceBanner();
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label));
}

function catChips() {
  const cats = state.settings.cats;
  const wrap = h('div', { class: 'chips' });
  const toggle = id => {
    if (id === 'all') state.settings.cats = [];
    else if (cats.includes(id)) state.settings.cats = cats.filter(c => c !== id);
    else state.settings.cats = [...cats, id];
    save();
    render();
  };
  wrap.append(h('button', { type: 'button', class: `chip ${cats.length ? '' : 'on'}`, onclick: () => toggle('all') }, 'すべて'));
  for (const c of VN_CATEGORIES) {
    wrap.append(h('button', { type: 'button', class: `chip ${cats.includes(c.id) ? 'on' : ''}`, onclick: () => toggle(c.id) }, c.label));
  }
  return wrap;
}

function updateVoiceBanner() {
  const el = $('#voice-banner');
  if (!el || !Speech.ready) return;
  el.replaceChildren();
  if (!('speechSynthesis' in window)) {
    el.append(h('div', { class: 'banner' }, 'このブラウザは音声読み上げに対応していません。AndroidのChromeで開いてください。'));
  } else if (!Speech.voice) {
    el.append(h('details', { class: 'banner' },
      h('summary', {}, '⚠️ ベトナム語の音声が見つかりません（タップで設定方法）'),
      h('ol', {},
        h('li', {}, 'Androidの「設定」→「システム」→「言語と入力」→「テキスト読み上げの出力」を開く'),
        h('li', {}, '優先するエンジンを「Google音声サービス」にする'),
        h('li', {}, '⚙️ →「音声データをインストール」→「ベトナム語」をダウンロード'),
        h('li', {}, 'Chromeを一度閉じて、このページを開き直す')),
      h('small', {}, '※機種によってメニュー名が少し違うことがあります。')));
  }
}

/* ---------- 練習セッション ---------- */

function start(qt, reviewOnly = false) {
  const queue = buildQueue(qt, reviewOnly);
  if (!queue.length) {
    alert('このカテゴリには、この形式で出せる問題がありません。カテゴリを変えてみてください。');
    return;
  }
  session = { qt, reviewOnly, queue, idx: 0, results: [], retried: new Set() };
  go('#/quiz');
}

function renderQuiz(main) {
  const s = session;
  if (s.idx >= s.queue.length) { go('#/result'); return; }
  const q = s.queue[s.idx];
  // モード切替などで出せなくなった形式は差し替える
  if (!eligible(q.item, q.type)) q.type = pickOne(mixTypes(q.item));

  const total = s.queue.length;
  main.append(
    h('div', { class: 'quiz-top' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'やめる', onclick: () => { if (confirm('練習をやめますか？')) { session = null; go('#/'); } } }, '✕'),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(s.idx) },
        h('div', { style: `width:${(s.idx / total) * 100}%` })),
      h('span', { class: 'count' }, `${s.idx + 1}/${total}`)),
  );
  const card = h('section', { class: 'card' });
  main.append(card);
  const typeDef = QTYPES[q.type];
  card.append(h('p', { class: 'qtype' }, typeDef.icon, ' ',
    q.type === 'speak' && state.settings.mode === 'train' ? '心の中で発話' : typeDef.label));
  RENDERERS[q.type](card, q.item);
}

// 回答後：記録してフィードバックを表示
// 1回目の回答だけを記録する。間違えたものはセッションの最後にもう一度出す。
function commit(item, correct) {
  const s = session;
  if (s.retried.has(item.id)) return;
  record(item, correct);
  s.results.push({ item, correct });
  if (!correct) {
    s.retried.add(item.id);
    s.queue.push({ item, type: s.queue[s.idx].type });
  }
}

function answer(card, item, correct, { note, showAnswer = true } = {}) {
  commit(item, correct);
  const s = session;
  card.querySelector('.parts-hint')?.remove();
  card.querySelectorAll('.choices button, .tile').forEach(b => { b.disabled = true; });

  const vi = item.kind === 'dialog' ? item.ans : item.vi;
  const ja = item.kind === 'dialog' ? item.ansJa : item.ja;
  const fb = h('div', { class: `feedback ${correct ? 'ok' : 'ng'}`, role: 'status' },
    h('p', { class: 'verdict' }, correct ? '⭕ 正解！' : '❌ 残念…'),
    showAnswer ? h('div', { class: 'answer-line' },
      h('span', { class: 'vi', lang: 'vi' }, vi), speakerBtn(vi)) : null,
    showAnswer ? h('p', { class: 'ja' }, ja) : null,
    note ? h('p', { class: 'note' }, note) : null,
    ['vi2ja', 'spell'].includes(s.queue[s.idx].type) ? partsBlock(item) : null,
    h('button', { type: 'button', class: 'primary', onclick: next }, '次へ ▶'),
  );
  card.append(fb);
  fb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (showAnswer) play(vi, { auto: true });
}

function next() {
  session.idx++;
  render();
}

/* ---------- 語の成り立ち（複合語を音節に分けて解説） ---------- */

function partsOf(item) {
  const p = item.kind === 'word' && window.VN_PARTS && VN_PARTS[item.vi];
  return p && p.length ? p : null;
}

// mask=true のときは音節のつづりを隠し、答えのヒントになる補足メモも出さない
function partsBlock(item, { mask = false } = {}) {
  const parts = partsOf(item);
  if (!parts) return null;
  const rows = parts.filter(Array.isArray);
  const note = mask ? null : parts.find(x => typeof x === 'string');
  return h('div', { class: 'parts' },
    h('p', { class: 'parts-title' }, '💡 語の成り立ち'),
    rows.length ? h('div', { class: 'parts-list' }, rows.map(([syl, han, mean], i) =>
      h('div', { class: 'part' },
        h('span', { class: 'part-syl', lang: 'vi' }, mask ? `${i + 1}語目` : syl),
        h('span', { class: `part-han${han ? '' : ' none'}`, 'aria-label': han ? '元の漢字' : '漢字なし' }, han || '—'),
        h('span', { class: 'part-mean' }, mean)))) : null,
    note ? h('p', { class: 'parts-note' }, note) : null);
}

// 解説があるときだけ「見る」ボタンを出す
function partsHint(card, item, mask) {
  if (!partsOf(item)) return;
  const box = h('div', { class: 'parts-hint' });
  box.append(h('button', { type: 'button', class: 'link-btn',
    onclick: () => box.replaceChildren(partsBlock(item, { mask })) }, '💡 語の成り立ちを見る'));
  card.append(box);
}

/* ---------- 各形式の画面 ---------- */

function distractors(item, key, n = 3) {
  const others = ITEMS.filter(it => it.kind === item.kind && it.id !== item.id
    && it.vi.toLowerCase() !== item.vi.toLowerCase() && it.ja !== item.ja);
  const same = shuffle(others.filter(it => it.cat === item.cat));
  const diff = shuffle(others.filter(it => it.cat !== item.cat));
  const out = [];
  const seen = new Set([item[key]]);
  for (const it of [...same, ...diff]) {
    if (out.length >= n) break;
    if (seen.has(it[key])) continue;
    seen.add(it[key]);
    out.push(it);
  }
  return out;
}

function choiceList(card, options, onPick, { vi = false } = {}) {
  const list = h('div', { class: 'choices' });
  for (const opt of options) {
    const btn = h('button', { type: 'button', lang: vi ? 'vi' : null, class: vi ? 'vi' : '' }, opt.label);
    btn.addEventListener('click', () => {
      const ok = onPick(opt);
      btn.classList.add(ok ? 'correct' : 'wrong');
      if (!ok) list.querySelectorAll('button').forEach(b => { if (b.dataset.correct) b.classList.add('correct'); });
    });
    if (opt.correct) btn.dataset.correct = '1';
    list.append(btn);
  }
  card.append(list);
}

const RENDERERS = {
  vi2ja(card, item) {
    card.append(h('div', { class: 'prompt' },
      h('span', { class: 'vi big-text', lang: 'vi' }, item.vi), speakerBtn(item.vi)));
    play(item.vi, { auto: true });
    partsHint(card, item, false);
    const opts = shuffle([{ label: item.ja, correct: true },
      ...distractors(item, 'ja').map(d => ({ label: d.ja }))]);
    choiceList(card, opts, o => { answer(card, item, !!o.correct); return !!o.correct; });
  },

  ja2vi(card, item) {
    card.append(h('div', { class: 'prompt' }, h('span', { class: 'big-text' }, item.ja)));
    const opts = shuffle([{ label: item.vi, correct: true },
      ...distractors(item, 'vi').map(d => ({ label: d.vi }))]);
    choiceList(card, opts, o => { answer(card, item, !!o.correct); return !!o.correct; }, { vi: true });
  },

  listen(card, item) {
    card.append(listenButton(item.vi));
    const opts = shuffle([{ label: item.ja, correct: true },
      ...distractors(item, 'ja').map(d => ({ label: d.ja }))]);
    choiceList(card, opts, o => { answer(card, item, !!o.correct); return !!o.correct; });
  },

  tone(card, item) {
    const variants = toneVariants(item.vi);
    const correctTone = toneOf(item.vi);
    const others = shuffle(variants.filter(v => v.tone !== correctTone)).slice(0, 3);
    const opts = shuffle([variants.find(v => v.tone === correctTone), ...others])
      .map(v => ({ label: v.text, correct: v.tone === correctTone }));
    card.append(listenButton(item.vi));
    card.append(h('p', { class: 'hint' }, '聞こえた声調の綴りはどれ？'));
    choiceList(card, opts, o => {
      answer(card, item, !!o.correct, { note: `声調：${TONE_NAMES[correctTone]}` });
      return !!o.correct;
    }, { vi: true });
  },

  spell(card, item) {
    card.append(h('div', { class: 'prompt' }, h('span', { class: 'big-text' }, item.ja),
      audioAllowed() ? speakerBtn(item.vi) : null));
    const target = [...item.vi.normalize('NFC').replace(/ /g, '')];
    // ダミー：声調だけ違う文字と、別の母音
    const extras = [];
    const tonedIdx = target.findIndex(c => toneOf(c) > 0);
    const vowelIdx = tonedIdx >= 0 ? tonedIdx : target.findIndex(isVowelChar);
    if (vowelIdx >= 0) {
      const base = target[vowelIdx];
      const tones = shuffle([0, 1, 2, 3, 4, 5].filter(t => t !== toneOf(base))).slice(0, 2);
      for (const t of tones) extras.push(setToneChar(base, t));
    }
    extras.push(pickOne([...'aeiouơưê'].filter(c => !target.includes(c))));
    const syllables = item.vi.split(' ');
    if (syllables.length > 1) {
      card.append(h('p', { class: 'hint' }, `${syllables.length}語（文字数 ${syllables.map(w => [...w].length).join(' + ')}）`));
    }
    partsHint(card, item, true);
    tileQuiz(card, item, target, shuffle([...target, ...extras]), '');
  },

  order(card, item) {
    card.append(h('div', { class: 'prompt' }, h('span', { class: 'big-text' }, item.ja)));
    const words = item.vi.replace(/[.!?]$/, '').split(' ');
    const punct = (item.vi.match(/[.!?]$/) || [''])[0];
    let tiles = shuffle(words);
    if (tiles.join(' ') === words.join(' ')) tiles = tiles.reverse();
    tileQuiz(card, item, words, tiles, ' ', punct);
  },

  dialog(card, item) {
    const hint = h('p', { class: 'ja hidden' }, item.ja);
    card.append(
      h('div', { class: 'bubble', lang: 'vi' }, h('span', { class: 'vi' }, item.vi), speakerBtn(item.vi)),
      h('button', { type: 'button', class: 'link-btn', onclick: e => { hint.classList.remove('hidden'); e.target.remove(); } }, '日本語を見る'),
      hint,
      h('p', { class: 'hint' }, 'どう返事する？'));
    play(item.vi, { auto: true });
    const others = shuffle(ITEMS.filter(it => it.kind === 'dialog' && it.ans !== item.ans)).slice(0, 3);
    const opts = shuffle([{ label: item.ans, correct: true }, ...others.map(o => ({ label: o.ans }))]);
    choiceList(card, opts, o => { answer(card, item, !!o.correct); return !!o.correct; }, { vi: true });
  },

  speak(card, item) {
    if (state.settings.mode === 'train') return silentSpeak(card, item);
    card.append(h('div', { class: 'prompt column' },
      h('span', { class: 'big-text' }, item.ja),
      h('span', { class: 'vi', lang: 'vi' }, item.vi)));
    const status = h('p', { class: 'hint', role: 'status' }, 'お手本を聞いてから、🎤を押して話してください。');
    const micBtn = h('button', { type: 'button', class: 'primary big' }, '🎤 話す');
    const selfGrade = h('div', { class: 'row hidden' },
      h('button', { type: 'button', class: 'secondary', onclick: () => { selfGrade.remove(); micBtn.remove(); answer(card, item, true, { showAnswer: false }); } }, '⭕ 言えた'),
      h('button', { type: 'button', class: 'secondary', onclick: () => { selfGrade.remove(); micBtn.remove(); answer(card, item, false); } }, '❌ 言えなかった'));
    card.append(
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'secondary', onclick: () => play(item.vi) }, '🔊 お手本'),
        h('button', { type: 'button', class: 'secondary', onclick: () => play(item.vi, { rate: 0.6 }) }, '🐢 ゆっくり')),
      micBtn, status, selfGrade);
    play(item.vi, { auto: true });

    if (!SR) {
      micBtn.remove();
      status.textContent = 'この端末では音声認識が使えません。声に出して言ってから、自分で判定してください。';
      selfGrade.classList.remove('hidden');
      return;
    }
    micBtn.addEventListener('click', async () => {
      Speech.stop();
      micBtn.disabled = true;
      micBtn.textContent = '👂 聞いています…';
      try {
        const heard = await recognize();
        const target = normalizeVi(item.vi);
        const best = heard.map(t => ({ t, score: similarity(normalizeVi(t), target) }))
          .sort((a, b) => b.score - a.score)[0];
        if (best && best.score >= 0.85) {
          micBtn.remove();
          answer(card, item, true, { note: `認識：「${best.t}」`, showAnswer: false });
          return;
        }
        status.textContent = best ? `認識：「${best.t}」　もう一度話すか、自分で判定してください。`
          : '聞き取れませんでした。もう一度話してください。';
      } catch (e) {
        status.textContent = e.message === 'not-allowed'
          ? 'マイクの使用が許可されていません。Chromeの設定でマイクを許可してください。'
          : '音声認識でエラーが起きました（ネット接続が必要です）。自分で判定してください。';
      }
      micBtn.disabled = false;
      micBtn.textContent = '🎤 もう一度話す';
      selfGrade.classList.remove('hidden');
    });
  },
};

function listenButton(text) {
  const wrap = h('div', { class: 'listen' },
    h('button', { type: 'button', class: 'listen-btn', 'aria-label': 'もう一度聞く', onclick: () => play(text) }, '🔊'),
    h('button', { type: 'button', class: 'link-btn', onclick: () => play(text, { rate: 0.6 }) }, '🐢 ゆっくり'));
  setTimeout(() => play(text, { auto: true }), 250);
  return wrap;
}

// 電車モードの発話練習：心の中で言ってから答えを確認
function silentSpeak(card, item) {
  card.append(h('div', { class: 'prompt' }, h('span', { class: 'big-text' }, item.ja)),
    h('p', { class: 'hint' }, 'ベトナム語で心の中で言ってみましょう（口の形だけ動かすのも効果的）。'));
  const reveal = h('div', { class: 'hidden reveal' },
    h('div', { class: 'answer-line' }, h('span', { class: 'vi big-text', lang: 'vi' }, item.vi), speakerBtn(item.vi)),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'secondary', onclick: () => { commit(item, true); next(); } }, '⭕ 言えた'),
      h('button', { type: 'button', class: 'secondary', onclick: () => { reveal.remove(); answer(card, item, false); } }, '❌ 言えなかった')));
  card.append(
    h('button', { type: 'button', class: 'primary big', onclick: e => { e.target.remove(); reveal.classList.remove('hidden'); play(item.vi, { auto: true }); } }, '答えを見る'),
    reveal);
}

// タイルを選んで並べる問題（つづり・並べ替え共通）
function tileQuiz(card, item, target, tiles, joiner, suffix = '') {
  const picked = []; // tile index の列
  const slot = h('div', { class: `slot ${joiner ? 'words' : 'letters'}`, lang: 'vi', 'aria-live': 'polite' });
  const pool = h('div', { class: 'tiles', lang: 'vi' });
  const checkBtn = h('button', { type: 'button', class: 'primary', disabled: true }, '答え合わせ');
  const clearBtn = h('button', { type: 'button', class: 'secondary' }, 'やり直す');

  const draw = () => {
    slot.replaceChildren(...(picked.length ? picked.map((ti, pi) =>
      h('button', { type: 'button', class: 'tile placed', onclick: () => { picked.splice(pi, 1); draw(); } }, tiles[ti]))
      : [h('span', { class: 'placeholder' }, 'タイルをタップして並べる')]));
    pool.replaceChildren(...tiles.map((t, ti) =>
      h('button', { type: 'button', class: 'tile', disabled: picked.includes(ti),
        onclick: () => { picked.push(ti); draw(); } }, t)));
    checkBtn.disabled = picked.length !== target.length;
  };
  checkBtn.addEventListener('click', () => {
    const got = picked.map(i => tiles[i]).join(joiner);
    const ok = got === target.join(joiner);
    checkBtn.remove();
    clearBtn.remove();
    slot.classList.add(ok ? 'correct' : 'wrong');
    answer(card, item, ok, { note: ok ? null : `あなたの答え：${got}${suffix}` });
  });
  clearBtn.addEventListener('click', () => { picked.length = 0; draw(); });
  draw();
  card.append(slot, pool, h('div', { class: 'row' }, clearBtn, checkBtn));
}

/* ---------- 結果 ---------- */

function renderResult(main) {
  const r = session.results;
  const ok = r.filter(x => x.correct).length;
  const wrong = r.filter(x => !x.correct);
  const { qt, reviewOnly } = session;
  main.append(h('section', { class: 'card center' },
    h('p', { class: 'score' }, `${ok} / ${r.length}`),
    h('p', {}, ok === r.length ? 'パーフェクト！🎉' : ok / r.length >= 0.7 ? 'よくできました！' : '復習して覚えていきましょう。'),
    wrong.length ? h('div', { class: 'wrong-list' },
      h('h2', {}, '間違えた問題'),
      wrong.map(({ item }) => wordRow(item))) : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'secondary', onclick: () => { session = null; go('#/'); } }, 'ホームへ'),
      h('button', { type: 'button', class: 'primary', onclick: () => start(qt, reviewOnly) }, 'もう一度'))));
}

function wordRow(item) {
  const p = state.progress[item.id];
  return h('div', { class: 'word-row' },
    speakerBtn(item.vi),
    h('span', { class: 'vi', lang: 'vi' }, item.vi),
    h('span', { class: 'ja' }, item.ja),
    h('span', { class: 'level', title: '習熟度' }, p ? '★'.repeat(Math.min(p.box, 5)) + '☆'.repeat(Math.max(0, 5 - p.box)) : '—'));
}

/* ---------- 記録 ---------- */

function renderStats(main) {
  const seen = ITEMS.filter(it => state.progress[it.id]);
  const mastered = seen.filter(it => state.progress[it.id].box >= MASTERED_BOX);
  const days = Object.keys(state.daily).length;
  const weak = seen.filter(it => state.progress[it.id].ng > 0)
    .sort((a, b) => {
      const pa = state.progress[a.id], pb = state.progress[b.id];
      return (pb.ng - pb.ok * 0.5) - (pa.ng - pa.ok * 0.5) || pa.box - pb.box;
    }).slice(0, 15);
  const last7 = [...Array(7)].map((_, i) => {
    const d = new Date(Date.now() - (6 - i) * DAY);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, n: state.daily[k] || 0 };
  });
  const maxN = Math.max(1, ...last7.map(d => d.n));

  main.append(
    h('h1', {}, '📊 記録'),
    h('section', { class: 'summary' },
      stat(seen.length, '学習した'), stat(mastered.length, '習得（★3以上）'), stat(days, '学習した日数')),
    h('h2', {}, '最近7日の回答数'),
    h('div', { class: 'bars' }, last7.map(d => h('div', { class: 'bar' },
      h('span', { class: 'bar-n' }, d.n || ''),
      h('div', { class: 'bar-fill', style: `height:${(d.n / maxN) * 100}%` }),
      h('span', { class: 'bar-label' }, d.label)))),
    h('h2', {}, 'カテゴリ別の習得'),
    h('div', { class: 'cat-progress' }, VN_CATEGORIES.map(c => {
      const all = ITEMS.filter(it => it.cat === c.id);
      const m = all.filter(it => (state.progress[it.id]?.box ?? 0) >= MASTERED_BOX).length;
      const s = all.filter(it => state.progress[it.id]).length;
      return h('div', { class: 'cat-row' },
        h('span', {}, c.label),
        h('div', { class: 'meter' },
          h('div', { class: 'meter-seen', style: `width:${(s / all.length) * 100}%` }),
          h('div', { class: 'meter-done', style: `width:${(m / all.length) * 100}%` })),
        h('span', { class: 'meter-n' }, `${m}/${all.length}`));
    })),
    h('p', { class: 'legend' }, h('i', { class: 'sw done' }), '習得　', h('i', { class: 'sw seen' }), '学習中'),
    h('h2', {}, '苦手な単語・表現'),
    weak.length ? h('div', {}, weak.map(wordRow)) : h('p', { class: 'hint' }, 'まだありません。'),
    h('a', { class: 'back', href: '#/' }, '← ホームへ'),
  );
}

/* ---------- 単語一覧 ---------- */

function renderList(main) {
  main.append(h('h1', {}, '📖 単語一覧'));
  for (const c of VN_CATEGORIES) {
    const items = ITEMS.filter(it => it.cat === c.id);
    main.append(h('details', { class: 'list-group' },
      h('summary', {}, `${c.label}（${items.length}）`),
      items.map(it => it.kind === 'dialog'
        ? h('div', { class: 'dialog-row' }, wordRow(it),
          h('div', { class: 'word-row reply' }, speakerBtn(it.ans), h('span', { class: 'vi', lang: 'vi' }, '↳ ' + it.ans), h('span', { class: 'ja' }, it.ansJa), h('span', {})))
        : wordRow(it))));
  }
  main.append(h('a', { class: 'back', href: '#/' }, '← ホームへ'));
}

/* ---------- 設定 ---------- */

function renderSettings(main) {
  const st = state.settings;
  const set = (k, v) => { st[k] = v; save(); render(); };
  const radio = (k, options) => h('div', { class: 'seg' }, options.map(([v, label]) =>
    h('button', { type: 'button', class: st[k] === v ? 'on' : '', onclick: () => set(k, v) }, label)));

  main.append(
    h('h1', {}, '⚙️ 設定'),
    h('section', { class: 'card settings' },
      h('h2', {}, '電車モードでのイヤホン使用'),
      h('p', { class: 'hint' }, 'ONにすると、電車モードでもヒアリング・声調問題が出題され、音声が自動で流れます（発話はしません）。'),
      radio('earphone', [[false, 'OFF（音を出さない）'], [true, 'ON（イヤホンで聞く）']]),
      h('h2', {}, '1回の問題数'),
      radio('count', [[5, '5問'], [10, '10問'], [20, '20問']]),
      h('h2', {}, '読み上げの速さ'),
      radio('rate', [[0.7, 'ゆっくり'], [0.9, 'ふつう'], [1.1, '速め']]),
      h('h2', {}, '音声のテスト'),
      h('p', { class: 'hint' }, Speech.voice ? `使用中の音声：${Speech.voice.name}` : 'ベトナム語の音声が見つかりません（ホーム画面の案内を見てください）。'),
      h('button', { type: 'button', class: 'secondary', onclick: () => play('Xin chào, tôi đang học tiếng Việt.') }, '🔊 再生してみる'),
      h('p', { class: 'hint' }, SR ? '🎤 音声認識：使えます（ネット接続が必要）' : '🎤 音声認識：この端末では使えません（発話は自己判定になります）'),
      h('h2', {}, '学習記録'),
      h('button', { type: 'button', class: 'danger', onclick: () => {
        if (confirm('学習記録をすべて消去します。よろしいですか？')) {
          state.progress = {}; state.daily = {}; save(); render();
        }
      } }, '記録をリセット')),
    h('a', { class: 'back', href: '#/' }, '← ホームへ'),
  );
}

/* ---------- 起動 ---------- */

load();
Speech.init();
window.addEventListener('hashchange', render);
render();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// テスト用に一部を公開
window.__vn = { toneVariants, toneOf, setToneChar, ITEMS, buildQueue, state };
