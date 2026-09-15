-- CivicChain database schema

DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('citizen', 'officer', 'admin');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE complaint_status AS ENUM ('FILED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          user_role NOT NULL DEFAULT 'citizen',
    department    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS complaints (
    id              SERIAL PRIMARY KEY,
    complaint_code  TEXT UNIQUE NOT NULL,
    citizen_id      INTEGER NOT NULL REFERENCES users(id),
    category        TEXT NOT NULL,
    location        TEXT NOT NULL,
    location_key    TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL,
    priority        TEXT NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('URGENT', 'MEDIUM', 'LOW')),
    status          complaint_status NOT NULL DEFAULT 'FILED',
    seen_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Columns added after the first release -- IF NOT EXISTS makes re-running
-- this file safe on a database that already has the original table.
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS location_key TEXT NOT NULL DEFAULT '';
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;

-- Photos attached when a citizen files a complaint. uploaded_at is always
-- server-set (see routes/complaints.js) so neither citizen nor officer can
-- backdate or edit it.
CREATE TABLE IF NOT EXISTS complaint_images (
    id            SERIAL PRIMARY KEY,
    complaint_id  INTEGER NOT NULL REFERENCES complaints(id),
    image_data    TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Photos an officer attaches as proof of resolution. Same rule: uploaded_at
-- is always server-set, never client-supplied.
CREATE TABLE IF NOT EXISTS resolution_photos (
    id            SERIAL PRIMARY KEY,
    complaint_id  INTEGER NOT NULL REFERENCES complaints(id),
    officer_id    INTEGER REFERENCES users(id),
    image_data    TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One "agree" per citizen per complaint (the "+" button). Citizens filing at
-- an address that already has an open complaint are pointed here instead of
-- creating a duplicate.
CREATE TABLE IF NOT EXISTS complaint_agrees (
    id            SERIAL PRIMARY KEY,
    complaint_id  INTEGER NOT NULL REFERENCES complaints(id),
    user_id       INTEGER NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (complaint_id, user_id)
);

CREATE TABLE IF NOT EXISTS complaint_comments (
    id            SERIAL PRIMARY KEY,
    complaint_id  INTEGER NOT NULL REFERENCES complaints(id),
    user_id       INTEGER NOT NULL REFERENCES users(id),
    comment_text  TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upvote/downvote (one per citizen) on a resolution photo, letting the
-- public agree or dispute that an issue was actually fixed.
CREATE TABLE IF NOT EXISTS resolution_votes (
    id                   SERIAL PRIMARY KEY,
    resolution_photo_id  INTEGER NOT NULL REFERENCES resolution_photos(id),
    user_id              INTEGER NOT NULL REFERENCES users(id),
    vote                 SMALLINT NOT NULL CHECK (vote IN (1, -1)),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (resolution_photo_id, user_id)
);

CREATE TABLE IF NOT EXISTS resolution_comments (
    id                   SERIAL PRIMARY KEY,
    resolution_photo_id  INTEGER NOT NULL REFERENCES resolution_photos(id),
    user_id              INTEGER NOT NULL REFERENCES users(id),
    comment_text         TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only hash-chained ledger. Each row's hash depends on the previous
-- row's hash plus its own contents, so tampering with any past row breaks
-- every hash after it -- this is what /verify checks.
CREATE TABLE IF NOT EXISTS complaint_events (
    id            SERIAL PRIMARY KEY,
    complaint_id  INTEGER NOT NULL REFERENCES complaints(id),
    event_index   INTEGER NOT NULL,
    action        TEXT NOT NULL,
    actor_id      INTEGER REFERENCES users(id),
    prev_hash     TEXT NOT NULL,
    hash          TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (complaint_id, event_index)
);

CREATE INDEX IF NOT EXISTS idx_complaints_citizen ON complaints(citizen_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_location_key ON complaints(location_key);
CREATE INDEX IF NOT EXISTS idx_events_complaint ON complaint_events(complaint_id);
CREATE INDEX IF NOT EXISTS idx_images_complaint ON complaint_images(complaint_id);
CREATE INDEX IF NOT EXISTS idx_resolution_photos_complaint ON resolution_photos(complaint_id);
CREATE INDEX IF NOT EXISTS idx_agrees_complaint ON complaint_agrees(complaint_id);
CREATE INDEX IF NOT EXISTS idx_comments_complaint ON complaint_comments(complaint_id);
CREATE INDEX IF NOT EXISTS idx_resolution_votes_photo ON resolution_votes(resolution_photo_id);
CREATE INDEX IF NOT EXISTS idx_resolution_comments_photo ON resolution_comments(resolution_photo_id);
