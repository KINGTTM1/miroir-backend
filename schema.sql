-- Schema pour Miroir (Supabase PostgreSQL)
-- Execute ce script dans Supabase SQL Editor

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  identity TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_interaction TIMESTAMPTZ,
  interaction_count INTEGER DEFAULT 0,
  interventions_dismissed_until TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interventions (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'silence',
  question TEXT NOT NULL,
  dismissed INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS obstacles (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  cause TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_trees (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  parent_id TEXT,
  question TEXT NOT NULL,
  level INTEGER DEFAULT 0,
  order_index INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_responses (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  question_id TEXT,
  response TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_scores (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 50,
  feedback TEXT DEFAULT '',
  session_date TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_activities (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_interactions_goal ON interactions(goal_id);
CREATE INDEX IF NOT EXISTS idx_daily_responses_goal ON daily_responses(goal_id);
CREATE INDEX IF NOT EXISTS idx_daily_scores_goal ON daily_scores(goal_id);
CREATE INDEX IF NOT EXISTS idx_obstacles_goal ON obstacles(goal_id);
