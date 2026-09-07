CREATE TYPE color AS ENUM ('red', 'green', 'blue');

CREATE TABLE widget (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  amount numeric NOT NULL DEFAULT 0,
  ratio double precision NOT NULL DEFAULT 0,
  big bigint NOT NULL DEFAULT 0,
  payload bytea,
  meta jsonb,
  shade color NOT NULL DEFAULT 'red',
  seen_at timestamp,
  CONSTRAINT widget_pkey PRIMARY KEY (id)
);
