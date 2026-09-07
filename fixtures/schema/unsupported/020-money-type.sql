CREATE TABLE invoice (
  id bigint NOT NULL,
  total money NOT NULL,
  CONSTRAINT invoice_pkey PRIMARY KEY (id)
);
