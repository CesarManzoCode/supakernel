CREATE SEQUENCE note_id_seq START 1 INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807;

CREATE TABLE note (
  id bigint NOT NULL DEFAULT nextval('note_id_seq'),
  owner uuid NOT NULL,
  title text NOT NULL,
  body text,
  pinned boolean NOT NULL DEFAULT false,
  score integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_pkey PRIMARY KEY (id),
  CONSTRAINT note_score_nonneg CHECK (score >= 0),
  CONSTRAINT note_title_len CHECK (title <> ''),
  CONSTRAINT note_owner_title_key UNIQUE (owner, title)
);

ALTER SEQUENCE note_id_seq OWNED BY note.id;

CREATE INDEX note_owner_idx ON note (owner);
CREATE UNIQUE INDEX note_pinned_owner_uk ON note (owner) WHERE pinned = true;
