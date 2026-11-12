// Analyse en tâche de fond des temps forts de toute la bibliothèque de musiques (ajouts de l'admin, sons tendance de la semaine)
import { warmBeats } from './beats.js';
import { ensureMusic, findTrack, publicTracks } from '../studio/music.js';

/** Morceaux proposés dans le studio, avec leur fichier. */
export async function libraryTracks() {
  await ensureMusic();
  return publicTracks().map((t) => findTrack(t.id)).filter(Boolean);
}

/** 3 minutes après le démarrage, puis toutes les 6 heures : un son déjà analysé n'est pas repris. */
export function startBeatsWarmup() {
  const tick = async () => {
    try {
      const n = await warmBeats(await libraryTracks());
      if (n) console.log(`Temps forts : ${n} son${n > 1 ? 's' : ''} analysé${n > 1 ? 's' : ''}.`);
    } catch (e) {
      console.warn(`Temps forts : ${e.message}`);
    }
  };
  setTimeout(tick, 3 * 60_000).unref();
  setInterval(tick, 6 * 3600_000).unref();
}
