const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) { res.status(500).json({ error: 'Admin password not set' }); return; }
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
  // Map<number, { ticket, token, name, subject, createdAt }>
  active: new Map(),
  clients: new Set(),
  version: 0,
};

function bumpVersion() {
  state.version++;
}

// Sanitiza: quita caracteres de control salvo espacios; trim; corta a maxLen.
function sanitizeText(input, maxLen) {
  if (typeof input !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
  return cleaned.slice(0, maxLen);
}

function pendingNumbers() {
  return [...state.active.keys()]
    .filter(t => t > state.currentTurn)
    .sort((a, b) => a - b);
}

function publicPayload() {
  return {
    currentTurn: state.currentTurn,
    lastTicket: state.lastTicket,
    waiting: pendingNumbers().length,
    queue: pendingNumbers(),
    version: state.version,
  };
}

function broadcast() {
  const data = `data: ${JSON.stringify(publicPayload())}\n\n`;
  for (const res of state.clients) {
    try { res.write(data); } catch (_) { }
  }
}

function findByToken(token) {
  if (!token) return null;
  for (const meta of state.active.values()) {
    if (meta.token === token) return meta;
  }
  return null;
}

// SSE – tiempo real (público, sin PII)
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(publicPayload())}\n\n`);

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
  res.json(publicPayload());
});

app.post('/api/ticket', (req, res) => {
  const name = sanitizeText(req.body && req.body.name, 60);
  const subject = sanitizeText(req.body && req.body.subject, 200);
  if (!name) {
    res.status(400).json({ error: 'Nombre obligatorio' });
    return;
  }
  state.lastTicket++;
  const token = crypto.randomBytes(32).toString('hex');
  state.active.set(state.lastTicket, {
    ticket: state.lastTicket,
    token,
    name,
    subject,
    createdAt: Date.now(),
  });
  bumpVersion();
  broadcast();
  res.json({ ticket: state.lastTicket, token, version: state.version });
});

app.delete('/api/ticket/:num', (req, res) => {
  const num = parseInt(req.params.num);
  const token = req.headers['x-ticket-token'];
  const meta = state.active.get(num);
  if (!meta) {
    // Idempotente: ya no existe.
    res.json({ success: true, version: state.version });
    return;
  }
  if (!token || token !== meta.token) {
    res.status(403).json({ error: 'Token inválido' });
    return;
  }
  state.active.delete(num);
  if (num === state.currentTurn) {
    state.currentTurn = 0;
  }
  bumpVersion();
  broadcast();
  res.json({ success: true, version: state.version });
});

app.get('/api/my-ticket', (req, res) => {
  const token = req.headers['x-ticket-token'];
  const meta = findByToken(token);
  res.json({ ticket: meta ? meta.ticket : null, version: state.version });
});

app.post('/api/next', adminAuth, (_req, res) => {
  const next = pendingNumbers();
  if (next.length > 0) {
    state.currentTurn = next[0];
    bumpVersion();
    broadcast();
  }
  res.json({ currentTurn: state.currentTurn, version: state.version });
});

app.post('/api/admin/reject', adminAuth, (_req, res) => {
  if (!state.currentTurn || !state.active.has(state.currentTurn)) {
    res.status(400).json({ error: 'No hay turno actual para rechazar' });
    return;
  }
  const oldTicket = state.currentTurn;
  const meta = state.active.get(oldTicket);
  state.active.delete(oldTicket);

  // ¿Hay otro pendiente distinto al rechazado?
  const otherPending = [...state.active.keys()]
    .filter(t => t > oldTicket)
    .sort((a, b) => a - b);

  // Reasignar el rechazado al final con nuevo número, manteniendo token/name/subject.
  state.lastTicket++;
  const newTicket = state.lastTicket;
  state.active.set(newTicket, {
    ticket: newTicket,
    token: meta.token,
    name: meta.name,
    subject: meta.subject,
    createdAt: Date.now(),
  });

  if (otherPending.length > 0) {
    state.currentTurn = otherPending[0];
  } else {
    // Era el único; queda esperando, no se auto-llama.
    state.currentTurn = 0;
  }

  bumpVersion();
  broadcast();
  res.json({
    oldTicket,
    newTicket,
    currentTurn: state.currentTurn,
    version: state.version,
  });
});

app.get('/api/admin/queue', adminAuth, (_req, res) => {
  const current = state.currentTurn && state.active.has(state.currentTurn)
    ? (() => {
        const m = state.active.get(state.currentTurn);
        return { ticket: m.ticket, name: m.name, subject: m.subject };
      })()
    : null;
  const pending = pendingNumbers().map(n => {
    const m = state.active.get(n);
    return { ticket: m.ticket, name: m.name, subject: m.subject };
  });
  res.json({ current, pending, version: state.version });
});

app.post('/api/reset', adminAuth, (_req, res) => {
  state.currentTurn = 0;
  state.lastTicket = 0;
  state.active.clear();
  bumpVersion();
  broadcast();
  res.json({ success: true, version: state.version });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log('\n🎫  Sistema de Turnos listo!');
  console.log(`   Pantalla pública : http://localhost:${PORT}`);
  console.log(`   Panel de Daniel  : http://localhost:${PORT}/admin.html\n`);
});
