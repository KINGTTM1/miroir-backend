import express from 'express';
import initSqlJs from 'sql.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || '';
const LLM_API_KEY  = process.env.LLM_API_KEY  || '';
const LLM_MODEL   = process.env.LLM_MODEL    || 'llama-3.3-70b-versatile';
const PORT        = process.env.PORT || 4242;
const llmEnabled  = !!(LLM_ENDPOINT && LLM_API_KEY);
const RAILWAY = !!process.env.RAILWAY_SERVICE_ID;
const DATA_DIR = RAILWAY ? path.resolve('/data') : path.resolve('data');
const DB_PATH  = path.join(DATA_DIR, 'miroir.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db;
async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');
  try { db.run('ALTER TABLE goals ADD COLUMN status TEXT DEFAULT \'active\''); } catch(e) {}
  try { db.run('ALTER TABLE goals ADD COLUMN completed_at TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE goals ADD COLUMN duration_days INTEGER DEFAULT 30'); } catch(e) {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, identity TEXT NOT NULL,
      created_at TEXT NOT NULL, last_interaction TEXT,
      interaction_count INTEGER DEFAULT 0, interventions_dismissed_until TEXT,
      status TEXT DEFAULT 'active', completed_at TEXT, duration_days INTEGER DEFAULT 30
    );
    CREATE TABLE IF NOT EXISTS interactions (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS interventions (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'silence', question TEXT NOT NULL, dismissed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS obstacles (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      cause TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
    CREATE TABLE IF NOT EXISTS question_trees (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, parent_id TEXT,
      question TEXT NOT NULL, level INTEGER DEFAULT 0, order_index INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS daily_responses (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      question_id TEXT, response TEXT NOT NULL, created_at TEXT NOT NULL, session_date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_scores (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      score INTEGER DEFAULT 50, feedback TEXT DEFAULT '',
      session_date TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS raw_activities (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  dbSave();
  console.log('DB ready:', DB_PATH);
}

function dbSave() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function dbRun(sql, params) { db.run(sql, params); }
function dbGet(sql, params) { const r = db.exec(sql, params); return r.length && r[0].values.length ? Object.fromEntries(r[0].columns.map((c,i)=>[c,r[0].values[0][i]])) : null; }
function dbAll(sql, params) {
  const r = db.exec(sql, params);
  if (!r.length) return [];
  return r[0].values.map(row => Object.fromEntries(r[0].columns.map((c,i)=>[c,row[i]])));
}

init().catch(console.error);

// ═══ TONE SYSTEM ═══
const TONES = {
  poetic: { label:'Poétique', desc:'Métaphores, images', sys:'Ton poétique, métaphores, images.' },
  punchy: { label:'Direct', desc:'Phrases courtes, incisives', sys:'Sois direct, court, incisif.' },
  gentle: { label:'Bienveillant', desc:'Encouragements, douceur', sys:'Sois doux, bienveillant, sans jugement.' },
  witty:  { label:'Léger', desc:'Humour, auto-dérision', sys:'Ajoute une touche d\'humour léger et d\'auto-dérision.' }
};
const TONE_KEYS = Object.keys(TONES);
function tonePrompt() {
  const row = dbGet("SELECT value FROM settings WHERE key='tone'");
  const key = row?.value || 'gentle';
  return (TONES[key] || TONES.gentle).sys;
}

async function callLLM(prompt) {
  if (!llmEnabled) return null;
  try {
    const tone = tonePrompt();
    const res = await fetch(LLM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role:'system', content:`Tu es un coach bienveillant et lucide. ${tone} Réponds UNIQUEMENT avec le texte demandé, sans guillemets ni formatage.` },
          { role:'user', content: prompt }
        ],
        temperature: 0.7, max_tokens: 150
      })
    });
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('LLM error:', e.message); return null; }
}

function computeTrend(timestamps) {
  const now = Date.now();
  const daily = Array(14).fill(0);
  timestamps.forEach(ts => {
    const diff = Math.round((now - new Date(ts).getTime()) / 864e5);
    if (diff >= 0 && diff < 14) daily[daily.length - 1 - diff]++;
  });
  const oldAvg = daily.slice(0,7).reduce((s,v)=>s+v,0)/7;
  const newAvg = daily.slice(-7).reduce((s,v)=>s+v,0)/7;
  const decline = (oldAvg - newAvg) / (oldAvg || 1);
  let direction='stable',severity='none';
  if(decline>0.5&&newAvg<0.3){direction='declining';severity='critical'}
  else if(decline>0.4){direction='declining';severity='moderate'}
  else if(decline>0.2){direction='declining';severity='mild'}
  else if(decline<-0.2){direction='rising';severity='moderate'}
  return {direction,severity,daily};
}

// ═══ CRUD ═══
app.get('/api/goals', async (req, res) => {
  const rows = dbAll("SELECT * FROM goals WHERE status='active' OR status IS NULL ORDER BY created_at DESC");
  const enriched = rows.map(g => {
    const ints = dbAll('SELECT timestamp FROM interactions WHERE goal_id=?', [g.id]);
    const today = new Date().toISOString().slice(0,10);
    const todayResp = dbGet("SELECT COUNT(*) as c FROM daily_responses WHERE goal_id=? AND session_date=?", [g.id, today]);
    return {
      id:g.id, text:g.text, identity:g.identity, createdAt:g.created_at,
      lastInteraction:g.last_interaction, interactionCount:g.interaction_count,
      interactions: ints.map(i => i.timestamp),
      trend: computeTrend(ints.map(i => i.timestamp)),
      todayAnswered: todayResp?.c || 0
    };
  });
  res.json(enriched);
});

// ═══ POST /api/goals ═══
app.post('/api/goals', async (req, res) => {
  const { text, duration } = req.body;
  const dur = parseInt(duration) || 30;
  if (!text || text.trim().length < 3) return res.status(400).json({error:'Texte trop court'});
  
  // Auto-complete any existing active goal
  const existing = dbGet("SELECT * FROM goals WHERE status='active' OR status IS NULL");
  if (existing) {
    dbRun("UPDATE goals SET status='completed', completed_at=? WHERE id=?", [new Date().toISOString(), existing.id]);
  }
  
  const id = randomUUID(), now = new Date().toISOString();
  let identity = `Je suis quelqu'un qui ${text.toLowerCase().replace(/^(.*?)(?: (?:chaque|tous les|par|le|la|les|du|de la|des))?.*$/, '$1')}.`;
  if (llmEnabled) {
    const raw = await callLLM(`Transforme cet objectif comportemental en UNE phrase d'identité au présent, courte, incarnée, à la première personne. L'action concrète et la fréquence doivent apparaître. Objectif: "${text}".`);
    if (raw && raw.length > 10) identity = raw;
  }
  dbRun('INSERT INTO goals (id,text,identity,created_at,interaction_count,duration_days) VALUES (?,?,?,?,0,?)', [id, text.trim(), identity, now, dur]);
  dbSave();
  res.json({id, text:text.trim(), identity, durationDays: dur});
});

// ═══ ORGANIZED ═══
app.get('/api/goals/organized', (req, res) => {
  const goals = dbAll("SELECT * FROM goals WHERE status='active' OR status IS NULL");
  const now = new Date();
  const enriched = goals.map(g => {
    const ints = dbAll('SELECT timestamp FROM interactions WHERE goal_id=?', [g.id]);
    const timestamps = ints.map(r => r.timestamp);
    const tr = computeTrend(timestamps);
    const today = now.toISOString().slice(0,10);
    const todayResp = dbGet("SELECT COUNT(*) as c FROM daily_responses WHERE goal_id=? AND session_date=?", [g.id, today]);
    const daysSinceStart = timestamps.length ? Math.round((now.getTime() - new Date(timestamps[0]).getTime())/864e5) : 0;
    const lastInteraction = timestamps.length > 0 ? timestamps[timestamps.length-1] : null;
    const scores = dbAll('SELECT * FROM daily_scores WHERE goal_id=? ORDER BY session_date ASC', [g.id]);
    const lastScore = scores.length > 0 ? scores[scores.length-1].score : null;
    return {
      id:g.id, text:g.text, identity:g.identity, createdAt:g.created_at,
      lastInteraction, interactionCount: timestamps.length,
      interactions: timestamps, trend: tr, todayAnswered: todayResp?.c || 0,
      lastScore, daysSinceStart
    };
  });
  const urgent = enriched.filter(g => (g.trend.direction==='declining'&&(g.trend.severity==='critical'||g.trend.severity==='moderate'))||g.daysSinceStart<=2);
  const normal = enriched.filter(g => !urgent.includes(g) && g.daysSinceStart>2);
  const stable = enriched.filter(g => !urgent.includes(g) && !normal.includes(g));
  res.json({urgent, normal, stable, all:enriched});
});

// ═══ INTERACT ═══
app.post('/api/goals/:id/interact', async (req, res) => {
  const g = dbGet('SELECT * FROM goals WHERE id=?', [req.params.id]);
  if (!g) return res.status(404).json({error:'Introuvable'});
  const now = new Date().toISOString();
  dbRun('INSERT INTO interactions (id,goal_id,timestamp) VALUES (?,?,?)', [randomUUID(), g.id, now]);
  dbRun('UPDATE goals SET last_interaction=?, interaction_count=interaction_count+1 WHERE id=?', [now, g.id]);
  dbSave();
  let reinforcement = '';
  if (llmEnabled) {
    const raw = await callLLM(`L'utilisateur vient d'agir sur son objectif "${g.text}" (identité: "${g.identity}"). Génère UNE courte phrase de renforcement narratif, comme si tu constatais un fait.`);
    if (raw) reinforcement = raw;
  }
  if (!reinforcement) {
    const msgs = ['Une action de plus. Ça construit.','C\'est exactement le genre de chose que ferait cette personne.','Le chemin se trace pas à pas.','Tu es cohérent.'];
    reinforcement = msgs[Math.floor(Math.random()*msgs.length)];
  }
  res.json({reinforcement});
});

// ═══ INTERVENTIONS ═══
app.get('/api/interventions', (req, res) => {
  const goals = dbAll("SELECT * FROM goals WHERE status='active' OR status IS NULL");
  const interventions = [];
  for (const g of goals) {
    const ints = dbAll('SELECT timestamp FROM interactions WHERE goal_id=? ORDER BY timestamp DESC LIMIT 14', [g.id]);
    const trend = computeTrend(ints.map(i => i.timestamp));
    const lastWeek = trend.daily.slice(-7).reduce((s,v)=>s+v,0);
    if (trend.direction === 'declining' && trend.severity === 'critical' && lastWeek === 0) {
      const daysSinceLast = ints.length ? Math.round((Date.now()-new Date(ints[0].timestamp).getTime())/864e5) : 0;
      if (daysSinceLast >= 5) interventions.push({id:randomUUID(), goalId:g.id, question:`Ça fait ${daysSinceLast} jours sans nouvelle de « ${g.identity} ». Qu'est-ce qui a changé ?`, type:'predictive'});
    }
  }
  res.json(interventions.slice(0,1));
});

app.post('/api/interventions/dismiss', (req, res) => {
  const {goalId} = req.body;
  if (goalId) dbRun('UPDATE goals SET interventions_dismissed_until=? WHERE id=?', [new Date().toISOString(), goalId]);
  dbSave();
  res.json({dismissed:true});
});

app.delete('/api/goals/:id', (req, res) => {
  dbRun('DELETE FROM goals WHERE id=?', [req.params.id]); dbSave(); res.json({deleted:true});
});

// ═══ TONE ═══
app.get('/api/tone', (req, res) => {
  const row = dbGet("SELECT value FROM settings WHERE key='tone'");
  const key = row?.value || 'gentle';
  res.json({tone:key, ...TONES[key]||TONES.gentle, tones:Object.entries(TONES).map(([k,v])=>({key:k,...v}))});
});
app.post('/api/tone', (req, res) => {
  const {tone} = req.body;
  if (!TONES[tone]) return res.status(400).json({error:'Ton invalide'});
  dbRun("INSERT INTO settings (key,value) VALUES ('tone',?)", [tone]);
  dbSave();
  res.json({tone});
});

// ═══ QUESTIONS ═══
app.post('/api/goals/:id/next-question', async (req, res) => {
  const g = dbGet('SELECT * FROM goals WHERE id=?', [req.params.id]);
  if (!g) return res.status(404).json({error:'Introuvable'});
  const {conversation, isEvening, context} = req.body;
  if (llmEnabled) {
    const convText = (conversation||[]).map(c=>`Q: ${c.q||''}\nR: ${c.a||''}`).join('\n');
    const ctx = context || `Objectif: "${g.text}". Identité: "${g.identity}".`;
    const raw = await callLLM(`Check quotidien. ${ctx} ${convText?'Conversation récente:\n'+convText:''} Génère UNE question ouverte et personnalisée pour aujourd'hui. Pose UNE question, directement.`);
    if (raw) return res.json({question: raw});
  }
  const fallbacks = ['Comment te sens-tu par rapport à cet engagement aujourd\'hui ?','Qu\'est-ce qui a changé depuis la dernière fois ?','As-tu rencontré des difficultés ?'];
  res.json({question: fallbacks[Math.floor(Math.random()*fallbacks.length)]});
});

app.post('/api/goals/:id/respond', (req, res) => {
  const {questionId, response} = req.body;
  const today = new Date().toISOString().slice(0,10);
  dbRun('INSERT INTO daily_responses (id,goal_id,question_id,response,session_date,created_at) VALUES (?,?,?,?,?,?)', [randomUUID(), req.params.id, questionId||'checkin', response, today, new Date().toISOString()]);
  dbSave();
  res.json({stored:true});
});

app.get('/api/goals/:id/history', (req, res) => {
  const rows = dbAll('SELECT dr.*, qt.question FROM daily_responses dr LEFT JOIN question_trees qt ON dr.question_id=qt.id WHERE dr.goal_id=? ORDER BY dr.created_at DESC', [req.params.id]);
  const byDate = {};
  rows.forEach(r => { const d = r.session_date || r.created_at?.slice(0,10); if(!byDate[d])byDate[d]=[]; byDate[d].push(r); });
  res.json({responses:rows, byDate, totalResponses:rows.length, totalSessions:Object.keys(byDate).length});
});

// ═══ SCORE ═══
app.post('/api/goals/:id/score', async (req, res) => {
  const g = dbGet('SELECT * FROM goals WHERE id=?', [req.params.id]);
  if (!g) return res.status(404).json({error:'Introuvable'});
  const today = new Date().toISOString().slice(0,10);
  const responses = dbAll("SELECT * FROM daily_responses WHERE goal_id=? AND session_date=?", [g.id, today]);
  let score=50, feedback='Pas assez de données aujourd\'hui.';
  if (responses.length >= 1) {
    score = Math.round(30 + Math.min(1, responses.length/5)*40 + Math.min(20, (g.interaction_count||0)*2));
    if (llmEnabled) {
      const answers = responses.map(r=>r.response).join(' | ');
      const raw = await callLLM(`Sur une échelle de 0 à 100, en toute franchise, note l'engagement envers "${g.text}" (identité: "${g.identity}") basé sur les réponses: "${answers}". Réponds UNIQUEMENT par le nombre.`);
      if (raw) { const p=parseInt(raw.replace(/[^0-9]/g,'')); if(!isNaN(p)&&p>=0&&p<=100) score=p; }
    }
  }
  const prev = dbGet("SELECT * FROM daily_scores WHERE goal_id=? AND session_date<? ORDER BY session_date DESC LIMIT 1", [g.id, today]);
  dbRun("INSERT INTO daily_scores (id,goal_id,score,feedback,session_date,created_at) VALUES (?,?,?,?,?,?)", [randomUUID(), g.id, score, feedback, today, new Date().toISOString()]);
  dbSave();
  res.json({score, feedback, previousScore:prev?.score||null, answered:responses.length});
});

app.get('/api/goals/:id/scores', (req, res) => {
  res.json(dbAll('SELECT * FROM daily_scores WHERE goal_id=? ORDER BY session_date ASC', [req.params.id]));
});

// ═══ OBSTACLES ═══
app.post('/api/goals/:id/obstacle', (req, res) => {
  dbRun('INSERT INTO obstacles (id,goal_id,cause,created_at) VALUES (?,?,?,?)', [randomUUID(), req.params.id, req.body.cause, new Date().toISOString()]);
  dbSave();
  res.json({stored:true});
});
app.get('/api/goals/:id/obstacles', (req, res) => {
  const rows = dbAll('SELECT cause, COUNT(*) as c FROM obstacles WHERE goal_id=? GROUP BY cause ORDER BY c DESC', [req.params.id]);
  const total = rows.reduce((s,r)=>s+parseInt(r.c),0);
  res.json({total, breakdown:rows.map(r=>({cause:r.cause, count:parseInt(r.c), pct:total>0?Math.round(parseInt(r.c)/total*100):0}))});
});
app.post('/api/goals/:id/recalibrate', async (req, res) => {
  const g = dbGet('SELECT * FROM goals WHERE id=?', [req.params.id]);
  let text=g.text, identity=g.identity;
  if (llmEnabled) {
    const raw = await callLLM(`L'objectif "${g.text}" a rencontré l'obstacle: "${req.body.cause||'non spécifié'}". Propose une version recalibrée, plus réaliste. Réponds UNIQUEMENT par une phrase courte.`);
    if (raw && raw.length>5) text = raw;
    const idRaw = await callLLM(`Transforme cet objectif recalibré "${text}" en une phrase d'identité.`);
    if (idRaw && idRaw.length>5) identity = idRaw;
  }
  dbRun('UPDATE goals SET text=?, identity=? WHERE id=?', [text, identity, g.id]);
  dbSave();
  res.json({text, identity});
});

// ═══ LATENT ═══
app.get('/api/consent', (req, res) => {
  const row = dbGet("SELECT value FROM settings WHERE key='latent_consent'");
  res.json({enabled: row?.value==='true'});
});
app.post('/api/consent', (req, res) => {
  dbRun("INSERT INTO settings (key,value) VALUES ('latent_consent',?)", [req.body.enabled?'true':'false']);
  dbSave();
  res.json({enabled:req.body.enabled});
});
app.post('/api/activities', (req, res) => {
  dbRun('INSERT INTO raw_activities (id,text,created_at) VALUES (?,?,?)', [randomUUID(), req.body.text, new Date().toISOString()]);
  dbSave();
  res.json({stored:true});
});
app.get('/api/patterns', (req, res) => {
  const row = dbGet("SELECT value FROM settings WHERE key='latent_consent'");
  if (row?.value !== 'true') return res.json({enabled:false, patterns:[]});
  const activities = dbAll("SELECT text FROM raw_activities ORDER BY created_at DESC LIMIT 200");
  const goals = dbAll("SELECT text FROM goals");
  const goalTexts = new Set(goals.map(g=>g.text.toLowerCase()));
  const rules = [
    {keywords:['sport','salle','muscu','course','vélo','yoga','gym','natation'], label:'sport/exercice'},
    {keywords:['médite','méditation','respire','calme','pleine conscience','zen'], label:'méditation/calme'},
    {keywords:['lis','lecture','livre','lu','page'], label:'lecture'},
    {keywords:['écris','écriture','journal','note'], label:'écriture'},
    {keywords:['code','programme','dev','python','js'], label:'code/programmation'},
  ];
  const counts = {};
  activities.forEach(a => {
    const t = a.text.toLowerCase();
    for (const rule of rules) { if (rule.keywords.some(k => t.includes(k))) counts[rule.label] = (counts[rule.label]||0)+1; }
  });
  const suggestions = Object.entries(counts).filter(([l,c])=>c>=3&&!goalTexts.has(l)).map(([l,c])=>({label:l,count:c,frequency:`${(c/4).toFixed(1)}/semaine`}));
  res.json({enabled:true, patterns:suggestions});
});

// ═══ COMPLETION ═══
app.post('/api/goals/:id/complete', async (req, res) => {
  const g = dbGet('SELECT * FROM goals WHERE id=?', [req.params.id]);
  if (!g) return res.status(404).json({error:'Introuvable'});
  const now = new Date().toISOString();
  dbRun("UPDATE goals SET status='completed', completed_at=? WHERE id=?", [now, g.id]);
  dbSave();
  let summary = 'Objectif transformé en expérience.';
  if (llmEnabled) {
    const scores = dbAll('SELECT * FROM daily_scores WHERE goal_id=? ORDER BY session_date ASC', [g.id]);
    const respCount = dbGet('SELECT COUNT(*) as c FROM daily_responses WHERE goal_id=?', [g.id])?.c || 0;
    const avgScore = scores.length ? Math.round(scores.reduce((s,x)=>s+x.score,0)/scores.length) : 0;
    const raw = await callLLM(`L'utilisateur a complété son objectif "${g.text}" (identité: "${g.identity}"). Scores: ${scores.length} sessions, moyenne ${avgScore}/100. ${respCount} réponses. Génère une phrase de célébration personnalisée.`);
    if (raw) summary = raw;
  }
  res.json({status:'completed', summary, completedAt:now});
});
app.get('/api/goals/experiences', (req, res) => {
  const goals = dbAll("SELECT * FROM goals WHERE status='completed' ORDER BY completed_at DESC");
  const enriched = goals.map(g => {
    const scores = dbAll('SELECT * FROM daily_scores WHERE goal_id=? ORDER BY session_date ASC', [g.id]);
    const respCount = dbGet('SELECT COUNT(*) as c FROM daily_responses WHERE goal_id=?', [g.id])?.c || 0;
    const avgScore = scores.length ? Math.round(scores.reduce((s,x)=>s+x.score,0)/scores.length) : 0;
    return {...g, avgScore, responseCount:respCount, scores};
  });
  res.json(enriched);
});
app.get('/api/goals/:id/completion-check', (req, res) => {
  const g = dbGet("SELECT * FROM goals WHERE id=? AND (status='active' OR status IS NULL)", [req.params.id]);
  if (!g) return res.json({ready:false, reason:'already completed'});
  const scores = dbAll('SELECT * FROM daily_scores WHERE goal_id=? ORDER BY session_date ASC', [g.id]);
  if (scores.length < 3) return res.json({ready:false, reason:'not enough data'});
  const recent = scores.slice(-3);
  const avgRecent = Math.round(recent.reduce((s,x)=>s+x.score,0)/recent.length);
  const allAvg = Math.round(scores.reduce((s,x)=>s+x.score,0)/scores.length);
  const interactions = dbAll('SELECT timestamp FROM interactions WHERE goal_id=? ORDER BY timestamp ASC', [g.id]).map(r=>r.timestamp);
  const trend = computeTrend(interactions);
  const daysSinceStart = interactions.length ? Math.round((Date.now()-new Date(interactions[0]).getTime())/864e5) : 0;
  const ready = avgRecent>=70 && allAvg>=55 && trend.direction!=='declining' && daysSinceStart>=7;
  res.json({ready, avgRecent, allAvg, daysSinceStart, scores, reason:ready?'ready':'still building'});
});

// ═══ REFRAME ═══
app.post('/api/goals/:id/reframe', async (req, res) => {
  const g = dbGet('SELECT * FROM goals WHERE id=?', [req.params.id]);
  let identity = g.identity;
  if (llmEnabled) {
    const raw = await callLLM(`Propose une reformulation alternative pour l'objectif "${g.text}". Une phrase d'identité au présent, courte et incarnée.`);
    if (raw && raw.length>5) identity = raw;
  }
  dbRun('UPDATE goals SET identity=? WHERE id=?', [identity, g.id]);
  dbSave();
  res.json({identity});
});

// ═══ Current single goal ═══
app.get('/api/goal/current', (req, res) => {
  const g = dbGet("SELECT * FROM goals WHERE status='active' OR status IS NULL");
  if (!g) return res.json({ active: false });
  const today = new Date().toISOString().slice(0,10);
  const createdAt = new Date(g.created_at);
  const now = new Date();
  const dayIndex = Math.round((now - createdAt) / 864e5) + 1;
  const totalDays = g.duration_days || 30;
  const daysLeft = Math.max(0, totalDays - dayIndex + 1);
  const isComplete = daysLeft <= 0;
  if (isComplete) {
    dbRun("UPDATE goals SET status='completed', completed_at=? WHERE id=?", [now.toISOString(), g.id]);
    dbSave();
  }
  const todayAnswered = dbGet("SELECT COUNT(*) as c FROM daily_responses WHERE goal_id=? AND session_date=?", [g.id, today])?.c || 0;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayScore = dbGet("SELECT * FROM daily_scores WHERE goal_id=? AND session_date=?", [g.id, yesterday.toISOString().slice(0,10)]);
  const allScores = dbAll('SELECT * FROM daily_scores WHERE goal_id=? ORDER BY session_date ASC', [g.id]);
  res.json({
    active: !isComplete, id: g.id, text: g.text, identity: g.identity,
    createdAt: g.created_at, durationDays: totalDays,
    dayIndex, daysLeft, totalDays,
    todayAnswered, yesterdayScore: yesterdayScore || null,
    allScores, interactions: g.interaction_count || 0
  });
});

app.listen(PORT, () => console.log('miroir → http://localhost:'+PORT));

// Health check pour Railway
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
