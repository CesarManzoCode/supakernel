CREATE TABLE item (
  id bigint NOT NULL,
  label text NOT NULL,
  legacy text,
  CONSTRAINT item_pkey PRIMARY KEY (id)
);
