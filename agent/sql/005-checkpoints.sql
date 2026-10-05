-- Session checkpoints: what a (model) session was doing, so a fresh session can resume it (resume.js).
CREATE TABLE IF NOT EXISTS agent.checkpoints (
  id          bigserial PRIMARY KEY,
  agent       text NOT NULL REFERENCES agent.agents(name),
  summary     text NOT NULL,
  tasks       text[] NOT NULL DEFAULT '{}',
  decisions   text[] NOT NULL DEFAULT '{}',
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkpoints_agent ON agent.checkpoints (agent, created_at DESC);
