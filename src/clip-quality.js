/**
 * Filtre de qualité des extraits proposés par l'IA, sans modèle : le LLM garde la main sur le choix, mais ce qui est évidemment
 * creux (salutations, remerciements, au revoir, questions de l'intervieweur, passages sans contenu, début et fin de l'interview)
 * est écarté ici, quelle que soit la note qu'il a donnée.
 */
import { normalize } from './normalize.js';
import { isStopWord } from '../public/js/stopwords.js';

export const QUALITY = {
  minScore: Math.max(1, Math.min(10, Number(process.env.CLIP_MIN_SCORE) || 7)), // sous cette note : écarté (1 : tout garder)
  edgeMs: 60_000, // les 60 premières et dernières secondes de l'interview : accueil, présentation, remerciements
  edgeScore: 9, // note minimale pour garder un extrait dans ces zones
  edgeMinTranscriptMs: 5 * 60_000, // en dessous, l'interview est trop courte pour parler d'« accueil » et de « conclusion »
  openingWords: 12, // un extrait qui salue dans ses premiers mots est un accueil
  closingWords: 14, // ... ou qui prend congé dans ses derniers mots
  pleasantryShare: 0.06, // part de mots de politesse au-delà de laquelle l'extrait est creux
  minContentWords: 10, // mots porteurs de sens (hors mots creux) pour qu'un extrait de 15 s ou plus ait du fond
  minQuestions: 3, // un extrait fait de questions : celles de l'intervieweur (seulement si la transcription est ponctuée)
  questionShare: 0.6,
};

const phrases = (list) => list.map((p) => ` ${normalize(p)} `);
// formules d'accueil (en début d'extrait) et de congé (en fin d'extrait), comparées sur le texte normalisé
const GREETINGS = phrases(['bonjour', 'bonsoir', 'salut à tous', 'bienvenue', 'enchanté', 'ravi de vous', 'heureux de vous', 'content de vous', 'merci de nous recevoir', "merci de m'avoir invité", "merci de m'accueillir", "merci d'être là", "merci d'être avec nous", 'merci de nous rejoindre', 'merci de votre invitation', 'je vous remercie de nous recevoir', "mon invité", 'notre invité', "aujourd'hui nous recevons", "aujourd'hui je reçois", 'dans cette émission', 'vous écoutez', 'vous regardez', 'bonne écoute', 'bonne émission']);
const FAREWELLS = phrases(['au revoir', 'à bientôt', 'à très bientôt', 'à la prochaine', 'bonne journée', 'bonne soirée', 'bonne fin de journée', 'bonne continuation', 'merci à vous', 'merci à tous', 'merci beaucoup', 'merci encore', 'merci de nous avoir suivis', "merci d'avoir été avec nous", 'je vous remercie', 'on se retrouve', 'à demain', 'portez-vous bien']);
const PLEASANTRY_WORDS = new Set(normalize('bonjour bonsoir salut bienvenue enchante merci remercie remercions remercier bravo felicitations plaisir honneur ravi heureux revoir').split(' '));

const wordsOf = (text) => normalize(text).split(' ').filter(Boolean);
const hasPhrase = (words, list) => {
  const joined = ` ${words.join(' ')} `;
  return list.some((p) => joined.includes(p));
};

/** Nombre de mots qui portent un sens (ni mots-outils, ni mots creux, ni politesse). */
export function contentWords(text) {
  return wordsOf(text).filter((w) => w.length >= 3 && !isStopWord(w) && !PLEASANTRY_WORDS.has(w)).length;
}

/**
 * Raison pour laquelle l'extrait est écarté (texte court), ou null s'il peut être proposé.
 * `clip` : { start_ms, end_ms, text, score } ; `bounds` : { start_ms, end_ms } de la transcription entière.
 */
export function junkReason(clip, bounds, quality = QUALITY) {
  const text = String(clip.text ?? '');
  const words = wordsOf(text);
  if (clip.score < quality.minScore) return 'note trop basse';
  if (hasPhrase(words.slice(0, quality.openingWords), GREETINGS)) return 'accueil ou salutations';
  if (hasPhrase(words.slice(-quality.closingWords), FAREWELLS)) return 'remerciements ou au revoir';
  if (words.length && words.filter((w) => PLEASANTRY_WORDS.has(w)).length / words.length > quality.pleasantryShare) return 'politesses';
  if (contentWords(text) < quality.minContentWords) return 'trop peu de contenu';
  // sans ponctuation (transcription automatique), cette règle ne se déclenche pas : on ne devine pas
  const sentences = text.split(/(?<=[.!?…])\s+/).filter((s) => s.trim().length > 1);
  const questions = sentences.filter((s) => /\?["»”')\]]*$/.test(s.trim())).length;
  if (questions >= quality.minQuestions && questions / sentences.length > quality.questionShare) return "questions de l'intervieweur";
  const total = bounds.end_ms - bounds.start_ms;
  if (total >= quality.edgeMinTranscriptMs && clip.score < quality.edgeScore && (clip.start_ms - bounds.start_ms < quality.edgeMs || bounds.end_ms - clip.end_ms < quality.edgeMs)) {
    return clip.start_ms - bounds.start_ms < quality.edgeMs ? "début de l'interview" : "fin de l'interview";
  }
  return null;
}
