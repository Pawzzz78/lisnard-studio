// Section « Edit » : commande ffmpeg d'un montage, passage par la file des clips, et rendu réel dont les coupes tombent sur les temps.
// Le rendu réel nécessite ffmpeg (sinon ignoré).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { planEdit, sanitizeTemplate } from '../public/js/edit-core.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
let dir;
let studio;
let edit;

const grid = (bpm, n = 120, offset = 0) => {
  const beats = Array.from({ length: n }, (_, i) => Math.round((offset + (i * 60) / bpm) * 1000) / 1000);
  return { bpm, beats, strong: beats.map((_, i) => i).filter((i) => i % 4 === 0), drops: [] };
};
const template = (sections, length_beats = 12, texts = []) => sanitizeTemplate({ name: 'Essai', track_id: 'son', start_s: 0, length_beats, recipe: { grade: 'none', sections }, texts });
const media = { clips: [{ youtube_id: 'AAAAAAAAAAA', start_ms: 1000, end_ms: 20000 }, { youtube_id: 'BBBBBBBBBBB', start_ms: 0, end_ms: 20000 }], photos: ['ph1'] };

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-render-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  studio = await import('../src/studio/render.js');
  edit = await import('../src/edit/render.js');
});
beforeEach(() => studio.resetStudioState());
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('commande ffmpeg : une entrée par case (morceau d’interview lu à partir de son instant, photo en boucle), puis la musique', () => {
  const plan = planEdit({ template: template([{ beats: 0, cut_every: 2, effects: ['punch', 'shake'], photo_share: 0.34 }], 12, [{ text: 'Hello', beat: 0 }]), beats: grid(120), media });
  const files = { video: (id) => `/v/${id}.mp4`, photo: (id) => `/p/${id}.jpg`, music: '/m/son.mp3' };
  const args = edit.buildEditArgs({ plan, files, size: edit.EDIT_SIZES.hd, assPath: '/tmp/t.ass', out: '/tmp/o.mp4' });
  const inputs = args.reduce((acc, a, i) => (a === '-i' ? [...acc, args[i + 1]] : acc), []);
  assert.equal(inputs.length, plan.slots.length + 1);
  assert.equal(inputs.at(-1), '/m/son.mp3');
  plan.slots.forEach((s, i) => assert.equal(inputs[i], s.kind === 'photo' ? '/p/ph1.jpg' : `/v/${s.youtube_id}.mp4`));
  const v = plan.slots.find((s) => s.kind === 'video');
  const vi = args.indexOf(`/v/${v.youtube_id}.mp4`);
  assert.deepEqual(args.slice(vi - 5, vi - 1), ['-ss', String(v.from_s), '-t', String(Math.round((v.dur + 0.1) * 1000) / 1000)]);
  assert.ok(args.includes('-loop'));
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, new RegExp(`concat=n=${plan.slots.length}:v=1:a=0\\[vc\\]`));
  assert.match(fc, /ass=.*t\.ass/);
  assert.match(fc, /afade=t=out/);
  assert.ok(fc.includes(`trim=duration=${plan.slots[0].dur}`));
  assert.ok(fc.includes('eval=frame'), 'zoom punch image par image');
  assert.deepEqual(args.slice(args.indexOf('-t', args.indexOf('-filter_complex')), args.indexOf('-t', args.indexOf('-filter_complex')) + 2), ['-t', String(plan.duration)]);
  assert.equal(args.at(-1), '/tmp/o.mp4');
  // effects and grades
  assert.match(edit.effectFilter('flash', { w: 1080, h: 1920, dur: 1 }), /fade=t=in.*color=white/);
  assert.match(edit.effectFilter('shake', { w: 1080, h: 1920, dur: 1 }), /crop=1080:1920:x=.*sin/);
  assert.equal(edit.effectFilter('none', { w: 1080, h: 1920, dur: 1 }), '');
  assert.equal(edit.gradeFilter('bw'), 'hue=s=0');
  assert.equal(edit.gradeFilter('inconnu'), '');
});

test('file de rendu : un montage passe par la même file et les mêmes limites que les clips ; ses interviews sont protégées', { skip: !hasFfmpeg }, async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const tiny = (j) => ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', j.out];
  const job = (youtubeIds) => studio.enqueueJob({ kind: 'edit', ip: '203.0.113.9', total: 0.5, filename: 'edit-essai.mp4', youtubeIds, prepare: async (j) => (await gate, tiny(j)) });
  try {
    const a = await job(['AAAAAAAAAAA', 'AAAAAAAAAAA', 'BBBBBBBBBBB']);
    const b = await job([]);
    assert.deepEqual(a.youtube_ids, ['AAAAAAAAAAA', 'BBBBBBBBBBB']);
    assert.match(a.filename, /^edit-essai-[0-9a-f]{6}\.mp4$/);
    assert.equal(studio.getJob(a.id), a);
    assert.equal(studio.publicJob(b).position, 1, 'en file derrière le premier');
    assert.equal(studio.videoInUse('BBBBBBBBBBB'), true, 'son fichier ne doit pas être supprimé pendant le rendu');
    assert.equal(studio.videoInUse('CCCCCCCCCCC'), false);
    // same visitor: the same limit as for clips (two videos at a time)
    await assert.rejects(job([]), (e) => e.status === 429);
    release();
    for (let i = 0; i < 200 && [a, b].some((j) => j.status !== 'done' && j.status !== 'error'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual([a.status, b.status], ['done', 'done'], a.error ?? b.error ?? '');
    assert.equal(studio.publicJob(a).status, 'done');
    assert.ok(a.size > 0);
    assert.equal(studio.videoInUse('BBBBBBBBBBB'), false);
  } finally {
    release();
  }
});

test('rendu réel : 1080 × 1920, durée du passage, son présent, et chaque coupe tombe sur son temps', { skip: !hasFfmpeg, timeout: 120_000 }, async () => {
  const src = path.join(dir, 'src');
  await fs.mkdir(src, { recursive: true });
  const color = (name, c) => {
    const f = path.join(src, name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=1280x720:r=25:d=25`, '-f', 'lavfi', '-i', 'sine=f=300:d=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
    return f;
  };
  const red = color('red.mp4', 'red');
  const blue = color('blue.mp4', 'blue');
  const green = path.join(src, 'green.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00C000:s=1200x900', '-frames:v', '1', green]);
  const music = path.join(src, 'music.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.5),0.02),sin(2*PI*1500*t),0)':s=44100:d=20", music]);
  // 12 beats at 120 BPM, cut every beat with no effect: colors red, blue, green… show where each cut lands
  const plan = planEdit({ template: template([{ beats: 0, cut_every: 1, effects: ['none'], photo_share: 0.34 }], 12), beats: grid(120), media });
  assert.equal(plan.slots.length, 12);
  const files = { video: (id) => (id === 'AAAAAAAAAAA' ? red : blue), photo: () => green, music };
  const job = await edit.enqueueEditRender({ plan, files, quality: 'hd', ip: '198.51.100.7', filename: 'edit-test' });
  for (let i = 0; i < 1200 && job.status !== 'done' && job.status !== 'error'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(job.status, 'done', job.error ?? '');
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', job.out], { encoding: 'utf8' }));
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.deepEqual([v.width, v.height], [1080, 1920]);
  assert.ok(info.streams.some((s) => s.codec_type === 'audio'), 'la musique');
  assert.ok(Math.abs(Number(info.format.duration) - plan.duration) < 0.1, `durée ${info.format.duration} pour ${plan.duration}`);
  // One tiny frame per 1/30 s: the dominant color of each frame, then the instants where it changes
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', job.out, '-vf', 'scale=4:4', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  const frames = raw.length / 48;
  const label = (k) => {
    let [r, g, b] = [0, 0, 0];
    for (let i = 0; i < 16; i++) {
      r += raw[k * 48 + i * 3];
      g += raw[k * 48 + i * 3 + 1];
      b += raw[k * 48 + i * 3 + 2];
    }
    return r > g && r > b ? 'r' : g > b ? 'g' : 'b';
  };
  const changes = [];
  for (let k = 1; k < frames; k++) if (label(k) !== label(k - 1)) changes.push(k / 30);
  const expected = plan.slots.slice(1).filter((s, i) => (s.kind === 'photo' ? 'g' : s.youtube_id[0]) !== (plan.slots[i].kind === 'photo' ? 'g' : plan.slots[i].youtube_id[0])).map((s) => s.start);
  assert.ok(expected.length >= 8, `${expected.length} changements attendus`);
  assert.equal(changes.length, expected.length, `coupes vues : ${changes.join(', ')}`);
  changes.forEach((t, i) => assert.ok(Math.abs(t - expected[i]) <= 0.04, `coupe à ${t} s, attendue à ${expected[i]} s`));
});
