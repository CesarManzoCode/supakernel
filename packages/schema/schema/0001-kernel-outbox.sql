-- Kernel-managed change-capture outbox (contract §15). Realtime triggers write here in the
-- same transaction as the row; the dispatcher reads after commit.
CREATE SEQUENCE outbox_sequence_seq;

CREATE TABLE outbox (
  sequence bigint NOT NULL DEFAULT nextval('outbox_sequence_seq'),
  event_schema text NOT NULL DEFAULT 'public',
  event_table text NOT NULL,
  op text NOT NULL,
  primary_key jsonb NOT NULL,
  old_record jsonb,
  new_record jsonb,
  committed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_pkey PRIMARY KEY (sequence),
  CONSTRAINT outbox_op_valid CHECK (op IN ('INSERT', 'UPDATE', 'DELETE'))
);

ALTER SEQUENCE outbox_sequence_seq OWNED BY outbox.sequence;

CREATE INDEX outbox_table_idx ON outbox (event_table);
