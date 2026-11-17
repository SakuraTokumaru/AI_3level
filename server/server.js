/* ============================================================
   server/server.js — 画面の配信と、Claude API への中継
   ------------------------------------------------------------
   ・APIキーは環境変数 ANTHROPIC_API_KEY から読みます（.env に書く）。
     ブラウザ側のコードには一切書きません。
   ・ブラウザは「レベル」と「会話履歴」だけを送り、
     プロンプト本文はこのサーバーが server/prompts.js から付け足します。
   起動：npm start（= node --env-file=.env server/server.js）
   ============================================================ */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { resolvePrompt } from './prompts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.CLAUDE_EFFORT || 'medium'; // low / medium / high

const MAX_TEXT = 1200;       // 1メッセージの最大文字数（画面の maxlength と合わせる）
const MAX_HISTORY = 20;      // APIに送る直近の発言数
const RATE_LIMIT = 20;       // 1IPあたり1分間の最大リクエスト数

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[warn] ANTHROPIC_API_KEY が設定されていません。.env を確認してください。');
}
// ANTHROPIC_API_KEY を自動で読み込む。
// ワークスペースに属していないキーを使う場合は、ANTHROPIC_WORKSPACE_ID でワークスペースを指定する
const WORKSPACE_ID = (process.env.ANTHROPIC_WORKSPACE_ID || '').trim();
const client = new Anthropic(
  WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': WORKSPACE_ID } } : {}
);

/* ---------------- 静的ファイル（公開してよいものだけ） ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  // index.html と css/・js/ 配下だけを公開する（server/ や .env は絶対に返さない）
  if (!(p === '/index.html' || p.startsWith('/css/') || p.startsWith('/js/'))) return notFound(res);
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT + path.sep)) return notFound(res);
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    notFound(res);
  }
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

/* ---------------- 簡易レート制限 ---------------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_LIMIT;
}

async function readJson(req, limit = 100_000) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('too_large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/* ---------------- 会話履歴の整形 ---------------- */
// API は user / assistant が交互で、user から始まる必要があるため整える
function toApiMessages(history, text) {
  const raw = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.text.slice(0, 4000) }));
  raw.push({ role: 'user', content: text });

  const merged = [];
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else merged.push({ ...m });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

/* ---------------- /api/chat ---------------- */
async function handleChat(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) return sendJson(res, 429, { error: '短時間に送信が集中しています。少し待ってからお試しください。' });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: 'リクエストの形式が正しくありません。' });
  }

  const level = Number(body.level);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_TEXT) return sendJson(res, 400, { error: 'メッセージが空か、長すぎます。' });

  const system = resolvePrompt(level);
  if (!system) return sendJson(res, 400, { error: '不明な会話レベルです。' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return sendJson(res, 500, { error: 'サーバーにAPIキーが設定されていません（.env の ANTHROPIC_API_KEY）。' });
  }

  const messages = toApiMessages(body.history, text);
  try {
    const response = await callClaude(system, messages);

    if (response.stop_reason === 'refusal') {
      return sendJson(res, 200, {
        text: 'ごめんなさい、この内容にはお答えできませんでした。表現を変えて、もう一度話してみてください。'
      });
    }

    const reply = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return sendJson(res, 200, { text: reply || '（うまく返答を作れませんでした。もう一度送ってみてください）' });
  } catch (err) {
    const detail = apiErrorDetail(err);
    console.error('[api error]', err?.status ?? '', detail);
    return sendJson(res, 502, { error: friendlyError(err, detail) });
  }
}

/* ---------------- Claude API 呼び出し ---------------- */
let useFallbacks = process.env.CLAUDE_FALLBACKS !== 'off';

async function callClaude(system, messages) {
  const base = {
    model: MODEL,
    max_tokens: 4000,
    system: system,
    messages: messages,
    output_config: { effort: EFFORT }
  };
  if (useFallbacks) {
    try {
      // 安全フィルタで断られた場合、サーバー側で自動的に別モデルへ切り替える（ベータ機能）
      return await client.beta.messages.create({
        ...base,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default'
      });
    } catch (err) {
      // このアカウントでベータ機能が使えない場合は、以降は通常の呼び出しに切り替える
      if (err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(apiErrorDetail(err))) {
        console.warn('[info] fallbacks が使えないため、通常の呼び出しに切り替えます:', apiErrorDetail(err));
        useFallbacks = false;
      } else {
        throw err;
      }
    }
  }
  return client.messages.create(base);
}

function apiErrorDetail(err) {
  return String(err?.error?.error?.message || err?.message || err || '');
}

function friendlyError(err, detail) {
  const d = detail.toLowerCase();
  if (err instanceof Anthropic.AuthenticationError) {
    return 'APIキーが無効です。.env の ANTHROPIC_API_KEY を確認してください。';
  }
  if (d.includes('workspace')) {
    return 'このAPIキーはワークスペースに属していません。ワークスペースで作ったキーに替えるか、.env に ANTHROPIC_WORKSPACE_ID を設定してください。（詳細：' + detail + '）';
  }
  if (d.includes('credit balance')) {
    return 'APIの利用残高（クレジット）が足りません。platform.claude.com の「Billing」でクレジットを追加してください。';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'このAPIキーには利用権限がありません。（詳細：' + detail + '）';
  }
  if (err instanceof Anthropic.NotFoundError) {
    return '指定したモデル（' + MODEL + '）が使えません。.env の CLAUDE_MODEL を確認してください。（詳細：' + detail + '）';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'AIの利用回数の上限に達しました。少し待ってからお試しください。';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'AIに接続できませんでした。インターネット接続や、社内ネットワークの制限を確認してください。（詳細：' + detail + '）';
  }
  if (err?.status === 529 || err instanceof Anthropic.InternalServerError) {
    return 'AIが混み合っています。時間をおいてお試しください。';
  }
  return 'AIの応答でエラーが起きました。（詳細：' + (err?.status ? err.status + ' ' : '') + detail + '）';
}

/* ---------------- ルーティング ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/chat') return await handleChat(req, res);
    if (req.method === 'GET') return await serveStatic(req, res);
    res.writeHead(405).end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'サーバーエラーが発生しました。' });
  }
});

server.listen(PORT, () => {
  console.log(`さんレベル相談室: http://localhost:${PORT}  (model: ${MODEL})`);
});
