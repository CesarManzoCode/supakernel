CREATE SEQUENCE project_id_seq;
CREATE SEQUENCE task_id_seq;

CREATE TABLE project (
  id bigint NOT NULL DEFAULT nextval('project_id_seq'),
  slug text NOT NULL,
  name text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  CONSTRAINT project_pkey PRIMARY KEY (id),
  CONSTRAINT project_slug_key UNIQUE (slug)
);

CREATE TABLE task (
  id bigint NOT NULL DEFAULT nextval('task_id_seq'),
  project_id bigint NOT NULL,
  title text NOT NULL,
  priority integer NOT NULL DEFAULT 1,
  done boolean NOT NULL DEFAULT false,
  due date,
  CONSTRAINT task_pkey PRIMARY KEY (id),
  CONSTRAINT task_priority_range CHECK (priority >= 1 AND priority <= 5),
  CONSTRAINT task_project_fk FOREIGN KEY (project_id) REFERENCES project (id) ON DELETE CASCADE
);

ALTER SEQUENCE project_id_seq OWNED BY project.id;
ALTER SEQUENCE task_id_seq OWNED BY task.id;

CREATE INDEX task_project_idx ON task (project_id);
CREATE INDEX task_open_idx ON task (project_id) WHERE done = false;
