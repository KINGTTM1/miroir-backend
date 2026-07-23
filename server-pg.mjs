import express from 'express';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const app = express();
app.use(express.json());
app.use(express.static('public'));

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || '';
const LLM_API_KEY  = process.env.LLM_API_KEY  || '';
const LLM_MODEL   = process.env.LLM_MODEL    || 'llama-3.3-70b-versatile';
const PORT        = process.env.PORT || 4242;
const llmEnabled  = !!(LLM_ENDPOINT && LLM_API_KEY);

// ═══ DB helpers ═══
const q = (sql, params = []) => pool.query(sql, params);
const qOne = async (sql, params = []) => { const r = await q(sql, params); return r.rows[0] || null; };
const qAll = async (sql, params = []) => { const r = await q(sql, params); return r.rows; };

// ═══ Init DB (auto-create tables on first query) ═══
async function initDB() {
  const schema = `
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, identity TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(), last_interaction TIMESTAMPTZ,
      interaction_count INTEGER DEFAULT 0, interventions_dismissed_until TIMESTAMPTZ,
      status TEXT DEFAULT 'active', completed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS interventions (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      type TEXT DEFAULT 'silence', question TEXT NOT NULL, dismissed INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS obstacles (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      cause TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
    CREATE TABLE IF NOT EXISTS question_trees (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, parent_id TEXT,
      question TEXT NOT NULL, level INTEGER DEFAULT 0, order_index INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS daily_responses (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      question_id TEXT, response TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(), session_date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_scores (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      score INTEGER DEFAULT 50, feedback TEXT DEFAULT '',
      session_date TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS raw_activities (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;
  await q(schema);
  // Migrations for existing DB
  try { await q(`ALTER TABLE goals ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`); } catch(e) {}
  try { await q(`ALTER TABLE goals ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`); } catch(e) {}
  console.log('DB ready');
}
initDB().catch(console.error);

// ═══ TONE SYSTEM ═══
const TONES = {
  poetic: { label: 'Poétique', desc: 'Métaphores, images', sys: 'Ton poétique, métaphores, images.' },
  punchy: { label: 'Direct', desc: 'Phrases courtes, incisives', sys: 'Sois direct, court, incisif.' },
  gentle: { label: 'Bienveillant', desc: 'Encouragements, douceur', sys: 'Sois doux, bienveillant, sans jugement.' },
  witty:  { label: 'Léger', desc: 'Humour, auto-dérision', sys: 'Ajoute une touche d\'humour léger et d\'auto-dérision.' }
};
async function tonePrompt() {
  const row = await qOne("SELECT value FROM settings WHERE key='tone'");
  const key = row?.value || 'gentle';
  const t = TONES[key] || TONES.gentle;
  return t.sys;
}
async function toneLabel() {
  const row = await qOne("SELECT value FROM settings WHERE key='tone'");
  const key = row?.value || 'gentle';
  return TONES[key] || TONES.gentle;
}

async function callLLM(prompt) {
  if (!llmEnabled) return null;
  try {
    const tone = await tonePrompt();
    const res = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: `Tu es un coach bienveillant et lucide. ${tone} Réponds UNIQUEMENT avec le texte demandé, sans guillemets ni formatage.` },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 150
      })
    });
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('LLM error:', e.message); return null; }
}

// ═══ GOALS CRUD ═══
app.get('/api/goals', async (req, res) => {
  const rows = await qAll("SELECT * FROM goals WHERE status='active' OR status IS NULL ORDER BY created_at DESC");
  const enriched = await Promise.all(rows.map(async g => {
    const ints = await qAll('SELECT timestamp FROM interactions WHERE goal_id=$1', [g.id]);
    const scores = await qAll('SELECT * FROM daily_scores WHERE goal_id=$1 ORDER BY session_date ASC', [g.id]);
    const obs = await qAll('SELECT cause, COUNT(*) as c FROM obstacles WHERE goal_id=$1 GROUP BY cause ORDER BY c DESC', [g.id]);
    const today = new Date().toISOString().slice(0, 10);
    const todayResp = await qOne("SELECT COUNT(*) as c FROM daily_responses WHERE goal_id=$1 AND session_date=$2", [g.id, today]);
    const lastScore = scores.length > 0 ? scores[scores.length - 1] : null;
    const qCount = todayResp?.c || 0;
    return {
      id: g.id, text: g.text, identity: g.identity, createdAt: g.created_at,
      lastInteraction: g.last_interaction, interactionCount: g.interaction_count,
      interactions: ints.map(i => i.timestamp),
      trend: computeTrend(ints.map(i => i.timestamp)),
      obstacles: obs.length > 0 ? { total: obs.reduce((s, o) => s + parseInt(o.c), 0), breakdown: obs.map(o => ({ cause: o.cause, pct: 0 })) } : undefined,
      questions: { total: 0, today_answered: qCount },
      todayAnswered: qCount, lastScore: lastScore?.score || null
    };
  }));
  res.json(enriched);
});

function computeTrend(timestamps) {
  const now = Date.now();
  const daily = Array(14).fill(0);
  timestamps.forEach(ts => {
    const diff = Math.round((now - new Date(ts).getTime()) / 864e5);
    if (diff >= 0 && diff < 14) daily[daily.length - 1 - diff]++;
  });
  if (daily.length < 7) return { direction: 'stable', severity: 'none', daily };
  const oldAvg = daily.slice(0, 7).reduce((s, v) => s + v, 0) / 7;
  const newAvg = daily.slice(-7).reduce((s, v) => s + v, 0) / 7;
  const decline = (oldAvg - newAvg) / (oldAvg || 1);
  let direction = 'stable', severity = 'none';
  if (decline > 0.5 && newAvg < 0.3) { direction = 'declining'; severity = 'critical'; }
  else if (decline > 0.4) { direction = 'declining'; severity = 'moderate'; }
  else if (decline > 0.2) { direction = 'declining'; severity = 'mild'; }
  else if (decline < -0.2) { direction = 'rising'; severity = 'moderate'; }
  return { direction, severity, daily };
}

// ═══ Create goal ═══
app.post('/api/goals', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 3) return res.status(400).json({ error: 'Texte trop court' });
    const id = randomUUID(), now = new Date().toISOString();
    let identity = `Je suis quelqu'un qui ${text.toLowerCase().replace(/^(.*?)(?: (?:chaque|tous les|par|le|la|les|du|de la|des))?.*$/, '$1')}.`;
    
    if (llmEnabled) {
      const raw = await callLLM(`Transforme cet objectif comportemental en UNE phrase d'identité au présent, courte, incarnée, à la première personne. L'action concrète et la fréquence doivent apparaître dans la phrase. Objectif: "${text}".`);
      if (raw && raw.length > 10) identity = raw;
    }
    
    await q('INSERT INTO goals (id, text, identity, created_at, interaction_count) VALUES ($1,$2,$3,$4,0)', [id, text.trim(), identity, now]);
    
    // Auto-generate question tree
    if (llmEnabled) {
      try {
        const raw = await callLLM(`Tu es un coach. Pour l'objectif "${text}" (identité: "${identity}"), génère 5 questions au format JSON exact, qui forme une chaîne progressive pour comprendre le rapport de la personne à cet engagement. Format: [{"q":"question 1"},{"q":"question 2","children":[{"q":"sous-question"}]},...]. Réponds UNIQUEMENT avec le JSON.`);
        if (raw) {
          const questions = JSON.parse(raw.replace(/```json|```/g, '').trim());
          if (Array.isArray(questions)) {
            for (const qItem of questions) {
              const qId = randomUUID();
              await q('INSERT INTO question_trees (id, goal_id, question, level, order_index) VALUES ($1,$2,$3,0,0)', [qId, id, qItem.q]);
              if (qItem.children) {
                for (const child of qItem.children) {
                  await q('INSERT INTO question_trees (id, goal_id, parent_id, question, level, order_index) VALUES ($1,$2,$3,$4,1,0)', [randomUUID(), id, qId, child.q]);
                }
              }
            }
          }
        }
      } catch(e) { /* silent */ }
    }
    
    res.json({ id, text: text.trim(), identity });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ═══ Organization ═══
app.get('/api/goals/organized', async (req, res) => {
  const goals = await qAll("SELECT * FROM goals WHERE status='active' OR status IS NULL");
  const now = new Date();
  const enriched = await Promise.all(goals.map(async g => {
    const ints = await qAll('SELECT timestamp FROM interactions WHERE goal_id=$1', [g.id]);
    const timestamps = ints.map(r => r.timestamp);
    const scores = await qAll('SELECT * FROM daily_scores WHERE goal_id=$1 ORDER BY session_date ASC', [g.id]);
    const lastScore = scores.length > 0 ? scores[scores.length - 1].score : null;
    const today = now.toISOString().slice(0, 10);
    const tr = computeTrend(timestamps);
    const todayResp = await qOne("SELECT COUNT(*) as c FROM daily_responses WHERE goal_id=$1 AND session_date=$2", [g.id, today]);
    const daysSinceStart = timestamps.length ? Math.round((now.getTime() - new Date(timestamps[0]).getTime()) / 864e5) : 0;
    const lastInteraction = timestamps.length > 0 ? timestamps[timestamps.length - 1] : null;
    const obs = await qAll('SELECT cause, COUNT(*) as c FROM obstacles WHERE goal_id=$1 GROUP BY cause', [g.id]);
    const obsTotal = obs.reduce((s, o) => s + parseInt(o.c), 0);
    return {
      id: g.id, text: g.text, identity: g.identity, createdAt: g.created_at,
      lastInteraction, interactionCount: timestamps.length,
      interactions: timestamps, trend: tr, todayAnswered: todayResp?.c || 0,
      lastScore, daysSinceStart,
      obstacles: obsTotal > 0 ? { total: obsTotal, breakdown: obs.map(o => ({ cause: o.cause, pct: Math.round(parseInt(o.c) / obsTotal * 100) })) } : {}
    };
  }));
  
  const urgent = enriched.filter(g => (g.trend.direction === 'declining' && (g.trend.severity === 'critical' || g.trend.severity === 'moderate')) || g.daysSinceStart <= 2)
    .sort((a, b) => b.trend.daily.slice(-7).reduce((s, v) => s + v, 0) - a.trend.daily.slice(-7).reduce((s, v) => s + v, 0));
  const normal = enriched.filter(g => !urgent.includes(g) && g.daysSinceStart > 2)
    .sort((a, b) => (b.todayAnswered || 0) - (a.todayAnswered || 0));
  const stable = enriched.filter(g => !urgent.includes(g) && !normal.includes(g));
  res.json({ urgent, normal, stable, all: enriched });
});

// ═══ Remaining endpoints (interactions, obstacles, tone, questions, scores, etc.) ═══
// These follow the same pg pattern — I'll include the most critical ones

app.post('/api/goals/:id/interact', async (req, res) => {
  const g = await qOne('SELECT * FROM goals WHERE id=$1', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'Introuvable' });
  const now = new Date().toISOString();
  await q('INSERT INTO interactions (id, goal_id, timestamp) VALUES ($1,$2,$3)', [randomUUID(), g.id, now]);
  await q('UPDATE goals SET last_interaction=$1, interaction_count=interaction_count+1 WHERE id=$2', [now, g.id]);
  
  let reinforcement = '';
  if (llmEnabled) {
    const raw = await callLLM(`L'utilisateur vient d'agir sur son objectif "${g.text}" (identité: "${g.identity}"). Génère UNE courte phrase de renforcement narratif (pas un template), comme si tu constatais un fait. Pas de jugement, pas d'exagération.`);
    if (raw) reinforcement = raw;
  }
  if (!reinforcement) {
    const msgs = ['Une action de plus. Ça construit.', 'C\'est exactement le genre de chose que ferait cette personne.', 'Le chemin se trace pas à pas.', 'Tu es cohérent.', 'Un pas de plus.'];
    reinforcement = msgs[Math.floor(Math.random() * msgs.length)];
  }
  res.json({ reinforcement });
});

app.get('/api/interventions', async (req, res) => {
  const goals = await qAll("SELECT * FROM goals WHERE status='active' OR status IS NULL");
  const interventions = [];
  for (const g of goals) {
    const ints = await qAll('SELECT timestamp FROM interactions WHERE goal_id=$1 ORDER BY timestamp DESC LIMIT 14', [g.id]);
    const trend = computeTrend(ints.map(i => i.timestamp));
    const lastWeek = trend.daily.slice(-7).reduce((s, v) => s + v, 0);
    
    if (trend.direction === 'declining' && trend.severity === 'critical' && lastWeek === 0) {
      const daysSinceLast = ints.length ? Math.round((Date.now() - new Date(ints[0].timestamp).getTime()) / 864e5) : 0;
      if (daysSinceLast >= 5) {
        interventions.push({
          id: randomUUID(), goalId: g.id,
          question: `Ça fait ${daysSinceLast} jours sans nouvelle de « ${g.identity} ». Qu'est-ce qui a changé ?`,
          type: 'predictive'
        });
      }
    }
  }
  res.json(interventions.slice(0, 1));
});

app.post('/api/interventions/dismiss', async (req, res) => {
  const { goalId } = req.body;
  if (goalId) await q('UPDATE goals SET interventions_dismissed_until=$1 WHERE id=$2', [new Date().toISOString(), goalId]);
  res.json({ dismissed: true });
});

app.delete('/api/goals/:id', async (req, res) => {
  await q('DELETE FROM goals WHERE id=$1', [req.params.id]);
  res.json({ deleted: true });
});

// ═══ Tone ═══
app.get('/api/tone', async (req, res) => {
  const row = await qOne("SELECT value FROM settings WHERE key='tone'");
  const key = row?.value || 'gentle';
  res.json({ tone: key, ...TONES[key] || TONES.gentle, tones: Object.entries(TONES).map(([k, v]) => ({ key: k, ...v })) });
});

app.post('/api/tone', async (req, res) => {
  const { tone } = req.body;
  if (!TONES[tone]) return res.status(400).json({ error: 'Ton invalide' });
  await q("INSERT INTO settings (key, value) VALUES ('tone', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [tone]);
  res.json({ tone });
});

// ═══ Questions ═══
app.post('/api/goals/:id/next-question', async (req, res) => {
  const g = await qOne('SELECT * FROM goals WHERE id=$1', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'Introuvable' });
  const { conversation, isEvening, context } = req.body;
  
  if (llmEnabled) {
    const convText = (conversation || []).map(c => `Q: ${c.q || ''}\nR: ${c.a || ''}`).join('\n');
    const ctx = context || `Objectif: "${g.text}". Identité: "${g.identity}".`;
    const raw = await callLLM(`Check quotidien. ${ctx} ${convText ? 'Conversation récente:\n' + convText : ''} Génère UNE question ouverte et personnalisée pour aujourd'hui, qui aide à réfléchir à cet engagement. Pose UNE question, directement.`);
    if (raw) return res.json({ question: raw });
  }
  const fallbacks = ['Comment te sens-tu par rapport à cet engagement aujourd\'hui ?', 'Qu\'est-ce qui a changé depuis la dernière fois ?', 'As-tu rencontré des difficultés ?', 'Qu\'est-ce qui pourrait t\'aider à avancer ?'];
  res.json({ question: fallbacks[Math.floor(Math.random() * fallbacks.length)] });
});

app.post('/api/goals/:id/respond', async (req, res) => {
  const { questionId, response } = req.body;
  const today = new Date().toISOString().slice(0, 10);
  await q('INSERT INTO daily_responses (id, goal_id, question_id, response, session_date) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), req.params.id, questionId || 'checkin', response, today]);
  res.json({ stored: true });
});

app.get('/api/goals/:id/history', async (req, res) => {
  const rows = await qAll('SELECT dr.*, qt.question FROM daily_responses dr LEFT JOIN question_trees qt ON dr.question_id = qt.id WHERE dr.goal_id=$1 ORDER BY dr.created_at DESC', [req.params.id]);
  const byDate = {};
  rows.forEach(r => {
    const d = r.session_date || r.created_at?.slice(0, 10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(r);
  });
  res.json({ responses: rows, byDate, totalResponses: rows.length, totalSessions: Object.keys(byDate).length });
});

// ═══ Score ═══
app.post('/api/goals/:id/score', async (req, res) => {
  const g = await qOne('SELECT * FROM goals WHERE id=$1', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'Introuvable' });
  const today = new Date().toISOString().slice(0, 10);
  const responses = await qAll("SELECT * FROM daily_responses WHERE goal_id=$1 AND session_date=$2", [g.id, today]);
  
  let score = 50, feedback = 'Pas assez de données aujourd\'hui pour un score précis.';
  if (responses.length >= 1) {
    const totalPossible = 5;
    const factor = Math.min(1, responses.length / totalPossible);
    const interactionCount = g.interaction_count || 0;
    const baseScore = 30 + factor * 40;
    const bonus = Math.min(20, interactionCount * 2);
    score = Math.round(Math.min(95, baseScore + bonus));
    
    if (llmEnabled) {
      const answers = responses.map(r => r.response).join(' | ');
      const raw = await callLLM(`Sur une échelle de 0 à 100, en toute franchise et objectivité, note l'engagement de cette personne envers son objectif "${g.text}" (identité: "${g.identity}") basé sur ses réponses d'aujourd'hui: "${answers}". Réponds UNIQUEMENT par le nombre.`);
      if (raw) {
        const parsed = parseInt(raw.replace(/[^0-9]/g, ''));
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) score = parsed;
      }
    }
  }
  
  // Check previous score
  const prev = await qOne("SELECT * FROM daily_scores WHERE goal_id=$1 AND session_date<$2 ORDER BY session_date DESC LIMIT 1", [g.id, today]);
  const prevScore = prev ? prev.score : null;
  
  // Save
  await q("INSERT INTO daily_scores (id, goal_id, score, feedback, session_date) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET score=$3, feedback=$4", [randomUUID(), g.id, score, feedback, today]);
  
  res.json({ score, feedback, previousScore: prevScore, answered: responses.length });
});

app.get('/api/goals/:id/scores', async (req, res) => {
  const rows = await qAll('SELECT * FROM daily_scores WHERE goal_id=$1 ORDER BY session_date ASC', [req.params.id]);
  res.json(rows);
});

// ═══ Obstacles ═══
app.post('/api/goals/:id/obstacle', async (req, res) => {
  await q('INSERT INTO obstacles (id, goal_id, cause) VALUES ($1,$2,$3)', [randomUUID(), req.params.id, req.body.cause]);
  res.json({ stored: true });
});

app.get('/api/goals/:id/obstacles', async (req, res) => {
  const rows = await qAll('SELECT cause, COUNT(*) as c FROM obstacles WHERE goal_id=$1 GROUP BY cause ORDER BY c DESC', [req.params.id]);
  const total = rows.reduce((s, r) => s + parseInt(r.c), 0);
  res.json({ total, breakdown: rows.map(r => ({ cause: r.cause, count: parseInt(r.c), pct: total > 0 ? Math.round(parseInt(r.c) / total * 100) : 0 })) });
});

app.post('/api/goals/:id/recalibrate', async (req, res) => {
  const g = await qOne('SELECT * FROM goals WHERE id=$1', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'Introuvable' });
  let text = g.text, identity = g.identity;
  if (llmEnabled) {
    const raw = await callLLM(`L'objectif "${g.text}" a rencontré l'obstacle: "${req.body.cause || 'non spécifié'}". Propose une version recalibrée, plus réaliste et accessible, en gardant l'esprit mais en réduisant l'ampleur. Réponds UNIQUEMENT par une phrase courte d'objectif.`);
    if (raw && raw.length > 5) text = raw;
    const idRaw = await callLLM(`Transforme cet objectif recalibré "${text}" en une phrase d'identité. Réponds UNIQUEMENT avec la phrase.`);
    if (idRaw && idRaw.length > 5) identity = idRaw;
  }
  await q('UPDATE goals SET text=$1, identity=$2 WHERE id=$3', [text, identity, g.id]);
  res.json({ text, identity });
});

// ═══ Latent detection ═══
app.get('/api/consent', async (req, res) => {
  const row = await qOne("SELECT value FROM settings WHERE key='latent_consent'");
  res.json({ enabled: row?.value === 'true' });
});

app.post('/api/consent', async (req, res) => {
  await q("INSERT INTO settings (key, value) VALUES ('latent_consent', $1) ON CONFLICT (key) DO UPDATE SET value=$1", [req.body.enabled ? 'true' : 'false']);
  res.json({ enabled: req.body.enabled });
});

app.post('/api/activities', async (req, res) => {
  await q('INSERT INTO raw_activities (id, text) VALUES ($1,$2)', [randomUUID(), req.body.text]);
  res.json({ stored: true });
});

app.get('/api/patterns', async (req, res) => {
  const row = await qOne("SELECT value FROM settings WHERE key='latent_consent'");
  if (row?.value !== 'true') return res.json({ enabled: false, patterns: [] });
  
  const activities = await qAll("SELECT text FROM raw_activities WHERE created_at > NOW() - INTERVAL '30 days' ORDER BY created_at DESC");
  const goals = await qAll("SELECT text FROM goals");
  const goalTexts = new Set(goals.map(g => g.text.toLowerCase()));
  
  const rules = [
    { keywords: ['sport','salle','muscu','course','vélo','yoga','gym','natation'], label: 'sport/exercice' },
    { keywords: ['médite','méditation','respire','calme','pleine conscience','zen'], label: 'méditation/calme' },
    { keywords: ['lis','lecture','livre','lu','page'], label: 'lecture' },
    { keywords: ['écris','écriture','journal','note'], label: 'écriture' },
    { keywords: ['code','programme','dev','python','js'], label: 'code/programmation' },
  ];
  
  const counts = {};
  activities.forEach(a => {
    const t = a.text.toLowerCase();
    for (const rule of rules) {
      if (rule.keywords.some(k => t.includes(k))) {
        counts[rule.label] = (counts[rule.label] || 0) + 1;
      }
    }
  });
  
  const suggestions = Object.entries(counts)
    .filter(([label, count]) => count >= 3 && !goalTexts.has(label))
    .map(([label, count]) => ({ label, count, frequency: `${(count / 4).toFixed(1)}/semaine` }));
  
  res.json({ enabled: true, patterns: suggestions });
});

// ═══ Completion ═══
app.post('/api/goals/:id/complete', async (req, res) => {
  const g = await qOne('SELECT * FROM goals WHERE id=$1', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'Introuvable' });
  const now = new Date().toISOString();
  await q("UPDATE goals SET status='completed', completed_at=$1 WHERE id=$2", [now, g.id]);
  
  let summary = 'Objectif transformé en expérience.';
  if (llmEnabled) {
    const scores = await qAll('SELECT * FROM daily_scores WHERE goal_id=$1 ORDER BY session_date ASC', [g.id]);
    const respCount = (await qOne('SELECT COUNT(*) as c FROM daily_responses WHERE goal_id=$1', [g.id]))?.c || 0;
    const avgScore = scores.length ? Math.round(scores.reduce((s, x) => s + x.score, 0) / scores.length) : 0;
    const raw = await callLLM(`L'utilisateur a complété son objectif "${g.text}" (identité: "${g.identity}"). Scores: ${scores.length} sessions, moyenne ${avgScore}/100. ${respCount} réponses données. Génère UNE phrase de célébration personnalisée.`);
    if (raw) summary = raw;
  }
  res.json({ status: 'completed', summary, completedAt: now });
});

app.get('/api/goals/experiences', async (req, res) => {
  const goals = await qAll("SELECT * FROM goals WHERE status='completed' ORDER BY completed_at DESC");
  const enriched = await Promise.all(goals.map(async g => {
    const scores = await qAll('SELECT * FROM daily_scores WHERE goal_id=$1 ORDER BY session_date ASC', [g.id]);
    const respCount = (await qOne('SELECT COUNT(*) as c FROM daily_responses WHERE goal_id=$1', [g.id]))?.c || 0;
    const avgScore = scores.length ? Math.round(scores.reduce((s, x) => s + x.score, 0) / scores.length) : 0;
    return { ...g, avgScore, responseCount: respCount, scores };
  }));
  res.json(enriched);
});

app.get('/api/goals/:id/completion-check', async (req, res) => {
  const g = await qOne("SELECT * FROM goals WHERE id=$1 AND (status='active' OR status IS NULL)", [req.params.id]);
  if (!g) return res.json({ ready: false, reason: 'already completed' });
  const scores = await qAll('SELECT * FROM daily_scores WHERE goal_id=$1 ORDER BY session_date ASC', [g.id]);
  if (scores.length < 3) return res.json({ ready: false, reason: 'not enough data' });
  const recent = scores.slice(-3);
  const avgRecent = Math.round(recent.reduce((s, x) => s + x.score, 0) / recent.length);
  const allAvg = Math.round(scores.reduce((s, x) => s + x.score, 0) / scores.length);
  const ints = await qAll('SELECT timestamp FROM interactions WHERE goal_id=$1 ORDER BY timestamp ASC', [g.id]);
  const timestamps = ints.map(r => r.timestamp);
  const trend = computeTrend(timestamps);
  const daysSinceStart = timestamps.length ? Math.round((Date.now() - new Date(timestamps[0]).getTime()) / 864e5) : 0;
  const ready = avgRecent >= 70 && allAvg >= 55 && trend.direction !== 'declining' && daysSinceStart >= 7;
  res.json({ ready, avgRecent, allAvg, daysSinceStart, scores, reason: ready ? 'ready' : 'still building' });
});

// ═══ Reframe ═══
app.post('/api/goals/:id/reframe', async (req, res) => {
  const g = await qOne('SELECT * FROM goals WHERE id=$1', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'Introuvable' });
  let identity = g.identity;
  if (llmEnabled) {
    const raw = await callLLM(`Propose une reformulation alternative pour l'objectif "${g.text}". Une phrase d'identité au présent, courte et incarnée.`);
    if (raw && raw.length > 5) identity = raw;
  }
  await q('UPDATE goals SET identity=$1 WHERE id=$2', [identity, g.id]);
  res.json({ identity });
});

// ═══ Start server ═══
app.listen(PORT, () => console.log(`miroir → http://localhost:${PORT}`));
