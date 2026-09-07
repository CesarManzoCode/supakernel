CREATE SEQUENCE evt_id_seq;
CREATE TABLE evt (
  id bigint NOT NULL DEFAULT nextval('evt_id_seq'),
  kind text NOT NULL,
  CONSTRAINT evt_pkey PRIMARY KEY (id)
);
ALTER SEQUENCE evt_id_seq OWNED BY evt.id;
