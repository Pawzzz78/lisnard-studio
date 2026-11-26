// Studio, étape Extrait : bornes du début et de la fin, fenêtre de la barre zoomée, format des temps
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constrain, fmtTime, viewAround } from '../public/js/studio-range.js';

const L = { durationMs: 600_000, minMs: 3000, maxMs: 90_000 };

test('bornes : au dixième de seconde, au moins 3 s, au plus 90 s, jamais hors de la vidéo', () => {
  assert.deepEqual(constrain(12_345, 40_000, 'start', L), [12_300, 40_000]);
  assert.deepEqual(constrain(39_000, 40_000, 'start', L), [37_000, 40_000]); // 3 s minimum
  assert.deepEqual(constrain(10_000, 200_000, 'end', L), [10_000, 100_000]); // 90 s maximum
  assert.deepEqual(constrain(-5000, 20_000, 'start', L), [0, 20_000]);
  assert.deepEqual(constrain(590_000, 700_000, 'end', L), [590_000, 600_000]);
  // the whole extract moves without changing length, and stays inside the video
  assert.deepEqual(constrain(590_000, 620_000, 'both', L), [570_000, 600_000]);
  assert.deepEqual(constrain(-10_000, 20_000, 'both', L), [0, 30_000]);
});

test('vue zoomée : marge autour de l’extrait, au moins une minute, dans la vidéo', () => {
  assert.deepEqual(viewAround(100_000, 130_000, 600_000), { lo: 85_000, hi: 145_000 });
  const v = viewAround(0, 10_000, 600_000);
  assert.equal(v.lo, 0);
  assert.ok(v.hi - v.lo >= 60_000);
  const w = viewAround(590_000, 600_000, 600_000);
  assert.equal(w.hi, 600_000);
});

test('temps : minutes, secondes et dixième ; heures au-delà d’une heure', () => {
  assert.equal(fmtTime(754_300), '12:34,3');
  assert.equal(fmtTime(3_754_000, false), '1:02:34');
  assert.equal(fmtTime(5000), '0:05,0');
});
