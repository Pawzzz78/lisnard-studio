// Contexte d'une vidéo pour la retranscription : titre et description YouTube, et les noms propres qu'on en tire.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureYtdlp } from '../video-fetch.js';
import { KEYTERMS } from './stt.js';

const run = promisify(execFile);
const MAX_TERMS = 80;
const MAX_DESCRIPTION = 2000;

/** Description YouTube d'une vidéo (yt-dlp, sans téléchargement) ; null si indisponible. */
export async function fetchDescription(youtubeId, { exec = run, ytdlp = ensureYtdlp } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(youtubeId))) return null;
  try {
    const bin = await ytdlp();
    const { stdout } = await exec(bin, ['--skip-download', '--no-warnings', '--no-playlist', '--print', 'description', `https://www.youtube.com/watch?v=${youtubeId}`], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const text = String(stdout).trim();
    return text && text !== 'NA' ? text.slice(0, MAX_DESCRIPTION) : ''; // no description: '' is a valid, final answer
  } catch (e) {
    console.error(`Description de la vidéo ${youtubeId} : ${String(e.message).split('\n')[0]}`);
    return null;
  }
}

const STOP = new Set(['Le', 'La', 'Les', 'Un', 'Une', 'Des', 'De', 'Du', 'Et', 'En', 'Au', 'Aux', 'Pour', 'Par', 'Sur', 'Dans', 'Avec', 'Ce', 'Cette', 'Ces', 'Il', 'Elle', 'Nous', 'Vous', 'Ils', 'Je', 'On', 'Qui', 'Que', 'Quoi', 'Comment', 'Pourquoi', 'Est', 'Ne', 'Pas', 'Mais', 'Ou', 'Si', 'Tout', 'Tous', 'Plus', 'Retrouvez', 'Abonnez', 'Suivez', 'Rejoignez', 'Merci', 'Bonjour', 'Bonsoir', 'A', 'À', 'Y']);

/**
 * Noms propres probables du titre et de la description : mots en capitales (DLIVE, RN), suites de mots à majuscule
 * (Bruno Retailleau, Nouvelle Énergie), hashtags. Ajoutés aux termes de base ; sans doublon, au plus MAX_TERMS.
 */
export function contextTerms({ title = '', description = '' } = {}) {
  const terms = [...KEYTERMS];
  const text = `${title}\n${String(description ?? '').replace(/https?:\/\/\S+/g, ' ')}`;
  for (const m of text.matchAll(/#([\p{L}\p{N}_]{3,40})/gu)) terms.push(m[1]);
  for (const m of text.matchAll(/\b\p{Lu}[\p{Lu}\p{N}]{1,15}\b/gu)) terms.push(m[0]);
  for (const m of text.matchAll(/\p{Lu}[\p{Ll}'’-]+(?:[ -](?:de |d'|du |la |le )?\p{Lu}[\p{Ll}'’-]+){0,3}/gu)) {
    const words = m[0].split(/\s+/);
    while (words.length && STOP.has(words[0])) words.shift();
    if (words.length && (words.length > 1 || words[0].length >= 4)) terms.push(words.join(' '));
  }
  const seen = new Set();
  return terms.filter((t) => {
    const k = t.toLowerCase();
    if (t.length > 100 || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_TERMS);
}
