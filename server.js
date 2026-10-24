// Serveur TranslateLive: sert l'interface et proxy les appels OpenAI (la clé reste côté serveur).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

// Chargement minimal de .env (pas de dépendance)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const cfg = () => ({
  port: Number(process.env.PORT) || 3000,
  key: process.env.OPENAI_API_KEY,
  base: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  stt: process.env.STT_MODEL || 'gpt-4o-mini-transcribe',
  tr: process.env.TRANSLATE_MODEL || 'gpt-4o-mini',
  tts: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
});

export const LANGS = {
  fr: 'French', en: 'English', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese',
  nl: 'Dutch', ru: 'Russian', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  hi: 'Hindi', tr: 'Turkish', pl: 'Polish', uk: 'Ukrainian', mg: 'Malagasy', sv: 'Swedish',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Corps trop gros');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function openai(pathname, init) {
  const c = cfg();
  if (!c.key) throw new HttpError(500, 'OPENAI_API_KEY manquante côté serveur (voir .env.example)');
  const res = await fetch(c.base + pathname, {
    ...init,
    headers: { Authorization: `Bearer ${c.key}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new HttpError(502, `OpenAI ${res.status}: ${t.slice(0, 300)}`);
  }
  return res;
}

export async function transcribe(wav, source) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
  form.append('model', cfg().stt);
  if (source && source !== 'auto') form.append('language', source);
  const res = await openai('/audio/transcriptions', { method: 'POST', body: form });
  return ((await res.json()).text || '').trim();
}

export async function translate(text, source, target, context = '') {
  if (!text.trim()) return '';
  const tgt = LANGS[target] || target;
  const src = source && source !== 'auto' ? `from ${LANGS[source] || source} ` : '';
  const sys =
    `You are a live interpreter. Translate ${src}into ${tgt}. ` +
    'Output ONLY the translation, no notes, no quotes. Keep meaning, tone and names. ' +
    'The text is a fragment of continuous speech; do not complete or comment it. ' +
    'If it is already in the target language, return it unchanged.';
  const messages = [{ role: 'system', content: sys }];
  if (context) messages.push({ role: 'user', content: `Previous context (do not translate): ${context}` });
  messages.push({ role: 'user', content: text });
  const res = await openai('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg().tr, temperature: 0.2, messages }),
  });
  return ((await res.json()).choices?.[0]?.message?.content || '').trim();
}

function checkLangs(source, target) {
  if (source !== 'auto' && !LANGS[source]) throw new HttpError(400, 'Langue source inconnue');
  if (!LANGS[target]) throw new HttpError(400, 'Langue cible inconnue');
}

const json = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

async function api(req, res, url) {
  const q = url.searchParams;
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return json(res, 200, { langs: LANGS, ready: !!cfg().key });
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Méthode non permise');

  if (url.pathname === '/api/audio') {
    // Corps: WAV brut. Réponse: texte d'origine + traduction.
    const source = q.get('source') || 'auto';
    const target = q.get('target') || 'en';
    checkLangs(source, target);
    const wav = await readBody(req);
    if (wav.length < 1000) throw new HttpError(400, 'Audio vide');
    const original = await transcribe(wav, source);
    const translation = await translate(original, source, target, q.get('context') || '');
    return json(res, 200, { original, translation });
  }
  if (url.pathname === '/api/translate') {
    const { text = '', source = 'auto', target = 'en' } = JSON.parse((await readBody(req, 1e6)).toString() || '{}');
    checkLangs(source, target);
    if (text.length > 5000) throw new HttpError(400, 'Texte trop long (5000 max)');
    return json(res, 200, { translation: await translate(text, source, target) });
  }
  if (url.pathname === '/api/tts') {
    const { text = '', voice = 'alloy' } = JSON.parse((await readBody(req, 1e6)).toString() || '{}');
    if (!text.trim() || text.length > 4000) throw new HttpError(400, 'Texte invalide');
    const r = await openai('/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg().tts, voice, input: text, response_format: 'mp3' }),
    });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  throw new HttpError(404, 'Route inconnue');
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'Interdit');
      const data = await fs.promises.readFile(file).catch(() => null);
      if (!data) throw new HttpError(404, 'Introuvable');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e.message);
      json(res, status, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port, key } = cfg();
  createServer().listen(port, () => {
    console.log(`TranslateLive: http://localhost:${port}`);
    if (!key) console.warn('⚠ OPENAI_API_KEY absente: copier .env.example vers .env');
  });
}
