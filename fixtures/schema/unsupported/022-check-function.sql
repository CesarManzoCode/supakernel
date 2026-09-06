CREATE TABLE person (
  id bigint NOT NULL,
  name text NOT NULL,
  CONSTRAINT person_pkey PRIMARY KEY (id),
  CONSTRAINT person_name_len CHECK (length(name) > 2)
);
