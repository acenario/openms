-- A lesson proven wrong points at the lesson that corrects it; readers hide superseded rows by default.
ALTER TABLE agent.lessons ADD COLUMN IF NOT EXISTS superseded_by bigint REFERENCES agent.lessons(id);
