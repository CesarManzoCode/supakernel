CREATE TABLE doc (
  id bigint NOT NULL,
  title text NOT NULL,
  body text,
  CONSTRAINT doc_pkey PRIMARY KEY (id)
);
