import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Faux OpenAI local
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.url === '/audio/transcriptions') {
    assert.match(body.toString('latin1'), /name="language"\r\n\r\nfr/);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ text: 'Bonjour tout le monde' }));
  }
  if (req.url === '/chat/completions') {
    const msgs = JSON.parse(body).messages;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ choices: [{ message: { content: 'T:' + msgs.at(-1).content } }] }));
  }
  if (req.url === '/audio/speech') { res.setHeader('Content-Type', 'audio/mpeg'); return res.end(Buffer.from([1, 2, 3])); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => fake.listen(0, r));
process.env.OPENAI_API_KEY = 'test';
process.env.OPENAI_BASE_URL = `http://localhost:${fake.address().port}`;

const { createServer } = await import('../server.js');
const app = createServer();
await new Promise((r) => app.listen(0, r));
const base = `http://localhost:${app.address().port}`;
test.after(() => { app.close(); fake.close(); });

test('config liste les langues', async () => {
  const j = await (await fetch(base + '/api/config')).json();
  assert.equal(j.ready, true);
  assert.equal(j.langs.fr, 'French');
});

test('audio -> texte + traduction', async () => {
  const r = await fetch(base + '/api/audio?source=fr&target=en', { method: 'POST', body: Buffer.alloc(2000) });
  assert.deepEqual(await r.json(), { original: 'Bonjour tout le monde', translation: 'T:Bonjour tout le monde' });
});

test('traduction de texte', async () => {
  const r = await fetch(base + '/api/translate', { method: 'POST', body: JSON.stringify({ text: 'salut', target: 'es' }) });
  assert.deepEqual(await r.json(), { translation: 'T:salut' });
});

test('tts renvoie de l\'audio', async () => {
  const r = await fetch(base + '/api/tts', { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await r.arrayBuffer()).byteLength, 3);
});

test('langue invalide -> 400, audio vide -> 400, traversal -> 403/404', async () => {
  assert.equal((await fetch(base + '/api/audio?target=xx', { method: 'POST', body: Buffer.alloc(2000) })).status, 400);
  assert.equal((await fetch(base + '/api/audio?target=en', { method: 'POST', body: Buffer.alloc(10) })).status, 400);
  const t = await fetch(base + '/..%2Fserver.js');
  assert.ok([403, 404].includes(t.status));
});

test('sert l\'interface', async () => {
  const r = await fetch(base + '/');
  assert.match(await r.text(), /TranslateLive/);
});
