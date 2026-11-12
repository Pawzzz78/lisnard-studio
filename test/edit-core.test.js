// Section « Edit » : validation des modèles, passage du son, chronologie du montage et textes (module pur).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EDIT, EditError, RECIPES, beatWindow, editAss, planEdit, sanitizeTemplate, templateFromRecipe } from '../public/js/edit-core.js';

/** Analyse d'un son régulier : `bpm`, premier temps à `offset`, temps forts tous les 4 temps, drops donnés (indices). */
const grid = (bpm, { offset = 0.1, n = 200, drops = [] } = {}) => {
  const p = 60 / bpm;
  const beats = Array.from({ length: n }, (_, i) => Math.round((offset + i * p) * 1000) / 1000);
  return { bpm, beats, strong: beats.map((_, i) => i).filter((i) => i % 4 === 0), drops, reliable: true };
};
const tpl = (over = {}) => sanitizeTemplate({ ...templateFromRecipe('punch', { name: 'Essai', track_id: 'son', start_s: 0, length_beats: 32 }), ...over });
const media = { clips: [{ youtube_id: 'AAAAAAAAAAA', start_ms: 10_000, end_ms: 60_000, crop_x: 0.4 }, { youtube_id: 'BBBBBBBBBBB', start_ms: 0, end_ms: 30_000 }], photos: ['p1', 'p2', 'p3'] };
const close = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

test('modèle : une recette de départ est valide telle quelle, pour chaque recette', () => {
  for (const id of Object.keys(RECIPES)) {
    const t = sanitizeTemplate(templateFromRecipe(id, { track_id: 'son', length_beats: 16 }), { trackIds: ['son'], fontIds: ['anton'] });
    assert.equal(t.recipe.grade, RECIPES[id].grade);
    assert.equal(t.name, RECIPES[id].label);
  }
});

test('modèle : refus clairs (nom, son, passage, coupes, effets, textes, police, tempo)', () => {
  const base = templateFromRecipe('punch', { name: 'Ok', track_id: 'son', length_beats: 16 });
  const bad = (patch, re, opts = {}) => assert.throws(() => sanitizeTemplate({ ...base, ...patch }, opts), (e) => e instanceof EditError && re.test(e.message));
  bad({ name: '  ' }, /nom/);
  bad({ track_id: 'autre' }, /son/, { trackIds: ['son'] });
  bad({ length_beats: 4 }, /temps/);
  bad({ length_beats: 12.5 }, /temps/);
  bad({ recipe: { sections: [{ beats: 0, cut_every: 1, effects: ['punch'] }, { beats: 4, cut_every: 1, effects: ['punch'] }] } }, /dernière section/);
  bad({ recipe: { sections: [{ beats: 0, cut_every: 3, effects: ['punch'] }] } }, /rythme des coupes/);
  bad({ recipe: { sections: [{ beats: 0, cut_every: 1, effects: ['explosion'] }] } }, /effet/);
  bad({ recipe: { sections: [{ beats: 0, cut_every: 1, effects: ['punch'], photo_share: 2 }] } }, /photos/);
  bad({ recipe: { sections: [] } }, /sections/);
  bad({ texts: [{ text: 'Hors passage', beat: 16 }] }, /pendant le passage/);
  bad({ texts: [1, 2, 3, 4].map((i) => ({ text: `t${i}`, beat: i })) }, /textes au maximum/);
  bad({ font: 'comic' }, /Police/, { fontIds: ['anton'] });
  bad({ bpm: 300 }, /Tempo/);
  // texts are trimmed, sorted, and an empty one is dropped; an unknown grade falls back to none; a hand-set tempo is kept
  const ok = sanitizeTemplate({ ...base, bpm: '96', recipe: { ...base.recipe, grade: 'sépia' }, texts: [{ text: ' Deux ', beat: 8 }, { text: '', beat: 2 }, { text: 'Un', beat: 0 }] });
  assert.deepEqual(ok.texts, [{ text: 'Un', beat: 0 }, { text: 'Deux', beat: 8 }]);
  assert.equal(ok.recipe.grade, 'none');
  assert.equal(ok.bpm, 96);
});

test('passage du son : commence au premier temps après le début choisi ; tempo imposé = grille régulière ; durée maximale', () => {
  const g = grid(120);
  const w = beatWindow({ start_s: 2.05, length_beats: 16, bpm: null }, g);
  assert.ok(close(w.t0, 2.1), `début sur un temps (${w.t0})`);
  assert.equal(w.times.length, 17);
  assert.ok(w.times.every((t, i) => close(t, i * 0.5)));
  assert.deepEqual(w.strong, [0, 4, 8, 12], 'temps forts relatifs au passage');
  // hand-set tempo: regular grid from the chosen start, strong beats every 4
  const m = beatWindow({ start_s: 1, length_beats: 8, bpm: 60 }, g);
  assert.equal(m.t0, 1);
  assert.ok(close(m.times[8], 8));
  assert.deepEqual(m.strong, [0, 4]);
  // 128 beats at 120 BPM = 64 s: cut down to whole beats within the maximum duration
  const long = beatWindow({ start_s: 0, length_beats: 128, bpm: null }, grid(120, { n: 400 }));
  assert.ok(long.times[long.length] <= EDIT.maxDurationS + 1e-9 && long.length === 60, `${long.length} temps`);
  // end of the sound: the grid goes on at the same tempo
  const short = beatWindow({ start_s: 0, length_beats: 16, bpm: null }, grid(120, { n: 6 }));
  assert.equal(short.times.length, 17);
  assert.ok(close(short.times[16], 8));
});

test('montage : coupes sur les temps (toutes les N temps, demi-temps), cases bout à bout sans trou', () => {
  const g = grid(120);
  const one = (cut_every) => tpl({ length_beats: 16, recipe: { grade: 'none', sections: [{ beats: 0, cut_every, effects: ['none'], photo_share: 0 }] } });
  for (const [cut, n] of [[1, 16], [2, 8], [4, 4], [0.5, 32]]) {
    const p = planEdit({ template: one(cut), beats: g, media });
    assert.equal(p.slots.length, n, `coupe tous les ${cut} temps`);
    p.slots.forEach((s, i) => assert.ok(close(s.start, i * 0.5 * cut), `case ${i} au temps ${i * cut} (${s.start})`));
    assert.ok(close(p.slots.reduce((a, s) => a + s.dur, 0), p.duration, 0.005), 'les cases couvrent tout le montage');
    assert.ok(close(p.duration, 8));
  }
  // sections follow one another: 8 beats cut every 2, then every beat to the end
  const p = planEdit({ template: tpl({ length_beats: 16 }), beats: g, media });
  assert.deepEqual(p.slots.map((s) => s.start), [0, 1, 2, 3, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5]);
  assert.equal(p.music.start_s, 0.1);
  assert.equal(p.music.track_id, 'son');
});

test('montage : jamais plus de cases que le maximum, jamais de case trop courte', () => {
  const fast = tpl({ length_beats: 64, recipe: { grade: 'none', sections: [{ beats: 0, cut_every: 0.5, effects: ['punch'], photo_share: 0 }] } });
  const p = planEdit({ template: fast, beats: grid(180), media });
  assert.ok(p.slots.length <= EDIT.maxSlots, `${p.slots.length} cases`);
  assert.ok(p.slots.every((s) => s.dur >= EDIT.minSlotS - 1e-9));
  assert.ok(close(p.slots.reduce((a, s) => a + s.dur, 0), p.duration, 0.01));
});

test('montage : photos réparties selon la part choisie, jamais deux fois la même de suite ; extraits pris à tour de rôle', () => {
  const half = tpl({ length_beats: 32, recipe: { grade: 'none', sections: [{ beats: 0, cut_every: 1, effects: ['punch'], photo_share: 0.25 }] } });
  const p = planEdit({ template: half, beats: grid(120), media });
  const photos = p.slots.filter((s) => s.kind === 'photo');
  assert.equal(photos.length, 8, '1 case sur 4');
  for (let i = 1; i < p.slots.length; i++) if (p.slots[i].kind === 'photo' && p.slots[i - 1].kind === 'photo') assert.notEqual(p.slots[i].photo, p.slots[i - 1].photo);
  const videos = p.slots.filter((s) => s.kind === 'video');
  assert.deepEqual([...new Set(videos.map((s) => s.youtube_id))].sort(), ['AAAAAAAAAAA', 'BBBBBBBBBBB'], 'les deux interviews apparaissent');
  for (let i = 1; i < videos.length; i++) assert.notEqual(videos[i].youtube_id, videos[i - 1].youtube_id, 'à tour de rôle');
  // each piece stays inside its extract (start), moves forward, and keeps the extract's framing
  const a = videos.filter((s) => s.youtube_id === 'AAAAAAAAAAA');
  assert.ok(a.every((s) => s.from_s >= 10 && s.from_s < 60 && s.crop_x === 0.4));
  assert.ok(a.every((s, i) => i === 0 || s.from_s > a[i - 1].from_s), 'des moments différents de l’extrait');
  // only photos / only clips
  assert.ok(planEdit({ template: half, beats: grid(120), media: { clips: [], photos: ['p1'] } }).slots.every((s) => s.kind === 'photo'));
  assert.ok(planEdit({ template: half, beats: grid(120), media: { clips: media.clips, photos: [] } }).slots.every((s) => s.kind === 'video'));
  assert.throws(() => planEdit({ template: half, beats: grid(120), media: { clips: [], photos: [] } }), /au moins un extrait/);
});

test('montage : effets à tour de rôle, flash ajouté sur les temps forts et les drops ; même résultat à chaque fois', () => {
  const t = tpl({ length_beats: 16, recipe: { grade: 'contrast', sections: [{ beats: 0, cut_every: 1, effects: ['punch', 'shake', 'flash'], photo_share: 0 }] } });
  const g = grid(120, { drops: [6] });
  const p = planEdit({ template: t, beats: g, media });
  assert.deepEqual(p.slots.slice(0, 3).map((s) => s.effects[0]), ['punch', 'shake', 'flash']);
  assert.deepEqual(p.slots[0].effects, ['punch', 'flash'], 'temps fort : flash en plus');
  assert.deepEqual(p.slots[1].effects, ['shake']);
  assert.deepEqual(p.slots[6].effects, ['punch', 'flash'], 'drop : flash en plus');
  assert.deepEqual(p.slots[8].effects, ['flash'], 'temps fort dont l’effet est déjà un flash : pas deux');
  assert.deepEqual(p.slots[4].effects, ['shake', 'flash']);
  assert.equal(p.grade, 'contrast');
  assert.deepEqual(planEdit({ template: t, beats: g, media }), p, 'déterministe');
  // no flash in the section: none added on strong beats
  const calm = planEdit({ template: tpl({ length_beats: 8, recipe: { grade: 'none', sections: [{ beats: 0, cut_every: 1, effects: ['slowzoom'], photo_share: 0 }] } }), beats: g, media });
  assert.ok(calm.slots.every((s) => !s.effects.includes('flash')));
  // "none" never reaches the render
  const plain = planEdit({ template: tpl({ length_beats: 8, recipe: { grade: 'none', sections: [{ beats: 0, cut_every: 1, effects: ['none'], photo_share: 0 }] } }), beats: g, media });
  assert.ok(plain.slots.every((s) => s.effects.length === 0));
});

test('montage : textes au temps choisi, jusqu’au texte suivant ou 4 temps au plus', () => {
  const t = tpl({ length_beats: 16, texts: [{ text: 'Il a osé', beat: 0 }, { text: 'Lisnard 2027', beat: 2 }, { text: 'Fin', beat: 14 }] });
  const p = planEdit({ template: t, beats: grid(120), media });
  assert.deepEqual(p.texts, [{ text: 'Il a osé', start: 0, dur: 1 }, { text: 'Lisnard 2027', start: 1, dur: 2 }, { text: 'Fin', start: 7, dur: 1 }]);
});

test('montage : passage trop court refusé', () => {
  const t = tpl({ length_beats: 8 });
  assert.throws(() => planEdit({ template: t, beats: grid(200), media }), /trop court/);
});

test('textes : fichier ASS en capitales, centré, effet « pop », accolades retirées', () => {
  const ass = editAss({ texts: [{ text: 'Il a {osé} le dire', start: 1.5, dur: 2 }], size: { w: 1080, h: 1920 }, font: { ass_name: 'Anton Regular' } });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /Style: Edit,Anton Regular,163,/);
  assert.match(ass, /Dialogue: 0,0:00:01\.50,0:00:03\.50,Edit,,0,0,0,,\{\\an5\\pos\(540,806\)\\fad\(40,120\)\\fscx135\\fscy135\\t\(0,140,\\fscx100\\fscy100\)\}IL A OSÉ LE DIRE$/m);
});
