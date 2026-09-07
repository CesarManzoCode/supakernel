CREATE TABLE parent (id bigint NOT NULL, CONSTRAINT parent_pkey PRIMARY KEY (id));
CREATE TABLE child (
  id bigint NOT NULL,
  parent_id bigint NOT NULL,
  CONSTRAINT child_pkey PRIMARY KEY (id),
  CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED
);
