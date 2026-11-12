/**
 * Rendu d'un montage rythmé (section « Edit ») : une entrée ffmpeg par case de la chronologie (morceau d'interview ou photo),
 * recadrée en vertical, avec l'effet de sa coupe, puis tout est mis bout à bout sur la musique du modèle, avec les textes.
 * `buildEditArgs` est une fonction pure (testable sans lancer ffmpeg) ; le rendu passe par la file des clips (un seul ffmpeg à la fois).
 */
import { promises as fs } from 'node:fs';
import { escFilterPath } from '../studio/box-probe.js';
import { FONTS, FONTS_DIR, enqueueJob } from '../studio/render.js';
import { FPS, kenBurnsFilter } from '../../public/js/studio-core.js';
import { editAss } from '../../public/js/edit-core.js';

export const EDIT_SIZES = {
  hd: { w: 1080, h: 1920, crf: 21, preset: 'veryfast' },
  fast: { w: 720, h: 1280, crf: 23, preset: 'veryfast' },
  preview: { w: 360, h: 640, crf: 31, preset: 'ultrafast' },
};

const n3 = (x) => String(Math.round(x * 1000) / 1000);
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Filtre de l'effet d'une coupe (image déjà à la taille finale w × h ; t repart de 0 au début de la case). */
export function effectFilter(effect, { w, h, dur }) {
  const zoomTo = (expr) => `scale=w='trunc(${w}*(${expr})/2)*2':h=-2:eval=frame,crop=${w}:${h}`;
  switch (effect) {
    case 'punch': // grossi d'un coup puis revient en 0,22 s
      return zoomTo('1.18-0.18*min(1,t/0.22)');
    case 'slowzoom': // avance lentement pendant toute la case
      return zoomTo(`1+0.08*min(1,t/${n3(Math.max(0.1, dur))})`);
    case 'shake': {
      const a = Math.max(2, Math.round(w * 0.012));
      const decay = 'max(0,1-t/0.35)';
      return `scale=${even(w * 1.06)}:-2,crop=${w}:${h}:x='(iw-ow)/2+${a}*sin(t*55)*${decay}':y='(ih-oh)/2+${a}*cos(t*43)*${decay}'`;
    }
    case 'flash':
      return 'fade=t=in:st=0:d=0.14:color=white';
    case 'bw':
      return 'hue=s=0';
    case 'rgb': {
      const d = Math.max(1, Math.round(w * 0.006));
      return `rgbashift=rh=${d}:bh=-${d}`;
    }
    default:
      return '';
  }
}

/** Étalonnage de tout le montage. */
export const gradeFilter = (grade) =>
  ({
    bw: 'hue=s=0',
    warm: 'colorbalance=rs=0.06:gs=0.02:bs=-0.06,eq=saturation=1.1',
    cold: 'colorbalance=rs=-0.05:bs=0.07,eq=saturation=0.9',
    contrast: 'eq=contrast=1.12:saturation=1.15',
  })[grade] ?? '';

/**
 * Arguments ffmpeg d'un montage. `plan` : résultat de planEdit ; `files` : { video(youtube_id) → chemin, photo(id) → chemin, music } ;
 * `assPath` : fichier des textes (ou null) ; `size` : une entrée de EDIT_SIZES.
 */
export function buildEditArgs({ plan, files, size, assPath = null, out }) {
  const { w, h } = size;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y'];
  plan.slots.forEach((s) => {
    if (s.kind === 'photo') args.push('-loop', '1', '-framerate', String(FPS), '-t', n3(s.dur + 0.1), '-i', files.photo(s.photo));
    else args.push('-ss', n3(s.from_s), '-t', n3(s.dur + 0.1), '-i', files.video(s.youtube_id));
  });
  const musicIdx = plan.slots.length;
  if (files.music) args.push('-ss', n3(plan.music.start_s), '-t', n3(plan.duration + 0.1), '-i', files.music);

  const f = [];
  plan.slots.forEach((s, i) => {
    const fit = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    const base =
      s.kind === 'photo'
        ? `[${i}:v]${fit},setsar=1,fps=${FPS},format=yuv420p,setpts=PTS-STARTPTS${s.effects.includes('slowzoom') ? '' : `,${kenBurnsFilter(s.dur)}`}`
        : `[${i}:v]fps=${FPS},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:x='(iw-ow)*${n3(s.crop_x ?? 0.5)}':y='(ih-oh)*0.5',setsar=1,format=yuv420p,setpts=PTS-STARTPTS`;
    const fx = s.effects.map((e) => effectFilter(e, { w, h, dur: s.dur })).filter(Boolean);
    f.push(`${[base, ...fx].join(',')},trim=duration=${n3(s.dur)},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[s${i}]`);
  });
  f.push(`${plan.slots.map((_, i) => `[s${i}]`).join('')}concat=n=${plan.slots.length}:v=1:a=0[vc]`);
  const grade = gradeFilter(plan.grade);
  const text = assPath ? `ass=${escFilterPath(assPath)}:fontsdir=${escFilterPath(FONTS_DIR)}` : '';
  f.push(`[vc]${[grade, text].filter(Boolean).join(',') || 'null'}[vo]`);
  const fade = Math.max(0, plan.duration - 0.5);
  f.push(
    files.music
      ? `[${musicIdx}:a]aresample=48000,aformat=channel_layouts=stereo,afade=t=out:st=${n3(fade)}:d=0.5,apad,atrim=0:${n3(plan.duration)}[ao]`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${n3(plan.duration)}[ao]`,
  );
  args.push('-filter_complex', f.join(';'), '-map', '[vo]', '-map', '[ao]');
  args.push('-c:v', 'libx264', '-preset', size.preset, '-crf', String(size.crf), '-pix_fmt', 'yuv420p', '-r', String(FPS));
  args.push('-c:a', 'aac', '-b:a', size === EDIT_SIZES.preview ? '64k' : '160k', '-ar', '48000', '-t', n3(plan.duration), '-movflags', '+faststart', out);
  return args;
}

/**
 * Met un montage en file de rendu (même file que les clips). `files` : voir buildEditArgs. `quality` : 'hd' ou 'fast'.
 * Renvoie le job (suivi avec getJob / publicJob de studio/render.js).
 */
export function enqueueEditRender({ plan, files, quality = 'hd', ip, owner = null, filename = 'edit-lisnard', onDone = null }) {
  const size = EDIT_SIZES[quality] ?? EDIT_SIZES.hd;
  const font = FONTS.find((x) => x.id === plan.font) ?? FONTS[0];
  return enqueueJob({
    kind: 'edit',
    ip,
    owner,
    onDone,
    total: plan.duration,
    filename,
    youtubeIds: plan.slots.filter((s) => s.kind === 'video').map((s) => s.youtube_id),
    prepare: async (job) => {
      let assPath = null;
      if (plan.texts.length) {
        await fs.writeFile(job.assPath, editAss({ texts: plan.texts, size, font }));
        assPath = job.assPath;
      }
      return buildEditArgs({ plan, files, size, assPath, out: job.out });
    },
  });
}
