/* ============================================================
   engine.js — サーバー（/api）とのやり取り
   ・ブラウザはプロンプト本文もAPIキーも持たない。
   ・「レベル」と「会話履歴」をサーバーに送り、
     サーバーが Claude API に問い合わせた結果を受け取る。
   ============================================================ */
(function (global) {
  'use strict';

  const API_BASE = ''; // 別ドメインのサーバーを使う場合は 'https://example.com' のように指定

  /**
   * 応答を生成する
   * @param {{level:number, history:Array, text:string}} args
   * @returns {Promise<{html:string, plain:string}>}
   */
  async function respond(args) {
    let res;
    try {
      res = await fetch(API_BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          level: args.level,
          text: args.text,
          history: (args.history || []).map(function (m) { return { role: m.role, text: m.text }; })
        })
      });
    } catch (e) {
      throw new Error('サーバーに接続できませんでした。サーバーが起動しているか確認してください。');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 下で処理 */ }
    if (!res.ok || !data || typeof data.text !== 'string') {
      throw new Error((data && data.error) || 'AIの応答を受け取れませんでした。');
    }
    return { plain: data.text, html: toHtml(data.text) };
  }

  /* ---------------- 簡易マークダウン → 安全なHTML ---------------- */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function inline(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }
  function toHtml(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = [];
    const flushPara = function () { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
    const flushList = function () { if (list.length) { out.push('<ul>' + list.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</ul>'); list = []; } };
    lines.forEach(function (raw) {
      const line = raw.replace(/^#{1,6}\s+/, ''); // 見出し記号は外して普通の行として扱う
      const li = line.match(/^\s*(?:[-*・]|\d+[.)．])\s+(.*)$/);
      if (li) { flushPara(); list.push(li[1]); return; }
      if (!line.trim()) { flushPara(); flushList(); return; }
      flushList();
      para.push(line.trim());
    });
    flushPara(); flushList();
    return out.join('');
  }

  global.PersonaEngine = { respond: respond, toHtml: toHtml };
})(window);
