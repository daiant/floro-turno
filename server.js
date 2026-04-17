const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'floropower';

function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const pass = Buffer.from(auth.slice(6), 'base64').toString().split(':')[1];
    if (pass === ADMIN_PASSWORD) return next();
  }
  res.status(401).json({ error: 'No autorizado' });
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/admin/ping', adminAuth, (_req, res) => res.json({ ok: true }));

const state = {
  currentTurn: 0,
  lastTicket: 0,
  active: new Set(), // tickets no cancelados
  clients: new Set(),
};

function pending() {
  return [...state.active].filter(t => t > state.currentTurn).sort((a, b) => a - b);
}

function getPayload() {
  return JSON.stringify({
    currentTurn: state.currentTurn,
    lastTicket: state.lastTicket,
    waiting: pending().length,
    active: [...state.active],
  });
}

function broadcast() {
  const data = `data: ${getPayload()}\n\n`;
  for (const res of state.clients) {
    try { res.write(data); } catch (_) {}
  }
}

// SSE – tiempo real
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${getPayload()}\n\n`);

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(keepAlive); }
  }, 25000);

  state.clients.add(res);
  req.on('close', () => {
    state.clients.delete(res);
    clearInterval(keepAlive);
  });
});

app.get('/api/status', (_req, res) => {
  res.json({
    currentTurn: state.currentTurn,
    lastTicket: state.lastTicket,
    waiting: pending().length,
    active: [...state.active],
  });
});

app.post('/api/ticket', (_req, res) => {
  state.lastTicket++;
  state.active.add(state.lastTicket);
  broadcast();
  res.json({ ticket: state.lastTicket, currentTurn: state.currentTurn });
});

app.delete('/api/ticket/:num', (req, res) => {
  const num = parseInt(req.params.num);
  state.active.delete(num);
  broadcast();
  res.json({ success: true });
});

app.post('/api/next', adminAuth, (_req, res) => {
  const next = pending();
  if (next.length > 0) {
    state.currentTurn = next[0];
    broadcast();
  }
  res.json({ currentTurn: state.currentTurn });
});

app.post('/api/reset', adminAuth, (_req, res) => {
  state.currentTurn = 0;
  state.lastTicket = 0;
  state.active.clear();
  broadcast();
  res.json({ success: true });
});

const PORT = 4300;
app.listen(PORT, () => {
  console.log('\n🎫  Sistema de Turnos listo!');
  console.log(`   Pantalla pública : http://localhost:${PORT}`);
  console.log(`   Panel de Daniel  : http://localhost:${PORT}/admin.html\n`);
});
