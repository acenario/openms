-- Hash of the agent's own brain overlay (brains/<Name>.js) when the episode ran; NULL = base brain only.
-- `version` mixes base + overlay, so shared-brain edits churn it; `overlay` isolates the agent's own experiments.
ALTER TABLE agent.episodes ADD COLUMN IF NOT EXISTS overlay text;
