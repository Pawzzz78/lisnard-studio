CREATE TABLE IF NOT EXISTS videos (
  id            SERIAL PRIMARY KEY,
  youtube_id    TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  channel       TEXT NOT NULL DEFAULT '',
  published_at  DATE,
  thumbnail_url TEXT,
  lang          TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',   -- 'supadata' | 'manual'
  edited        BOOLEAN NOT NULL DEFAULT FALSE,   -- transcription corrigée à la main
  norm_text     TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS segments (
  id          SERIAL PRIMARY KEY,
  video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  start_ms    INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  text        TEXT NOT NULL,
  norm_start  INTEGER NOT NULL DEFAULT -1,
  UNIQUE (video_id, position)
);

-- Synchronisation automatique des chaînes YouTube ---------------------------------
-- sync_status : NULL = vidéo ajoutée à la main (jamais touchée par la synchro),
--               'pending' = en file d'attente, 'done' = transcrite, 'failed' = abandonnée.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS sync_status   TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS sync_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS sync_next_at  TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS sync_error    TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS channel_id    TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS duration_s    INTEGER;
CREATE INDEX IF NOT EXISTS videos_sync_pending ON videos (sync_next_at) WHERE sync_status = 'pending';

CREATE TABLE IF NOT EXISTS channels (
  id                    SERIAL PRIMARY KEY,
  youtube_channel_id    TEXT UNIQUE NOT NULL,
  title                 TEXT NOT NULL DEFAULT '',
  handle                TEXT,
  uploads_playlist_id   TEXT NOT NULL,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  min_duration_s        INTEGER NOT NULL DEFAULT 0,
  backfilled_at         TIMESTAMPTZ,              -- NULL tant que tout l'historique n'a pas été listé
  discovery_due_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_discovery_at     TIMESTAMPTZ,
  last_discovery_error  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vidéos que la synchro ne doit jamais (ré)ajouter : supprimées à la main, trop courtes…
CREATE TABLE IF NOT EXISTS excluded_videos (
  youtube_id TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Traduction automatique des transcriptions -------------------------------------------
-- videos.lang = langue du texte stocké ; original_lang = langue d'origine quand il a été traduit.
-- segments.text_original = texte d'origine (avant traduction), conservé pour vérification.
ALTER TABLE videos   ADD COLUMN IF NOT EXISTS original_lang TEXT;
ALTER TABLE videos   ADD COLUMN IF NOT EXISTS translated    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS text_original TEXT;

-- Résumés générés par IA (un par vidéo, régénéré si la transcription change) -------------
CREATE TABLE IF NOT EXISTS video_summaries (
  video_id    INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  model       TEXT NOT NULL,
  source_hash TEXT NOT NULL,                 -- md5 du texte indexé au moment de la génération
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shorts : exclus par défaut (durée <= 60 s ou présents dans la liste des Shorts YouTube de la chaîne).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS exclude_shorts BOOLEAN NOT NULL DEFAULT TRUE;

-- Résumés automatiques : empreinte de la transcription (comparée à celle du résumé) et suivi des tentatives -------
ALTER TABLE videos ADD COLUMN IF NOT EXISTS text_hash        TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS summary_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS summary_next_at  TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS summary_error    TEXT;
UPDATE videos SET text_hash = md5(norm_text) WHERE text_hash IS NULL AND norm_text <> '';
ALTER TABLE video_summaries ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- Studio de clips (TikTok / Reels) : fichier vidéo déposé par l'admin, et propositions d'extraits -----------------
ALTER TABLE videos ADD COLUMN IF NOT EXISTS file_name        TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS file_size        BIGINT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS file_duration_s  REAL;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS file_width       INTEGER;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS file_height      INTEGER;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS file_has_audio   BOOLEAN;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS file_uploaded_at TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS clips_enabled    BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS clip_suggestions (
  video_id   INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  content    JSONB NOT NULL,
  model      TEXT,
  text_hash  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Studio : statistiques d'usage (clips créés, téléchargés, partagés). Un événement par clip et par type ; `visitor` est une
-- empreinte irréversible de l'adresse IP (pour compter les personnes), effacée après 90 jours.
CREATE TABLE IF NOT EXISTS studio_events (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  job_id     TEXT NOT NULL,
  youtube_id TEXT,
  visitor    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, kind)
);
CREATE INDEX IF NOT EXISTS studio_events_created_idx ON studio_events (created_at);

-- Studio : bibliothèque de musiques de l'admin (fichiers sur le volume, dans <STORAGE_DIR>/music) et morceaux d'origine masqués.
CREATE TABLE IF NOT EXISTS studio_music (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'autre',
  credit     TEXT NOT NULL DEFAULT '',
  duration_s NUMERIC NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  file       TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS studio_music_hidden (id TEXT PRIMARY KEY);
-- Sons tendance TikTok (actualisés chaque semaine) : `source` 'tiktok', `external_id` = identifiant du son chez TikTok, `rank` = place dans le
-- classement (NULL : n'y est plus, gardé quelques jours pour les rendus en cours puis supprimé), `last_seen_at` = dernière fois dans le classement.
ALTER TABLE studio_music ADD COLUMN IF NOT EXISTS source       TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE studio_music ADD COLUMN IF NOT EXISTS external_id  TEXT;
ALTER TABLE studio_music ADD COLUMN IF NOT EXISTS rank         INTEGER;
ALTER TABLE studio_music ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS studio_music_external_idx ON studio_music (external_id) WHERE external_id IS NOT NULL;

-- Studio : visages détectés dans une interview (cadrage automatique en plein écran). `file_stamp` : version du fichier vidéo
-- analysé ; si la vidéo est remplacée, le résultat n'est plus utilisé.
CREATE TABLE IF NOT EXISTS video_faces (
  video_id    INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  content     JSONB,
  error       TEXT,
  file_stamp  TEXT,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Studio : photos de référence d'une personne à reconnaître (David Lisnard) : empreinte du visage (128 nombres) et vignette redressée.
CREATE TABLE IF NOT EXISTS face_references (
  id         SERIAL PRIMARY KEY,
  label      TEXT NOT NULL DEFAULT 'lisnard',
  name       TEXT NOT NULL DEFAULT '',
  embedding  JSONB NOT NULL,
  thumb      BYTEA NOT NULL,
  score      REAL,
  face_px    INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Reconnaissance dans une interview : [indice d'image, indice du visage, ressemblance] ; `ident_version` : jeu de photos utilisé
ALTER TABLE video_faces ADD COLUMN IF NOT EXISTS ident         JSONB;
ALTER TABLE video_faces ADD COLUMN IF NOT EXISTS ident_version TEXT;

-- Mur des clips : vidéos TikTok du hashtag suivi (récupérées via Apify), classées par vues, j'aime et commentaires.
CREATE TABLE IF NOT EXISTS wall_clips (
  id         TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  author     TEXT NOT NULL,
  nickname   TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL DEFAULT '',
  hashtags   JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ,
  views      BIGINT NOT NULL DEFAULT 0,
  likes      BIGINT NOT NULL DEFAULT 0,
  comments   BIGINT NOT NULL DEFAULT 0,
  shares     BIGINT NOT NULL DEFAULT 0,
  saves      BIGINT NOT NULL DEFAULT 0,
  duration_s INTEGER,
  cover_url  TEXT,
  has_cover  BOOLEAN NOT NULL DEFAULT FALSE,
  hidden     BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wall_clips_created_idx ON wall_clips (created_at DESC);
CREATE TABLE IF NOT EXISTS wall_hidden_authors (author TEXT PRIMARY KEY);

-- Clip library; owner_key is an HMAC of the owner (member or anonymous cookie), never shown publicly
CREATE TABLE IF NOT EXISTS library_clips (
  id              TEXT PRIMARY KEY,
  owner_key       TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'clip',
  remix_of        TEXT,
  video_id        INTEGER REFERENCES videos(id) ON DELETE CASCADE,
  youtube_id      TEXT NOT NULL,
  video_title     TEXT NOT NULL DEFAULT '',
  job_id          TEXT UNIQUE,
  visibility      TEXT NOT NULL DEFAULT 'public',
  hidden          BOOLEAN NOT NULL DEFAULT FALSE,
  req             JSONB,
  duration_s      REAL NOT NULL DEFAULT 0,
  quality         TEXT NOT NULL DEFAULT 'hd',
  file_stamp      TEXT,
  text_hash       TEXT,
  file_state      TEXT NOT NULL DEFAULT 'active',
  file_version    INTEGER NOT NULL DEFAULT 1,
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  has_poster      BOOLEAN NOT NULL DEFAULT FALSE,
  file_expires_at TIMESTAMPTZ,
  downloads       INTEGER NOT NULL DEFAULT 0,
  rating_sum      INTEGER NOT NULL DEFAULT 0,
  rating_count    INTEGER NOT NULL DEFAULT 0,
  reports         INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_clips_public_idx ON library_clips (created_at DESC) WHERE visibility = 'public' AND NOT hidden AND kind = 'clip';
CREATE INDEX IF NOT EXISTS library_clips_owner_idx ON library_clips (owner_key, created_at DESC);
CREATE INDEX IF NOT EXISTS library_clips_expiry_idx ON library_clips (file_expires_at) WHERE file_state = 'active';
CREATE TABLE IF NOT EXISTS library_downloads (
  clip_id    TEXT NOT NULL REFERENCES library_clips(id) ON DELETE CASCADE,
  who        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (clip_id, who)
);
CREATE TABLE IF NOT EXISTS library_ratings (
  clip_id    TEXT NOT NULL REFERENCES library_clips(id) ON DELETE CASCADE,
  owner_key  TEXT NOT NULL,
  stars      SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (clip_id, owner_key)
);
CREATE TABLE IF NOT EXISTS library_reports (
  clip_id    TEXT NOT NULL REFERENCES library_clips(id) ON DELETE CASCADE,
  owner_key  TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (clip_id, owner_key)
);
ALTER TABLE library_reports ADD COLUMN IF NOT EXISTS visitor TEXT;
CREATE TABLE IF NOT EXISTS library_hidden_owners (owner_key TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- Téléchargement automatique des vidéos (yt-dlp) : file_source = 'auto' pour un fichier récupéré par le site (seuls ces fichiers sont
-- supprimés après VIDEO_RETENTION_DAYS jours), NULL pour un fichier déposé à la main (jamais supprimé automatiquement).
ALTER TABLE videos ADD COLUMN IF NOT EXISTS file_source      TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS fetch_attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS fetch_next_at    TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS fetch_error      TEXT;
-- auto_enabled_at : clips autorisés automatiquement, une seule fois
ALTER TABLE videos ADD COLUMN IF NOT EXISTS auto_enabled_at  TIMESTAMPTZ;
