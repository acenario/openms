-- Structured asks between agents: who needs what from which owner, and where it stands.
-- Owners are listed in knowledge/Learned/Infrastructure/Owners.md (an ask to an area goes to its owner).
CREATE TABLE IF NOT EXISTS agent.requests (
  id          bigserial PRIMARY KEY,
  from_agent  text NOT NULL REFERENCES agent.agents(name),
  to_agent    text NOT NULL REFERENCES agent.agents(name),
  area        text NOT NULL,                      -- e.g. "agent.js", "nav.js", "game:server", "quests"
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'done', 'declined')),
  resolution  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS requests_owner_status ON agent.requests (to_agent, status, created_at);
