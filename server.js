require('dotenv').config();
const express = require('express'), multer = require('multer');
const { spawn } = require('child_process'), dns = require('dns').promises;
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const E = process.env, KEY = E.GEMINI_API_KEY || '', MODEL = E.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_MIN = +E.MAX_DURATION_MIN || 120, TTL = (+E.FILE_TTL_HOURS || 6) * 36e5;
const WORKERS = +E.CONCURRENCY || 1, RATE = +E.RATE_PER_HOUR || 10, CHUNK = 600;
const DATA = path.join(__dirname, 'data');
const LANGS = { id: 'Indonesian', en: 'English', ms: 'Malay', ja: 'Japanese', ko: 'Korean', zh: 'Simplified Chinese', ar: 'Arabic', es: 'Spanish', fr: 'French', de: 'German' };
const PLATFORMS = [['YouTube', /(^|\.)(youtube\.com|youtu\.be)$/], ['TikTok', /(^|\.)tiktok\.com$/], ['Instagram', /(^|\.)instagram\.com$/], ['Facebook', /(^|\.)(facebook\.com|fb\.watch)$/], ['X', /(^|\.)(x|twitter)\.com$/]];
fs.rmSync(DATA, { recursive: true, force: true }); fs.mkdirSync(DATA, { recursive: true });

const jobs = new Map(), queue = [], hits = new Map(); let active = 0;
const ready = { ai: !!KEY, ffmpeg: false, ytdlp: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => String(s || 'video').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'video';
const platform = h => (PLATFORMS.find(p => p[1].test(h)) || [h.replace(/^www\./, '')])[0];

// ---------- util proses & jaringan ----------
function run(cmd, args, { cwd, onLine } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd }); let out = '', err = '';
    p.stdout.on('data', d => onLine ? String(d).split('\n').forEach(onLine) : out += d);
    p.stderr.on('data', d => err = (err + d).slice(-3000));
    p.on('error', e => rej(new Error(e.code === 'ENOENT' ? `${cmd} belum terpasang di server.` : e.message)));
    p.on('close', c => c ? rej(new Error(err.trim().split('\n').pop() || `${cmd} gagal (kode ${c})`)) : res(out));
  });
}
run('ffmpeg', ['-version']).then(() => ready.ffmpeg = true, () => {});
run('yt-dlp', ['--version']).then(() => ready.ytdlp = true, () => {});

const friendly = m => {
  m = KEY ? String(m).split(KEY).join('***') : String(m);
  if (/Unsupported URL/i.test(m)) return 'Situs/URL ini belum didukung untuk pemrosesan langsung. Unduh videonya lalu unggah file-nya.';
  if (/private video|sign in|log ?in|cookies|not a bot|age[- ]restrict|members[- ]only/i.test(m)) return 'Video bersifat privat/dibatasi, atau platform meminta login/anti-bot. Unggah file videonya sebagai alternatif.';
  if (/HTTP Error (403|404|410)|unavailable|removed|not exist|geo/i.test(m)) return 'Video tidak dapat diakses (dihapus, dibatasi wilayah, atau diblokir).';
  return m.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').slice(0, 300);
};

async function safeUrl(u) { // cegah SSRF ke jaringan internal
  if (!/^https?:$/.test(u.protocol)) throw new Error('Hanya link http/https yang didukung.');
  const ips = await dns.lookup(u.hostname, { all: true });
  if (ips.some(({ address }) => /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cde][0-9a-f]{2}:)/i.test(address.replace(/^::ffff:/i, ''))))
    throw new Error('Alamat tujuan tidak diizinkan.');
}

// ---------- Gemini (AI Studio: AIza..., Vertex Express: AQ....) ----------
async function gemini(parts, schema) {
  const base = KEY.startsWith('AQ.') ? 'https://aiplatform.googleapis.com/v1/publishers/google/models/' : 'https://generativelanguage.googleapis.com/v1beta/models/';
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${base}${MODEL}:generateContent?key=${KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: schema } })
      });
      const j = await r.json();
      if (!r.ok) { const e = new Error(j.error?.message || 'Gemini error ' + r.status); e.status = r.status; throw e; }
      return JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join(''));
    } catch (e) {
      if (i >= 3 || (e.status && e.status < 500 && e.status !== 429)) throw e;
      await sleep(2000 * 2 ** i);
    }
  }
}
const S_ASR = { type: 'OBJECT', properties: { language: { type: 'STRING' }, segments: { type: 'ARRAY', items: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['start', 'end', 'text'] } } }, required: ['language', 'segments'] };
const S_TR = { type: 'ARRAY', items: { type: 'OBJECT', properties: { i: { type: 'INTEGER' }, t: { type: 'STRING' } }, required: ['i', 't'] } };
const P_ASR = 'Transcribe all speech in this audio accurately and verbatim. Detect the spoken language (give its English name). Skip music and noise, never invent speech, and return an empty segments array if there is none. Split into short subtitle segments (one clause or sentence, at most ~14 words, 1-6 seconds each). Timestamps are relative to the start of THIS audio, formatted MM:SS.mmm, and must match exactly when the words are spoken.';
const P_TR = (from, to, ctx, items) => `You are a professional subtitle translator. Translate these subtitle lines from ${from} to ${to}.
Rules: write natural, idiomatic ${to} the way a native speaker would say it, never literal or machine-like; preserve meaning, tone, humor, emotion, idioms and speaker intent; keep proper names and technical terms that are normally left untranslated; keep lines short and easy to read; never merge, split, drop or reorder entries; return every entry with its original "i".
Context (previous lines, do not translate): ${ctx || '-'}
Entries: ${JSON.stringify(items)}`;

// ---------- subtitle ----------
const ts = v => typeof v === 'number' ? v : String(v).trim().split(':').reduce((a, p) => a * 60 + parseFloat(p.replace(',', '.')), 0);
const T = (s, c) => { const ms = Math.round(s * 1000), p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(ms / 36e5 | 0)}:${p(ms % 36e5 / 6e4 | 0)}:${p(ms % 6e4 / 1e3 | 0)}${c}${p(ms % 1e3, 3)}`; };
const wrap = t => { t = t.replace(/\s+/g, ' ').trim(); if (t.length <= 42) return t; const w = t.split(' '); let best = 0, bd = 1e9, len = 0; for (let i = 0; i < w.length - 1; i++) { len += w[i].length + 1; const d = Math.abs(len - (t.length - len)); if (d < bd) { bd = d; best = i; } } return w.slice(0, best + 1).join(' ') + '\n' + w.slice(best + 1).join(' '); };
const tidy = (s, dur) => { s.sort((a, b) => a.start - b.start); s.forEach((x, i) => { if (!(x.end > x.start)) x.end = x.start + Math.min(4, Math.max(1.2, x.text.length / 14)); const n = s[i + 1]; if (n && x.end > n.start) x.end = Math.max(x.start + .3, n.start - .02); x.end = Math.min(x.end, dur || 1e9); }); };
const tick = (l, dur, cb) => { const m = /^out_time_(?:us|ms)=(\d+)/.exec(l); if (m && dur) cb(Math.min(1, m[1] / 1e6 / dur)); };

// ---------- antrean ----------
function enqueue(j, fn) { queue.push({ j, fn }); pump(); }
function pump() { while (active < WORKERS && queue.length) { const t = queue.shift(); active++; t.fn().catch(() => {}).finally(() => { active--; pump(); }); } }
const limited = ip => { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 36e5); if (a.length >= RATE) return true; a.push(n); hits.set(ip, a); return false; };

// ---------- pipeline ----------
async function pipeline(j) {
  const set = (stage, p, message) => Object.assign(j, { stage, progress: Math.min(99, Math.round(p)), message });
  try {
    j.status = 'processing';
    if (j.url) { // 1. Fetching Video
      set('fetch', 2, `Mengambil video dari ${j.platform}…`);
      const base = ['--no-playlist', '--no-warnings', ...(E.YTDLP_COOKIES ? ['--cookies', E.YTDLP_COOKIES] : []), ...(E.YTDLP_ARGS || '').split(' ').filter(Boolean)];
      const meta = JSON.parse(await run('yt-dlp', [...base, '--dump-single-json', '--', j.url]));
      if (meta.is_live) throw new Error('Siaran langsung belum didukung.');
      if (meta.duration > MAX_MIN * 60) throw new Error(`Durasi video melebihi batas ${MAX_MIN} menit.`);
      j.title = meta.title || '';
      await run('yt-dlp', [...base, '--newline', '-f', 'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4', '-o', 'source.%(ext)s', '--', j.url],
        { cwd: j.dir, onLine: l => { const m = /\[download\]\s+([\d.]+)%/.exec(l); if (m) set('fetch', 3 + m[1] * .17, `Mengunduh video… ${Math.round(m[1])}%`); } });
    }
    const src = fs.readdirSync(j.dir).find(f => /^source\./.test(f) && !/\.(part|ytdl)$/.test(f));
    if (!src) throw new Error('File video tidak ditemukan setelah pengunduhan.');

    set('audio', 20, 'Memeriksa video…'); // 2. Extracting Audio
    j.duration = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src], { cwd: j.dir })) || 0;
    if (!j.duration) throw new Error('File video tidak valid atau rusak.');
    if (j.duration > MAX_MIN * 60) throw new Error(`Durasi video melebihi batas ${MAX_MIN} menit.`);
    const vc = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', src], { cwd: j.dir })).trim();
    if (!vc) throw new Error('File ini tidak memiliki track video.');
    if (vc !== 'h264' || !/\.mp4$/.test(src)) { // pastikan bisa diputar di semua browser
      await run('ffmpeg', ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', src, '-vf', "scale=-2:'min(1080,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'video.mp4'],
        { cwd: j.dir, onLine: l => tick(l, j.duration, p => set('audio', 20 + p * 7, 'Menyiapkan video untuk pemutar…')) });
      j.video = 'video.mp4';
    } else j.video = src;
    set('audio', 28, 'Mengekstrak audio…');
    await run('ffmpeg', ['-y', '-v', 'error', '-i', j.video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'segment', '-segment_time', String(CHUNK), '-reset_timestamps', '1', 'chunk%03d.mp3'], { cwd: j.dir });
    const chunks = fs.readdirSync(j.dir).filter(f => /^chunk\d+\.mp3$/.test(f)).sort();
    if (!chunks.length) throw new Error('Video tidak memiliki audio.');

    const segs = []; // 3. Transcribing (deteksi bahasa + timestamp)
    for (const [k, f] of chunks.entries()) {
      set('transcribe', 30 + 35 * k / chunks.length, `Mentranskripsi audio… (${k + 1}/${chunks.length})`);
      const r = await gemini([{ inlineData: { mimeType: 'audio/mp3', data: fs.readFileSync(path.join(j.dir, f)).toString('base64') } }, { text: P_ASR }], S_ASR);
      j.srcLang ||= r.language;
      for (const x of r.segments || []) { const text = String(x.text || '').trim(), start = ts(x.start) + k * CHUNK; if (text && isFinite(start)) segs.push({ start, end: ts(x.end) + k * CHUNK, text }); }
    }
    if (!segs.length) throw new Error('Tidak ditemukan percakapan pada video ini.');
    tidy(segs, j.duration);

    const to = LANGS[j.target]; // 4. Translating
    for (let i = 0; i < segs.length; i += 60) {
      set('translate', 65 + 25 * i / segs.length, `Menerjemahkan ke ${to}…`);
      const ctx = segs.slice(Math.max(0, i - 4), i).map(s => s.text).join(' / ');
      const r = await gemini([{ text: P_TR(j.srcLang || 'the original language', to, ctx, segs.slice(i, i + 60).map((s, k) => ({ i: i + k, t: s.text }))) }], S_TR);
      for (const x of r) if (segs[x.i] && x.t) segs[x.i].tr = String(x.t).trim();
    }

    set('subs', 92, 'Membuat subtitle…'); // 5. Generating Subtitles
    const cues = segs.map(s => ({ ...s, text: wrap(s.tr || s.text) }));
    const fmt = (c, vtt) => cues.map((s, i) => `${vtt ? '' : (i + 1) + '\n'}${T(s.start, c)} --> ${T(s.end, c)}\n${s.text}\n`).join('\n');
    fs.writeFileSync(path.join(j.dir, 'subs.srt'), fmt(',', 0));
    fs.writeFileSync(path.join(j.dir, 'subs.vtt'), 'WEBVTT\n\n' + fmt('.', 1));
    Object.assign(j, { status: 'done', stage: 'subs', progress: 100, message: 'Selesai' });
  } catch (e) {
    console.error(j.id, friendly(e.message));
    Object.assign(j, { status: 'error', error: friendly(e.message) });
  }
}

// ---------- render subtitle menyatu (hardcoded) ----------
function render(j, st) {
  const hx = (c, d) => (/^#[0-9a-f]{6}$/i.test(c) ? c.slice(1) : d).toUpperCase(), bgr = h => h.slice(4) + h.slice(2, 4) + h.slice(0, 2);
  const size = Math.min(48, Math.max(10, +st.size || 20)), bg = Math.min(1, Math.max(0, isNaN(+st.bg) ? .6 : +st.bg));
  const al = { top: 8, middle: 5, bottom: 2 }[st.pos] || 2, aa = Math.round((1 - bg) * 255).toString(16).padStart(2, '0').toUpperCase();
  const style = `FontName=Noto Sans,Bold=1,FontSize=${size},PrimaryColour=&H00${bgr(hx(st.color, 'FFFFFF'))},Alignment=${al},MarginV=${al === 5 ? 0 : 16},` +
    (bg ? `BorderStyle=3,Outline=3,Shadow=0,OutlineColour=&H${aa}000000,BackColour=&H${aa}000000` : 'BorderStyle=1,Outline=2,Shadow=1,OutlineColour=&H00000000,BackColour=&H80000000');
  const file = 'out_' + crypto.createHash('md5').update(style).digest('hex').slice(0, 10) + '.mp4';
  if (fs.existsSync(path.join(j.dir, file))) return void (j.render = { status: 'done', progress: 100, file });
  j.render = { status: 'queued', progress: 0 };
  enqueue(j, async () => {
    try {
      j.render.status = 'processing';
      await run('ffmpeg', ['-y', '-v', 'error', '-progress', 'pipe:1', '-nostats', '-i', j.video, '-vf', `subtitles=subs.srt:force_style='${style}'`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', file],
        { cwd: j.dir, onLine: l => tick(l, j.duration, p => j.render.progress = Math.round(p * 99)) });
      Object.assign(j.render, { status: 'done', progress: 100, file });
    } catch (e) { j.render = { status: 'error', error: friendly(e.message) }; }
  });
}

// ---------- HTTP ----------
const pub = j => ({ id: j.id, status: j.status, stage: j.stage, progress: j.progress, message: j.message, error: j.error, platform: j.platform, title: j.title, duration: j.duration, srcLang: j.srcLang, target: j.target, queuePos: queue.findIndex(t => t.j === j) + 1, render: j.render });
const app = express(); app.set('trust proxy', 1); app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/config', (q, r) => r.json({ langs: LANGS, maxMinutes: MAX_MIN, ttlHours: TTL / 36e5, ready }));

const up = multer({
  storage: multer.diskStorage({ destination: (q, f, cb) => cb(null, q.dir), filename: (q, f, cb) => cb(null, 'source' + (path.extname(f.originalname).toLowerCase().replace(/[^.\w]/g, '') || '.mp4')) }),
  limits: { fileSize: (+E.MAX_UPLOAD_MB || 500) * 1048576 }, fileFilter: (q, f, cb) => cb(null, /^video\//.test(f.mimetype))
});
app.post('/api/jobs', (q, r, n) => {
  if (limited(q.ip)) return r.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  q.id = crypto.randomBytes(9).toString('hex'); q.dir = path.join(DATA, q.id); fs.mkdirSync(q.dir, { recursive: true }); n();
}, up.single('file'), async (q, r) => {
  const fail = (c, m) => { fs.rmSync(q.dir, { recursive: true, force: true }); r.status(c).json({ error: m }); };
  try {
    const { url, target = 'id', consent } = q.body;
    if (!KEY) return fail(503, 'GEMINI_API_KEY belum diatur di server.');
    if (consent !== '1') return fail(400, 'Centang konfirmasi hak penggunaan video terlebih dahulu.');
    if (!LANGS[target]) return fail(400, 'Bahasa tujuan tidak didukung.');
    if (!q.file && !url) return fail(400, 'Masukkan link video atau unggah file video.');
    const j = { id: q.id, dir: q.dir, status: 'queued', stage: 'fetch', progress: 0, message: 'Menunggu antrean…', target, title: q.file ? q.file.originalname : '', created: Date.now() };
    if (q.file) j.platform = 'Unggahan';
    else { const u = new URL(url); await safeUrl(u); j.url = u.href; j.platform = platform(u.hostname); }
    jobs.set(j.id, j); enqueue(j, () => pipeline(j)); r.json(pub(j));
  } catch (e) { fail(400, /Invalid URL/.test(e.message) ? 'Link tidak valid.' : e.code === 'ENOTFOUND' ? 'Domain tidak ditemukan.' : e.message); }
});

app.param('id', (q, r, n, id) => (q.j = jobs.get(id)) ? n() : r.status(404).json({ error: 'Pekerjaan tidak ditemukan atau sudah kedaluwarsa. Mulai lagi.' }));
const need = (q, r, n) => q.j.status === 'done' ? n() : r.status(409).json({ error: 'Pekerjaan belum selesai.' });
app.get('/api/jobs/:id', (q, r) => r.json(pub(q.j)));
app.get('/api/jobs/:id/video', need, (q, r) => r.sendFile(path.join(q.j.dir, q.j.video)));
app.get('/api/jobs/:id/subs.:ext(srt|vtt)', need, (q, r) => {
  const ext = q.params.ext, f = path.join(q.j.dir, 'subs.' + ext);
  q.query.dl ? r.download(f, `${slug(q.j.title)}.${q.j.target}.${ext}`) : r.type(ext === 'vtt' ? 'text/vtt' : 'text/plain').sendFile(f);
});
app.post('/api/jobs/:id/render', need, (q, r) => { if (!q.j.render || ['done', 'error'].includes(q.j.render.status)) render(q.j, q.body || {}); r.json(pub(q.j)); });
app.get('/api/jobs/:id/download.mp4', need, (q, r) => q.j.render?.status === 'done'
  ? r.download(path.join(q.j.dir, q.j.render.file), `${slug(q.j.title)}.${q.j.target}.mp4`) : r.status(409).json({ error: 'Video belum dirender.' }));
app.use((e, q, r, n) => { if (q.dir) fs.rmSync(q.dir, { recursive: true, force: true }); r.status(400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file melebihi batas unggahan.' : e.message }); });

setInterval(() => { for (const [id, j] of jobs) if (Date.now() - j.created > TTL && j.status !== 'processing') { fs.rmSync(j.dir, { recursive: true, force: true }); jobs.delete(id); } }, 6e5).unref();
app.listen(E.PORT || 3000, () => console.log('VideoTranslate AI berjalan di port ' + (E.PORT || 3000)));
