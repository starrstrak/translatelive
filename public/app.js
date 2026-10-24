// Interface TranslateLive: capture audio -> découpage -> serveur -> affichage / voix.
const $ = (id) => document.getElementById(id);
const els = Object.fromEntries(
  ['source','target','output','engine','voice','status','stop','meter','meterWrap','text-in','send-text','log-orig','log-tr','copy','clear']
    .map((id) => [id, $(id)]),
);

const SAMPLE_RATE = 16000;
const MIN_CHUNK_S = 2.5;      // durée minimale avant de couper sur un silence
const MAX_CHUNK_S = 9;        // coupe forcée
const SILENCE_S = 0.5;        // silence qui déclenche la coupe
const SILENCE_RMS = 0.012;    // en dessous = silence
const SPEECH_RMS = 0.02;      // un chunk sans aucune fenêtre au-dessus est jeté

let mode = 'screen';
let session = null;           // { stream, ctx, node, chunker }
let seq = 0;                  // numéro d'envoi
let nextShown = 0;            // prochain numéro à afficher (ordre garanti)
const done = new Map();
let lastTranslation = '';

// ---------- init ----------
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

async function init() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  if (!cfg.ready) setStatus('Clé API serveur manquante (voir .env.example)', 'err');
  els.source.innerHTML = '<option value="auto">Détection auto</option>';
  for (const [code, name] of Object.entries(cfg.langs)) {
    els.source.add(new Option(name, code));
    els.target.add(new Option(name, code));
  }
  for (const k of ['source', 'target', 'output', 'engine', 'voice']) {
    els[k].value = store.get('tl_' + k, els[k].value) || els[k].value;
    els[k].addEventListener('change', () => { store.set('tl_' + k, els[k].value); syncVoiceOpts(); });
  }
  if (els.target.value === els.source.value || !els.target.value) els.target.value = 'en';
  syncVoiceOpts();
}

function syncVoiceOpts() {
  const voice = els.output.value !== 'text';
  document.querySelectorAll('.voice-opt').forEach((e) => (e.hidden = !voice));
  els.voice.parentElement.hidden = !voice || els.engine.value !== 'openai';
}

function setStatus(msg, cls = '') {
  els.status.textContent = msg;
  els.status.className = 'status ' + cls;
}

// ---------- onglets ----------
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    if (session) return;
    mode = t.dataset.mode;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    for (const m of ['screen', 'mic', 'text']) $('pane-' + m).hidden = m !== mode;
  }),
);

// ---------- capture ----------
async function start(kind) {
  if (session) return;
  let stream;
  try {
    if (kind === 'screen') {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!stream.getAudioTracks().length) {
        stream.getTracks().forEach((t) => t.stop());
        return setStatus("Aucun audio partagé: cochez « Partager l'audio de l'onglet »", 'err');
      }
      stream.getVideoTracks().forEach((t) => { t.onended = stop; });
      stream.getAudioTracks().forEach((t) => { t.onended = stop; });
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    }
  } catch (e) {
    return setStatus('Capture refusée: ' + e.message, 'err');
  }

  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunker = makeChunker(ctx.sampleRate, onChunk);
  node.onaudioprocess = (e) => {
    chunker.push(e.inputBuffer.getChannelData(0));
    els.meter.style.width = Math.min(100, chunker.level * 800) + '%';
  };
  // Le noeud doit être relié à la sortie pour tourner, mais muet (l'audio original joue déjà ailleurs)
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node); node.connect(mute); mute.connect(ctx.destination);

  session = { stream, ctx, node, chunker };
  els.stop.hidden = false; els.meterWrap.hidden = false;
  document.querySelectorAll('.pane button.primary').forEach((b) => (b.disabled = true));
  setStatus('● En direct', 'live');
}

function stop() {
  if (!session) return;
  session.chunker.flush();
  session.stream.getTracks().forEach((t) => t.stop());
  session.node.disconnect();
  session.ctx.close();
  session = null;
  els.stop.hidden = true; els.meterWrap.hidden = true; els.meter.style.width = '0';
  document.querySelectorAll('.pane button.primary').forEach((b) => (b.disabled = false));
  setStatus('Arrêté');
}

// Découpe le flux en phrases (coupe sur silence) et encode en WAV 16 kHz mono.
function makeChunker(inRate, emit) {
  let buf = [];
  let len = 0;
  let silent = 0;
  let heard = false;
  const api = {
    level: 0,
    push(samples) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      api.level = rms;
      const dur = samples.length / inRate;
      buf.push(new Float32Array(samples));
      len += dur;
      if (rms > SPEECH_RMS) heard = true;
      silent = rms < SILENCE_RMS ? silent + dur : 0;
      if (len >= MAX_CHUNK_S || (len >= MIN_CHUNK_S && silent >= SILENCE_S)) api.flush();
    },
    flush() {
      if (!len) return;
      const merged = new Float32Array(buf.reduce((n, b) => n + b.length, 0));
      let o = 0;
      for (const b of buf) { merged.set(b, o); o += b.length; }
      const had = heard;
      buf = []; len = 0; silent = 0; heard = false;
      if (had) emit(encodeWav(downsample(merged, inRate, SAMPLE_RATE), SAMPLE_RATE));
    },
  };
  return api;
}

function downsample(data, from, to) {
  if (from === to) return data;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(data.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += data[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

function encodeWav(samples, rate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); w(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: 'audio/wav' });
}

// ---------- envoi / affichage ordonné ----------
async function onChunk(wav) {
  const id = seq++;
  const rowO = addRow(els['log-orig'], '…'), rowT = addRow(els['log-tr'], '…');
  rowO.className = rowT.className = 'pending';
  const qs = new URLSearchParams({
    source: els.source.value, target: els.target.value, context: lastTranslation.slice(-200),
  });
  let result;
  try {
    const r = await fetch('/api/audio?' + qs, { method: 'POST', body: wav });
    result = await r.json();
    if (!r.ok) throw new Error(result.error);
  } catch (e) {
    result = { error: e.message };
  }
  done.set(id, { result, rowO, rowT });
  while (done.has(nextShown)) {
    const { result: res, rowO: ro, rowT: rt } = done.get(nextShown);
    done.delete(nextShown++);
    ro.className = rt.className = '';
    if (res.error) { ro.textContent = rt.textContent = ''; setStatus(res.error, 'err'); ro.remove(); rt.remove(); continue; }
    if (!res.original) { ro.remove(); rt.remove(); continue; }
    ro.textContent = res.original;
    rt.textContent = res.translation;
    lastTranslation += ' ' + res.translation;
    emitOutput(res.translation);
    els['log-orig'].scrollTop = els['log-orig'].scrollHeight;
    els['log-tr'].scrollTop = els['log-tr'].scrollHeight;
  }
}

function addRow(parent, text) {
  const p = document.createElement('p');
  p.textContent = text;
  parent.appendChild(p);
  parent.scrollTop = parent.scrollHeight;
  return p;
}

function emitOutput(text) {
  if (els.output.value !== 'text') speak(text);
}

// ---------- voix ----------
const speechQueue = [];
let speaking = false;
const MAX_QUEUE = 4; // reste "live": on abandonne les plus anciennes si la voix prend du retard

function speak(text) {
  speechQueue.push(text);
  while (speechQueue.length > MAX_QUEUE) speechQueue.shift();
  if (!speaking) pump();
}

async function pump() {
  speaking = true;
  while (speechQueue.length) {
    const text = speechQueue.shift();
    try {
      if (els.engine.value === 'openai') await playOpenAI(text);
      else await playBrowser(text);
    } catch (e) { setStatus('Voix: ' + e.message, 'err'); }
  }
  speaking = false;
}

function playBrowser(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const tag = { zh: 'zh-CN' }[els.target.value] || els.target.value;
    u.lang = tag;
    const v = speechSynthesis.getVoices().find((x) => x.lang.toLowerCase().startsWith(tag.toLowerCase().slice(0, 2)));
    if (v) u.voice = v;
    u.onend = u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

async function playOpenAI(text) {
  const r = await fetch('/api/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: els.voice.value }),
  });
  if (!r.ok) throw new Error((await r.json()).error);
  const url = URL.createObjectURL(await r.blob());
  const a = new Audio(url);
  await new Promise((resolve, reject) => { a.onended = resolve; a.onerror = () => reject(new Error('lecture impossible')); a.play().catch(reject); });
  URL.revokeObjectURL(url);
}

// ---------- texte saisi ----------
async function sendText() {
  const text = els['text-in'].value.trim();
  if (!text) return;
  els['text-in'].value = '';
  const ro = addRow(els['log-orig'], text), rt = addRow(els['log-tr'], '…');
  try {
    const r = await fetch('/api/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source: els.source.value, target: els.target.value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    rt.textContent = j.translation;
    lastTranslation += ' ' + j.translation;
    emitOutput(j.translation);
  } catch (e) {
    rt.textContent = ''; ro.remove(); rt.remove();
    setStatus(e.message, 'err');
  }
}

// ---------- câblage ----------
$('start-screen').onclick = () => start('screen');
$('start-mic').onclick = () => start('mic');
els.stop.onclick = stop;
els['send-text'].onclick = sendText;
els['text-in'].addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});
els.copy.onclick = () => navigator.clipboard?.writeText(els['log-tr'].innerText);
els.clear.onclick = () => { els['log-orig'].innerHTML = els['log-tr'].innerHTML = ''; lastTranslation = ''; speechSynthesis.cancel(); speechQueue.length = 0; };
speechSynthesis.getVoices();
init();
