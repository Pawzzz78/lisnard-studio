// Section « Edit » : temps forts d'un son (tempo, grille, temps forts, drops) sur des sons de synthèse, et cache en base.
// Nécessite ffmpeg ; le cache nécessite Postgres via DATABASE_URL (sinon ignoré).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { analyzeFile, analyzeSamples } from '../src/edit/beats.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
let dir;
const sound = (name, expr, d) => {
  const f = path.join(dir, `${name}.wav`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=${d}`, f]);
  return f;
};
// Clicks every `p` seconds from `t0`, the first of every 4 louder (`accent`), over a low drone
const clicks = (p, t0 = 0.1, accent = 1, quiet = 0.45) =>
  `if(gt(t,${t0})*lt(mod(t-${t0},${p}),0.02),if(lt(mod(t-${t0},${4 * p}),0.02),${accent},${quiet})*sin(2*PI*1500*t),0)+0.05*sin(2*PI*110*t)`;

before(async () => {
  if (hasFfmpeg) dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-beats-'));
});
after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

test('120 BPM : tempo, temps à moins de 25 ms, temps forts sur les clics accentués, analyse jugée sûre', { skip: !hasFfmpeg }, async () => {
  const r = await analyzeFile(sound('c120', clicks(0.5), 20));
  assert.ok(Math.abs(r.bpm - 120) <= 2, `${r.bpm} BPM`);
  assert.equal(r.reliable, true);
  assert.ok(r.beats.length >= 38);
  const off = (b, step) => Math.abs((b - 0.1) / step - Math.round((b - 0.1) / step)) * step; // distance to the nearest click
  r.beats.forEach((b, i) => assert.ok(off(b, 0.5) < 0.025, `temps ${i} à ${b}`));
  assert.ok(r.beats.every((b, i) => i === 0 || Math.abs(b - r.beats[i - 1] - 0.5) < 0.01), 'un temps toutes les 0,5 s');
  for (const i of r.strong) assert.ok(off(r.beats[i], 2) < 0.025, `temps fort à ${r.beats[i]} : un clic accentué`);
  assert.ok(Math.abs(r.duration - 20) < 0.05);
});

test('90 BPM aussi ; bruit sans pulsation : analyse jugée peu sûre', { skip: !hasFfmpeg }, async () => {
  const r = await analyzeFile(sound('c90', clicks(60 / 90, 0.3), 20));
  assert.ok(Math.abs(r.bpm - 90) <= 2, `${r.bpm} BPM`);
  assert.equal(r.reliable, true);
  const noise = path.join(dir, 'noise.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=12:c=pink:a=0.3', noise]);
  assert.equal((await analyzeFile(noise)).reliable, false);
});

test('drop : la mesure où la musique repart beaucoup plus fort', { skip: !hasFfmpeg }, async () => {
  // quiet clicks for 8 s, then four times louder
  const r = await analyzeFile(sound('drop', `if(gt(t,0.1)*lt(mod(t-0.1,0.5),0.02),sin(2*PI*1500*t),0)*if(gt(t,8.1),1,0.25)+0.3*(random(0)-0.5)`, 16));
  assert.ok(r.drops.length >= 1, 'un drop');
  const t = r.beats[r.drops[0]];
  assert.ok(t >= 7.5 && t <= 10.2, `drop à ${t} s`);
  assert.ok(r.strong.includes(r.drops[0]), 'sur un temps fort');
});

test('son trop court ou silencieux : pas de tempo, pas d’erreur', () => {
  const r = analyzeSamples(new Float32Array(11025));
  assert.deepEqual([r.bpm, r.beats.length, r.reliable], [null, 0, false]);
});

const enabled = Boolean(process.env.DATABASE_URL) && hasFfmpeg;
test('cache : analysé une seule fois par fichier, recalculé si le fichier change', { skip: !enabled }, async () => {
  const db = await import('../src/db.js');
  await db.initDb();
  const { trackBeats } = await import('../src/edit/beats.js');
  const file = sound('cache', clicks(0.5), 8);
  await db.pool.query("DELETE FROM music_beats WHERE track_id = 'test-edit-beats'");
  let calls = 0;
  const analyze = async (f) => {
    calls++;
    return analyzeFile(f);
  };
  const track = { id: 'test-edit-beats', path: file };
  const [a, b] = await Promise.all([trackBeats(track, { analyze }), trackBeats(track, { analyze })]);
  assert.equal(calls, 1, 'deux demandes en même temps : une seule analyse');
  assert.deepEqual(a, b);
  assert.deepEqual(await trackBeats(track, { analyze }), a);
  assert.equal(calls, 1, 'lu en base');
  await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
  await trackBeats(track, { analyze });
  assert.equal(calls, 2, 'fichier changé : nouvelle analyse');
  await db.pool.query("DELETE FROM music_beats WHERE track_id = 'test-edit-beats'");
  await db.pool.end();
});
