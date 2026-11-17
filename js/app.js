/* ============================================================
   app.js — 状態管理・描画
   保存先: localStorage（キー sanlevel.v2）
   ・各レベルのプロンプトは server/prompts.js（サーバー側）で管理し、
     利用者は編集・変更できない。
   ============================================================ */
(function () {
  'use strict';

  const LEVELS = window.PersonaLab.LEVELS;
  const Engine = window.PersonaEngine;

  const STORE_KEY = 'sanlevel.v2';
  const OLD_STORE_KEY = 'sanlevel.v1';          // 旧バージョンの会話を引き継ぐ
  const STORE_FALLBACK = 'sanlevel.backup.v2';  // 破損時退避用（消さない）

  /* ---------------- 初期状態 ---------------- */
  function defaultState() {
    const chats = {};
    LEVELS.forEach(function (l) { chats[l.id] = []; });
    return { version: 2, activeLevel: 1, chats: chats };
  }

  function cleanChat(arr) {
    return (Array.isArray(arr) ? arr : []).filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string';
    }).map(function (m) {
      return {
        role: m.role,
        text: m.text,
        html: typeof m.html === 'string' ? m.html : null,
        ts: Number(m.ts) || Date.now(),
        meta: m.meta && typeof m.meta === 'object' ? m.meta : null
      };
    });
  }

  /* ---------------- 保存・読込 ---------------- */
  let storageWarning = '';

  function loadState() {
    const fresh = defaultState();
    let raw = null;
    try {
      raw = localStorage.getItem(STORE_KEY) || localStorage.getItem(OLD_STORE_KEY);
    } catch (e) {
      storageWarning = 'このブラウザでは保存機能が使えません。会話はページを閉じると消えます。';
      return fresh;
    }
    if (!raw) return fresh;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      try { localStorage.setItem(STORE_FALLBACK, raw); } catch (e2) { /* 何もしない */ }
      storageWarning = '保存データを読み取れなかったため、元のデータを退避して新しく開始しました。';
      return fresh;
    }

    const state = fresh;
    state.activeLevel = Number(parsed.activeLevel) || 1;
    LEVELS.forEach(function (l) {
      state.chats[l.id] = cleanChat(parsed.chats && parsed.chats[l.id]);
    });
    if (!state.chats[state.activeLevel]) state.activeLevel = 1;
    return state;
  }

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      if (!storageWarning) {
        storageWarning = '保存に失敗しました（ブラウザの空き容量をご確認ください）。';
        toast(storageWarning);
      }
    }
  }

  let state = loadState();

  /* ---------------- DOM ---------------- */
  const $ = function (id) { return document.getElementById(id); };

  const el = {
    body: document.body,
    levelList: $('levelList'),
    messages: $('messages'),
    chips: $('chips'),
    form: $('composerForm'),
    input: $('input'),
    send: $('btnSend'),
    chatAvatar: $('chatAvatar'),
    chatName: $('chatName'),
    drawer: $('drawer'),
    scrim: $('scrim'),
    dataMeta: $('dataMeta'),
    toast: $('toast'),
    handoffModal: $('handoffModal'),
    handoffPreview: $('handoffPreview'),
    handoffList: $('handoffList')
  };

  let drawerOpen = false;
  let busy = false;

  /* ---------------- ユーティリティ ---------------- */
  function levelMeta(id) {
    return LEVELS.filter(function (l) { return l.id === id; })[0] || LEVELS[0];
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 許可タグのみ残す（インポートされた html 対策）
  const ALLOWED = /^(p|ul|li|strong|em|br)$/i;
  function sanitizeHtml(html) {
    return String(html).replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, function (tag, name) {
      if (!ALLOWED.test(name)) return '';
      return tag.charAt(1) === '/' ? '</' + name.toLowerCase() + '>' : '<' + name.toLowerCase() + '>';
    });
  }

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('is-visible'); }, 2600);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function truncate(text, n) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* ---------------- 描画：レベルタブ ---------------- */
  function renderLevels() {
    el.levelList.innerHTML = LEVELS.map(function (l) {
      const count = state.chats[l.id].length;
      const selected = l.id === state.activeLevel;
      return '' +
        '<button class="level" type="button" role="tab" data-level="' + l.id + '"' +
          ' aria-selected="' + (selected ? 'true' : 'false') + '"' +
          ' aria-controls="messages" tabindex="' + (selected ? '0' : '-1') + '"' +
          ' style="--level-color:' + l.color + ';--level-tint:' + l.tint + '">' +
          '<span class="level__icon" aria-hidden="true">' + esc(l.emoji) + '</span>' +
          '<span class="level__body">' +
            '<span class="level__name">' + esc(l.name) + '</span>' +
          '</span>' +
          '<span class="level__count">' + (count ? count + '件' : '新規') + '</span>' +
        '</button>';
    }).join('');

    Array.prototype.forEach.call(el.levelList.querySelectorAll('.level'), function (btn) {
      btn.addEventListener('click', function () {
        const id = Number(btn.dataset.level);
        if (id === state.activeLevel) return;
        switchLevel(id);
      });
      btn.addEventListener('keydown', function (ev) {
        const idx = LEVELS.map(function (l) { return l.id; }).indexOf(state.activeLevel);
        let next = null;
        if (ev.key === 'ArrowRight') next = LEVELS[(idx + 1) % LEVELS.length].id;
        if (ev.key === 'ArrowLeft') next = LEVELS[(idx - 1 + LEVELS.length) % LEVELS.length].id;
        if (next !== null) { ev.preventDefault(); switchLevel(next); document.querySelector('.level[data-level="' + next + '"]').focus(); }
      });
    });
  }

  function switchLevel(id) {
    state.activeLevel = id;
    saveState();
    renderAll();
    if (drawerOpen) renderDataMeta();
    el.input.focus();
  }

  /* ---------------- 描画：ヘッダ ---------------- */
  function renderHeader() {
    const meta = levelMeta(state.activeLevel);
    el.chatAvatar.textContent = meta.emoji;
    el.chatName.textContent = meta.name;
    document.title = meta.name + '｜さんレベル相談室';
  }

  function renderChips() {
    const meta = levelMeta(state.activeLevel);
    el.chips.innerHTML = meta.chips.map(function (c) {
      return '<button class="chip" type="button" data-chip="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    Array.prototype.forEach.call(el.chips.querySelectorAll('.chip'), function (b) {
      b.addEventListener('click', function () {
        el.input.value = b.dataset.chip;
        autoGrow();
        el.input.focus();
      });
    });
  }

  /* ---------------- 描画：メッセージ ---------------- */
  function aiArticle(meta, bodyHtml, metaHtml, extraClass) {
    return '' +
      '<article class="msg msg--ai' + (extraClass ? ' ' + extraClass : '') + '">' +
        '<span class="avatar" aria-hidden="true">' + esc(meta.emoji) + '</span>' +
        '<div class="msg__body">' +
          '<div class="bubble">' + bodyHtml + '</div>' +
          (metaHtml ? '<div class="msg__meta">' + metaHtml + '</div>' : '') +
        '</div>' +
      '</article>';
  }

  function renderMessages() {
    const chat = state.chats[state.activeLevel];
    const meta = levelMeta(state.activeLevel);

    if (!chat.length) {
      el.messages.innerHTML = aiArticle(meta, '<p>' + esc(meta.greeting) + '</p>',
        '<span>' + esc(meta.name) + '</span>');
      return;
    }

    el.messages.innerHTML = chat.map(function (m) {
      if (m.role === 'user') {
        return '' +
          '<article class="msg msg--user">' +
            '<div class="msg__body">' +
              '<div class="bubble"><p>' + esc(m.text).replace(/\n/g, '<br>') + '</p></div>' +
              '<div class="msg__meta"><span>' + fmtTime(m.ts) + '</span></div>' +
            '</div>' +
          '</article>';
      }
      const body = m.html ? sanitizeHtml(m.html) : '<p>' + esc(m.text).replace(/\n/g, '<br>') + '</p>';
      return aiArticle(meta, body, '<span>' + esc(meta.name) + '</span><span>' + fmtTime(m.ts) + '</span>');
    }).join('');
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(function () {
      el.messages.scrollTop = el.messages.scrollHeight;
    });
  }

  /* ---------------- 送信 ---------------- */
  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 140) + 'px';
  }

  function setBusy(on) {
    busy = on;
    el.send.disabled = on;
  }

  async function submit() {
    const text = el.input.value.trim();
    if (!text || busy) return;
    const levelId = state.activeLevel;
    const chat = state.chats[levelId];
    const meta = levelMeta(levelId);

    const history = chat.slice();
    chat.push({ role: 'user', text: text, html: null, ts: Date.now(), meta: null });
    el.input.value = '';
    autoGrow();
    saveState();
    renderMessages();
    renderLevels();
    setBusy(true);

    // タイピング表示（応答中に別レベルへ移動しても、元のレベルに保存される）
    const typing = document.createElement('div');
    typing.innerHTML = aiArticle(meta, '<div class="typing"><span></span><span></span><span></span></div>');
    const typingEl = typing.firstChild;
    el.messages.appendChild(typingEl);
    scrollToBottom();

    try {
      const reply = await Engine.respond({
        level: levelId,
        history: history,
        text: text
      });
      chat.push({
        role: 'assistant', text: reply.plain, html: reply.html,
        ts: Date.now(), meta: null
      });
      saveState();
    } catch (err) {
      // 失敗した発言は残し、エラーは画面にだけ表示する（保存しない）
      if (state.activeLevel === levelId) {
        typingEl.remove();
        renderMessages();
        el.messages.insertAdjacentHTML('beforeend',
          aiArticle(meta, '<p>' + esc(err.message) + '</p>', '<span>エラー</span>', 'msg--error'));
        scrollToBottom();
      } else {
        toast(meta.name + '：' + err.message);
      }
      setBusy(false);
      return;
    } finally {
      typingEl.remove();
    }
    setBusy(false);
    if (state.activeLevel === levelId) renderMessages();
    renderLevels();
    if (drawerOpen) renderDataMeta();
  }

  /* ---------------- 会話データのドロワー ---------------- */
  function renderDataMeta() {
    const all = LEVELS.reduce(function (n, l) { return n + state.chats[l.id].length; }, 0);
    const cur = state.chats[state.activeLevel].length;
    el.dataMeta.textContent = levelMeta(state.activeLevel).level + 'の発言数：' + cur + '件／全レベル合計：' + all + '件';
  }

  function openDrawer() {
    drawerOpen = true;
    renderDataMeta();
    el.drawer.classList.add('is-open');
    el.drawer.setAttribute('aria-hidden', 'false');
    el.scrim.hidden = false;
    requestAnimationFrame(function () { el.scrim.classList.add('is-visible'); });
  }

  function closeDrawer() {
    drawerOpen = false;
    el.drawer.classList.remove('is-open');
    el.drawer.setAttribute('aria-hidden', 'true');
    el.scrim.classList.remove('is-visible');
    setTimeout(function () { if (!drawerOpen) el.scrim.hidden = true; }, 260);
  }

  /* ---------------- データ操作 ---------------- */
  function exportData() {
    const payload = {
      app: 'sanlevel-consult', version: 2, exportedAt: new Date().toISOString(),
      chats: state.chats
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    a.href = url;
    a.download = 'sanlevel-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('エクスポートしました');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = function () {
      let data;
      try {
        data = JSON.parse(String(reader.result));
      } catch (e) {
        toast('JSONの読み込みに失敗しました');
        return;
      }
      if (!data || !data.chats) {
        toast('このアプリのエクスポートファイルではありません');
        return;
      }
      const incoming = data.chats;
      const counts = LEVELS.map(function (l) {
        return state.chats[l.id].length + '→' + ((incoming[l.id] || []).length);
      }).join(' / ');

      if (!window.confirm('取り込みます。現在の会話は上書きされます（件数 現在→取込：' + counts + '）。よろしいですか？')) return;

      LEVELS.forEach(function (l) {
        state.chats[l.id] = cleanChat(incoming[l.id]);
      });
      saveState();
      renderAll();
      renderDataMeta();
      toast('取り込みました');
    };
    reader.readAsText(file);
  }

  function clearLevelChat() {
    const meta = levelMeta(state.activeLevel);
    const n = state.chats[state.activeLevel].length;
    if (!n) { toast('このレベルの会話はまだありません'); return; }
    if (!window.confirm('「' + meta.name + '」の会話 ' + n + '件を削除します。元に戻せません。よろしいですか？')) return;
    state.chats[state.activeLevel] = [];
    saveState();
    renderMessages();
    renderLevels();
    renderDataMeta();
    toast(meta.name + 'の会話を削除しました');
  }

  /* ---------------- 他のレベルにも聞く ---------------- */
  function openHandoff() {
    const chat = state.chats[state.activeLevel];
    const lastUser = chat.slice().reverse().filter(function (m) { return m.role === 'user'; })[0];
    if (!lastUser) { toast('先にこのレベルで相談内容を送ってください'); return; }

    el.handoffPreview.textContent = truncate(lastUser.text, 220);
    const others = LEVELS.filter(function (l) { return l.id !== state.activeLevel; });
    el.handoffList.innerHTML = others.map(function (l) {
      return '<button class="handoff-item" type="button" data-level="' + l.id + '"' +
        ' style="--item-color:' + l.color + ';--item-tint:' + l.tint + '">' +
        '<span class="handoff-item__icon" aria-hidden="true">' + esc(l.emoji) + '</span>' +
        '<span><span class="handoff-item__name">' + esc(l.name) + '</span>' +
        '</span>' +
      '</button>';
    }).join('');
    Array.prototype.forEach.call(el.handoffList.querySelectorAll('.handoff-item'), function (b) {
      b.addEventListener('click', function () {
        const id = Number(b.dataset.level);
        closeHandoff();
        switchLevel(id);
        el.input.value = lastUser.text;
        autoGrow();
        el.input.focus();
        toast(levelMeta(id).name + 'の入力欄に引き継ぎました。送信すると応答します');
      });
    });
    el.handoffModal.hidden = false;
    el.handoffModal.querySelector('.handoff-item').focus();
  }

  function closeHandoff() {
    el.handoffModal.hidden = true;
  }

  /* ---------------- 初期描画 ---------------- */
  function renderAll() {
    el.body.dataset.level = String(state.activeLevel);
    renderLevels();
    renderHeader();
    renderChips();
    renderMessages();
  }

  function init() {
    renderAll();

    // 入力
    el.form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    el.input.addEventListener('input', autoGrow);
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });

    // ドロワー
    $('btn-open-data').addEventListener('click', openDrawer);
    $('btnCloseDrawer').addEventListener('click', closeDrawer);
    el.scrim.addEventListener('click', closeDrawer);

    // データ
    $('btnExport').addEventListener('click', exportData);
    $('importFile').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = '';
    });
    $('btnClearLevel').addEventListener('click', clearLevelChat);

    // ハンドオフ
    $('btn-handoff').addEventListener('click', openHandoff);
    $('btnCloseHandoff').addEventListener('click', closeHandoff);
    el.handoffModal.addEventListener('click', function (e) {
      if (e.target === el.handoffModal) closeHandoff();
    });

    // Esc
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!el.handoffModal.hidden) { closeHandoff(); return; }
      if (drawerOpen) closeDrawer();
    });

    // 複数タブ間の同期
    window.addEventListener('storage', function (e) {
      if (e.key !== STORE_KEY || !e.newValue || busy) return;
      state = loadState();
      renderAll();
      if (drawerOpen) renderDataMeta();
    });

    autoGrow();
    if (storageWarning) toast(storageWarning);
    el.input.focus({ preventScroll: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
