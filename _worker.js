// ============================================================
//  DOPA TAP ランキング サーバー（Cloudflare Pages の _worker.js）
//  データベース：D1（変数名 DB）／ テーブルは 自動で作られます
// ============================================================
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const HEX = (n) => new RegExp('^[0-9a-f]{' + n + '}$');
const isHex = (s, n) => typeof s === 'string' && HEX(n).test(s);
const int = (v) => (Number.isInteger(v) && v >= 0) ? v : -1;
async function sha256(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
function rid(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); }

// ---- なまえ：10文字まで・へんな文字は消す・よくないことばは 名無し（__noname__）に
const NG = ['死ね', 'しね', '殺す', 'ころす', 'ちんこ', 'ちんぽ', 'まんこ', 'セックス', 'sex', 'fuck', 'shit', 'nigger', 'kill', 'うんこ', 'ガイジ', 'がいじ', 'きちがい', 'キチガイ'];
function cleanName(s) {
  let n = [...String(s || '').normalize('NFKC')].filter(c => c >= ' ' && !/[<>&"'`\\]/.test(c)).join('').trim();
  n = [...n].slice(0, 10).join('');
  const low = n.toLowerCase();
  if (!n || NG.some(w => low.includes(w.toLowerCase()))) return '__noname__';
  return n;
}

// ---- 日本時間で「きょう」「こんしゅう」
function periodKeys(t = Date.now()) {
  const j = new Date(t + 9 * 3600e3);
  const ymd = d => d.toISOString().slice(0, 10);
  const mon = new Date(j); mon.setUTCDate(j.getUTCDate() - ((j.getUTCDay() + 6) % 7));
  return { day: 'd:' + ymd(j), week: 'w:' + ymd(mon), all: 'all' };
}

// ---- テーブル（はじめて動いたときに作る）
let ready = false;
async function ensure(db) {
  if (ready) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS players (pid TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT NOT NULL, last_at INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, pid TEXT NOT NULL, started INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS best (period TEXT NOT NULL, pid TEXT NOT NULL, name TEXT NOT NULL, score INTEGER NOT NULL, combo INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (period, pid))'),
    db.prepare('CREATE INDEX IF NOT EXISTS best_rank ON best (period, score DESC)'),
  ]);
  ready = true;
}

// ---- スコアが ありえる値か（ゲームの点数のしくみから計算した 上限）
function plausible(b) {
  const score = int(b.score), hits = int(b.hits), perf = int(b.perfects), jack = int(b.jackpots), combo = int(b.maxCombo), fev = int(b.fevers), dur = int(b.dur);
  if ([score, hits, perf, jack, combo, fev, dur].some(v => v < 0)) return 'bad_number';
  if (score % 10 !== 0 || hits > 5000) return 'bad_score';
  if (perf > hits || jack > hits || combo > hits || fev > hits) return 'bad_stats';
  let max = 0; for (let c = 1; c <= hits; c++) max += 6000 * (1 + Math.floor(c / 5));   // 1回の最大：PERFECT100 × FEVER3 × JACKPOT10 × 連続ボーナス2 × コンボ倍率
  if (score > max) return 'too_high';
  if (hits > 0 && dur < hits * 150) return 'too_fast';                                    // テンポ最大160 → 1タップ 最低0.15秒くらい
  return null;
}

async function start(req, env) {
  const b = await req.json().catch(() => ({}));
  if (!isHex(b.pid, 16)) return json({ ok: false, error: 'bad_pid' }, 400);
  const sid = rid(12);
  await env.DB.prepare('INSERT INTO sessions (sid, pid, started) VALUES (?, ?, ?)').bind(sid, b.pid, Date.now()).run();
  return json({ ok: true, sid });
}

async function submit(req, env) {
  const b = await req.json().catch(() => ({}));
  if (!isHex(b.pid, 16) || !isHex(b.token, 32) || !isHex(b.sid, 24)) return json({ ok: false, error: 'bad_request' }, 400);
  const bad = plausible(b); if (bad) return json({ ok: false, error: bad }, 400);
  const db = env.DB, now = Date.now(), name = cleanName(b.name), th = await sha256(b.token);
  // プレイヤー確認（はじめての人は登録）
  const p = await db.prepare('SELECT token, last_at FROM players WHERE pid = ?').bind(b.pid).first();
  if (p && p.token !== th) return json({ ok: false, error: 'forbidden' }, 403);
  if (p && now - p.last_at < 3000) return json({ ok: false, error: 'too_often' }, 429);
  // STARTの記録と くらべる（実際の時間より 長いプレイは ありえない）
  const s = await db.prepare('SELECT pid, started, used FROM sessions WHERE sid = ?').bind(b.sid).first();
  if (!s || s.pid !== b.pid || s.used) return json({ ok: false, error: 'bad_session' }, 400);
  if (now - s.started < b.dur * 0.9 - 3000) return json({ ok: false, error: 'bad_time' }, 400);
  const K = periodKeys(now), score = b.score, combo = b.maxCombo;
  const up = 'INSERT INTO best (period, pid, name, score, combo, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (period, pid) DO UPDATE SET score = excluded.score, combo = excluded.combo, name = excluded.name, at = excluded.at WHERE excluded.score > best.score';
  await db.batch([
    db.prepare('UPDATE sessions SET used = 1 WHERE sid = ?').bind(b.sid),
    p ? db.prepare('UPDATE players SET name = ?, last_at = ?, plays = plays + 1 WHERE pid = ?').bind(name, now, b.pid)
      : db.prepare('INSERT INTO players (pid, token, name, last_at, plays) VALUES (?, ?, ?, ?, 1)').bind(b.pid, th, name, now),
    db.prepare('UPDATE best SET name = ? WHERE pid = ?').bind(name, b.pid),
    ...[K.day, K.week, K.all].map(k => db.prepare(up).bind(k, b.pid, name, score, combo, now)),
    db.prepare('DELETE FROM sessions WHERE started < ?').bind(now - 6 * 3600e3),
  ]);
  const ranks = {};
  for (const [k, key] of Object.entries(K)) {
    const r = await db.prepare('SELECT b.score AS mine, (SELECT COUNT(*) FROM best x WHERE x.period = b.period AND x.score > b.score) + 1 AS rank FROM best b WHERE b.period = ? AND b.pid = ?').bind(key, b.pid).first();
    ranks[k] = r ? { rank: r.rank, best: r.mine } : null;
  }
  return json({ ok: true, name, ranks });
}

async function rename(req, env) {
  const b = await req.json().catch(() => ({}));
  if (!isHex(b.pid, 16) || !isHex(b.token, 32)) return json({ ok: false, error: 'bad_request' }, 400);
  const p = await env.DB.prepare('SELECT token FROM players WHERE pid = ?').bind(b.pid).first();
  const name = cleanName(b.name);
  if (!p) return json({ ok: true, name });   // まだ スコアを送っていない人は 手元だけ
  if (p.token !== await sha256(b.token)) return json({ ok: false, error: 'forbidden' }, 403);
  await env.DB.batch([env.DB.prepare('UPDATE players SET name = ? WHERE pid = ?').bind(name, b.pid), env.DB.prepare('UPDATE best SET name = ? WHERE pid = ?').bind(name, b.pid)]);
  return json({ ok: true, name });
}

async function ranking(req, env, ctx) {
  const url = new URL(req.url), per = ['day', 'week', 'all'].includes(url.searchParams.get('p')) ? url.searchParams.get('p') : 'day';
  const key = periodKeys()[per], pid = url.searchParams.get('pid');
  // 上位50人は 20秒だけ キャッシュ（データベースの よみこみを へらす）
  const cache = caches.default, ck = new Request(`${url.origin}/__rank/${key}`);
  let top = await cache.match(ck).then(r => r && r.json()).catch(() => null);
  if (!top) {
    const r = await env.DB.prepare('SELECT pid, name, score, combo FROM best WHERE period = ? ORDER BY score DESC, at ASC LIMIT 50').bind(key).all();
    top = r.results.map((x, i) => ({ rank: i + 1, pid: x.pid.slice(0, 6), name: x.name, score: x.score, combo: x.combo }));
    ctx.waitUntil(cache.put(ck, new Response(JSON.stringify(top), { headers: { 'Cache-Control': 'public, max-age=20' } })));
  }
  let me = null;
  if (isHex(pid, 16)) {
    const r = await env.DB.prepare('SELECT b.score AS score, (SELECT COUNT(*) FROM best x WHERE x.period = b.period AND x.score > b.score) + 1 AS rank FROM best b WHERE b.period = ? AND b.pid = ?').bind(key, pid).first();
    if (r) me = { rank: r.rank, score: r.score, tag: pid.slice(0, 6) };
  }
  return json({ ok: true, period: per, list: top, me });
}

// つながっている D1 を 見つける（変数名は DB でも dopatap でも、ほかの名前でも OK）
function findDB(env) {
  if (env.DB && typeof env.DB.prepare === 'function') return env.DB;
  if (env.dopatap && typeof env.dopatap.prepare === 'function') return env.dopatap;
  for (const k of Object.keys(env)) { const v = env[k]; if (v && typeof v.prepare === 'function' && typeof v.batch === 'function') return v; }
  return null;
}

export default {
  async fetch(req, env0, ctx) {
    const db = findDB(env0), env = { ...env0, DB: db, ASSETS: env0.ASSETS };
    const url = new URL(req.url), path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!db) return json({ ok: false, error: 'db_not_bound' }, 503);
    try {
      await ensure(env.DB);
      if (path === '/api/start' && req.method === 'POST') return await start(req, env);
      if (path === '/api/score' && req.method === 'POST') return await submit(req, env);
      if (path === '/api/name' && req.method === 'POST') return await rename(req, env);
      if (path === '/api/ranking' && req.method === 'GET') return await ranking(req, env, ctx);
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      return json({ ok: false, error: 'server' }, 500);
    }
  },
};
