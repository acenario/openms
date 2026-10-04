-- Agent memory, kept in its own schema so the game's tables (owned upstream) stay untouched.
-- Apply: bun study/agent/memory.js migrate
CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE IF NOT EXISTS agent.agents (
  name        text PRIMARY KEY,
  account     text NOT NULL,
  character   text NOT NULL,
  job_plan    text,
  personality text,
  port        integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per goal attempt (the self-improvement loop's raw data).
CREATE TABLE IF NOT EXISTS agent.episodes (
  id          bigserial PRIMARY KEY,
  agent       text NOT NULL REFERENCES agent.agents(name),
  version     text NOT NULL,
  goal_type   text NOT NULL,
  goal        jsonb NOT NULL,
  outcome     text NOT NULL,
  reason      text,
  metrics     jsonb NOT NULL DEFAULT '{}',
  map_id      integer,
  started_at  timestamptz NOT NULL,
  duration_ms integer NOT NULL
);
CREATE INDEX IF NOT EXISTS episodes_agent_type ON agent.episodes (agent, goal_type, started_at DESC);

-- Everything the deciding model reacts to: chat, NPC turns, maps, reflexes, level-ups.
CREATE TABLE IF NOT EXISTS agent.events (
  id          bigserial PRIMARY KEY,
  agent       text NOT NULL REFERENCES agent.agents(name),
  kind        text NOT NULL,
  data        jsonb NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_agent_kind ON agent.events (agent, kind, at DESC);

-- Distilled knowledge; `links` are vault note titles ([[...]] targets).
CREATE TABLE IF NOT EXISTS agent.lessons (
  id          bigserial PRIMARY KEY,
  agent       text NOT NULL REFERENCES agent.agents(name),
  topic       text NOT NULL,
  body        text NOT NULL,
  links       text[] NOT NULL DEFAULT '{}',
  confidence  text NOT NULL DEFAULT 'observed' CHECK (confidence IN ('observed', 'verified', 'hypothesis')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Agent-to-agent mail with read receipts; Board.md stays the human-readable mirror.
CREATE TABLE IF NOT EXISTS agent.messages (
  id          bigserial PRIMARY KEY,
  from_agent  text NOT NULL REFERENCES agent.agents(name),
  to_agent    text REFERENCES agent.agents(name), -- NULL = everyone
  subject     text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX IF NOT EXISTS messages_inbox ON agent.messages (to_agent, read_at, created_at);
