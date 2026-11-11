/* ============================================================
   MCHART — Express API server
   Backend for the MCHART messaging app. Serves the frontend
   and a JSON REST API backed by SQLite (node:sqlite).
   ============================================================ */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db, DB_PATH, DB_NAME, DEMO_USER_IDS } = require('./db');
const { hashPassword, verifyPassword, newToken } = require('./auth');
const { sendLoginCode, mailerInfo } = require('./mailer');

const { webcrypto } = crypto;
const subtle = webcrypto.subtle;
const textEncoder = new TextEncoder();

const app = express();
const PORT = process.env.PORT || 4000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DEMO_IDS = new Set(DEMO_USER_IDS);
const REPLIES = [
  'Sounds good!',
  'Haha, totally agree.',
  'Got it, thanks for letting me know.',
  "I'll check it out now.",
  "Let's catch up later today.",
  'Nice, that works for me.',
  'Perfect, see you then.',
  'On it! Give me a few minutes.'
];
const COLORS = ['#8b5cf6', '#a855f7', '#6366f1', '#db2777', '#0d9488', '#f59e0b', '#e11d48', '#2563eb'];

app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '25mb' }));

app.use('/css', express.static(path.join(FRONTEND_DIR, 'css')));
app.use('/js', express.static(path.join(FRONTEND_DIR, 'js')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', function (req, res) {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

/* ---------------- helpers ---------------- */

function now() { return new Date().toISOString(); }
function uid() { return crypto.randomUUID(); }
function pickColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

function safeParse(value) {
  try { return JSON.parse(value); } catch (e) { return null; }
}

function generateLoginCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/* ---------------- media uploads (files on disk) ---------------- */

const UPLOAD_MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'video/webm': 'webm', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'audio/webm': 'weba', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav'
};
const UPLOAD_SIZE_LIMITS = { image: 5, video: 15, audio: 8 };

/* Saves a base64 data-URL media file into the uploads directory.
   Returns { ok: true, file, url, mime, bytes } or { ok: false, error }. */
function saveUploadFile(dataUrl, expectedKind) {
  if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) {
    return { ok: false, error: 'Unsupported media format.' };
  }
  const match = /^data:([^;,]+)(;base64)?([\s\S]*)$/.exec(dataUrl);
  if (!match || match[2] !== ';base64') {
    return { ok: false, error: 'Media must be sent as base64.' };
  }
  const mime = match[1].toLowerCase();
  const kind = mime.split('/')[0];
  if (['image', 'video', 'audio'].indexOf(kind) === -1) {
    return { ok: false, error: 'Only image, video and audio files are allowed.' };
  }
  if (expectedKind && kind !== expectedKind) {
    return { ok: false, error: 'Unexpected media kind (expected ' + expectedKind + ').' };
  }
  if (match[3].length > 21 * 1024 * 1024) {
    return { ok: false, error: 'Media is too large (max 15 MB).' };
  }

  let buf;
  try {
    buf = Buffer.from(match[3], 'base64');
  } catch (e) {
    return { ok: false, error: 'Corrupted media data.' };
  }
  if (!buf.length) return { ok: false, error: 'Media file is empty.' };
  if (buf.length > UPLOAD_SIZE_LIMITS[kind] * 1024 * 1024) {
    return { ok: false, error: 'Media is too large (max ' + UPLOAD_SIZE_LIMITS[kind] + ' MB).' };
  }

  const ext = UPLOAD_MIME_EXT[mime] || (kind === 'image' ? 'bin' : kind === 'video' ? 'bin' : 'bin');
  const file = uid() + '.' + ext;
  try {
    fs.writeFileSync(path.join(UPLOADS_DIR, file), buf);
  } catch (e) {
    return { ok: false, error: 'Could not save the media file.' };
  }
  return { ok: true, file: file, url: '/uploads/' + file, mime: mime, bytes: buf.length };
}

/* In-memory guard against spamming the "send code" endpoint. */
const CODE_COOLDOWN_MS = 30 * 1000;
const lastCodeRequest = new Map();

function codeRequestAllowed(email) {
  const last = lastCodeRequest.get(email) || 0;
  return Date.now() - last >= CODE_COOLDOWN_MS;
}

/* ---------------- settings & activity ---------------- */

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function allSettings() {
  const out = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(function (r) { out[r.key] = r.value; });
  return out;
}

function logActivity(actorId, action, detail) {
  db.prepare('INSERT INTO activity_log (id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('a-' + uid(), actorId || null, String(action), String(detail || ''), now());
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}
function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function pubUser(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    email: u.email,
    bio: u.bio || '',
    color: u.color || '#8b5cf6',
    avatar: u.avatar || null,
    cover: u.cover || null,
    online: !!u.online,
    role: u.role || 'user',
    status: u.status || 'active',
    publicKey: u.public_key || null
  };
}

function pubContact(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    bio: u.bio || '',
    color: u.color || '#8b5cf6',
    avatar: u.avatar || null,
    cover: u.cover || null,
    online: !!u.online,
    role: u.role || 'user',
    publicKey: u.public_key || null
  };
}

function addFriendship(userId, friendId) {
  db.prepare('INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)')
    .run(userId, friendId, now());
}

function addNotification(userId, type, text, actorId) {
  if (!userId) return;
  db.prepare('INSERT INTO notifications (id, user_id, type, text, actor_id, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run('n-' + uid(), userId, type, text, actorId || null, now());
}

function buildChats(userId) {
  const others = db.prepare(`
    SELECT DISTINCT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS other_id
    FROM messages
    WHERE sender_id = ? OR receiver_id = ?
  `).all(userId, userId, userId);

  const messageStmt = db.prepare(`
    SELECT * FROM messages
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    ORDER BY created_at ASC
  `);

  return others.map(function (row) {
    const otherId = row.other_id;
    const messages = messageStmt.all(userId, otherId, otherId, userId).map(function (m) {
      return {
        id: m.id,
        from: m.sender_id === userId ? 'me' : otherId,
        text: m.text || '',
        time: m.created_at,
        read: !!m.read,
        encrypted: !!m.encrypted,
        nonce: m.nonce || null,
        attachment: m.attachment ? safeParse(m.attachment) : null
      };
    });
    return { userId: otherId, messages: messages };
  });
}

function buildStories(userId) {
  const stamp = now();
  db.prepare('DELETE FROM stories WHERE expires_at <= ?').run(stamp);

  const rows = db.prepare(`
    SELECT s.*, u.name AS author_name, u.username AS author_username,
           u.color AS author_color, u.avatar AS author_avatar, u.online AS author_online,
           (SELECT COUNT(*) FROM story_views v WHERE v.story_id = s.id) AS view_count,
           (SELECT COUNT(*) FROM story_views v WHERE v.story_id = s.id AND v.user_id = ?) AS viewed
    FROM stories s
    JOIN users u ON u.id = s.user_id
    WHERE s.expires_at > ?
    ORDER BY s.created_at ASC
  `).all(userId, stamp);

  return rows.map(function (s) {
    return {
      id: s.id,
      userId: s.user_id,
      author: {
        id: s.user_id,
        name: s.author_name,
        username: s.author_username,
        color: s.author_color || '#8b5cf6',
        avatar: s.author_avatar || null,
        online: !!s.author_online
      },
      text: s.text || '',
      mediaType: s.media_type || null,
      mediaData: s.media_data || null,
      background: s.background || '#6366f1',
      time: s.created_at,
      expiresAt: s.expires_at,
      views: s.view_count,
      viewed: !!s.viewed,
      mine: s.user_id === userId
    };
  });
}

function buildBootstrap(userId) {
  const meRow = getUserById(userId);
  const contacts = db.prepare('SELECT * FROM users WHERE id != ? ORDER BY name COLLATE NOCASE')
    .all(userId).map(pubContact);
  const friends = db.prepare('SELECT friend_id FROM friendships WHERE user_id = ?')
    .all(userId).map(function (r) { return r.friend_id; });
  const requests = db.prepare('SELECT id, from_user, created_at FROM friend_requests WHERE to_user = ? ORDER BY created_at DESC')
    .all(userId).map(function (r) { return { id: r.id, userId: r.from_user, time: r.created_at }; });
  const sentRequests = db.prepare('SELECT to_user FROM friend_requests WHERE from_user = ?')
    .all(userId).map(function (r) { return r.to_user; });
  const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId).map(function (n) {
      return {
        id: n.id,
        type: n.type,
        text: n.text,
        userId: n.actor_id,
        read: !!n.read,
        time: n.created_at
      };
    });

  return {
    me: pubUser(meRow),
    contacts: contacts,
    friends: friends,
    requests: requests,
    sentRequests: sentRequests,
    chats: buildChats(userId),
    stories: buildStories(userId),
    notifications: notifications
  };
}

function createSession(userId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, userId, now());
  return token;
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const queryToken = req.query && typeof req.query.token === 'string' ? req.query.token : null;
  const token = header.indexOf('Bearer ') === 0 ? header.slice(7) : queryToken;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session.' });

  const user = getUserById(session.user_id);
  if (!user) return res.status(401).json({ error: 'Account not found.' });
  if ((user.status || 'active') === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended by the administrator.' });
  }

  req.user = user;
  req.token = token;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

/* ---------------- realtime (SSE) ---------------- */

const eventClients = new Map();

function sendEvent(userId, event, data) {
  const clients = eventClients.get(userId);
  if (!clients || !clients.size) return;
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  clients.forEach(function (res) {
    try { res.write(payload); } catch (e) { clients.delete(res); }
  });
}

function pushBootstrap(userId) {
  if (!userId || !eventClients.has(userId)) return;
  sendEvent(userId, 'bootstrap', buildBootstrap(userId));
}

function pushStoriesToAll() {
  eventClients.forEach(function (clients, userId) {
    sendEvent(userId, 'stories', buildStories(userId));
  });
}

function friendIdsOf(userId) {
  return db.prepare('SELECT friend_id FROM friendships WHERE user_id = ?').all(userId)
    .map(function (r) { return r.friend_id; });
}

function broadcastPresence(userId, online) {
  friendIdsOf(userId).forEach(function (friendId) {
    sendEvent(friendId, 'presence', { userId: userId, online: !!online });
  });
}

function setOnline(userId, online) {
  db.prepare('UPDATE users SET online = ? WHERE id = ?').run(online ? 1 : 0, userId);
  broadcastPresence(userId, online);
}

function acceptRequestRow(requestRow, meId) {
  const requester = getUserById(requestRow.from_user);
  const me = getUserById(meId);

  db.prepare('DELETE FROM friend_requests WHERE id = ?').run(requestRow.id);
  addFriendship(meId, requestRow.from_user);
  addFriendship(requestRow.from_user, meId);

  if (requester && me) {
    addNotification(meId, 'friend', requester.name + ' is now your friend.', requester.id);
    addNotification(requestRow.from_user, 'friend', me.name + ' accepted your friend request.', meId);
  }

  pushBootstrap(meId);
  pushBootstrap(requestRow.from_user);
}

const replyTimers = new Map();

function bufToBase64(buf) {
  return Buffer.from(buf).toString('base64');
}

/* Demo bots hold their own keys server-side so their automated replies can
   still be encrypted for the human user. This is a demo-only convenience;
   real users' private keys never leave the browser. */
async function encryptDemoReply(demoUserId, recipientId, payload) {
  const demo = db.prepare('SELECT public_key FROM users WHERE id = ?').get(demoUserId);
  const recipient = db.prepare('SELECT public_key FROM users WHERE id = ?').get(recipientId);
  const keyRow = db.prepare('SELECT private_key FROM demo_keys WHERE user_id = ?').get(demoUserId);
  if (!demo || !demo.public_key || !recipient || !recipient.public_key || !keyRow) return null;

  try {
    const privateKey = await subtle.importKey(
      'jwk', JSON.parse(keyRow.private_key),
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']
    );
    const publicKey = await subtle.importKey(
      'jwk', JSON.parse(recipient.public_key),
      { name: 'ECDH', namedCurve: 'P-256' }, false, []
    );
    const aesKey = await subtle.deriveKey(
      { name: 'ECDH', public: publicKey }, privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const cipher = await subtle.encrypt(
      { name: 'AES-GCM', iv: iv }, aesKey, textEncoder.encode(JSON.stringify(payload))
    );
    return { text: bufToBase64(cipher), nonce: bufToBase64(iv) };
  } catch (e) {
    return null;
  }
}

function scheduleDemoReply(senderId, otherId) {
  if (!DEMO_IDS.has(otherId)) return;
  if (getSetting('demo_replies', '1') !== '1') return;
  const key = senderId + '|' + otherId;
  clearTimeout(replyTimers.get(key));
  replyTimers.set(key, setTimeout(async function () {
    const sender = getUserById(senderId);
    const other = getUserById(otherId);
    if (!sender || !other) return;

    const last = db.prepare(`
      SELECT * FROM messages
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(senderId, otherId, otherId, senderId);

    if (!last || last.sender_id !== senderId) return;

    const text = REPLIES[Math.floor(Math.random() * REPLIES.length)];
    let storedText = text;
    let nonce = null;
    let encrypted = 0;

    if (last.encrypted) {
      const enc = await encryptDemoReply(otherId, senderId, { text: text, attachment: null });
      if (enc) {
        storedText = enc.text;
        nonce = enc.nonce;
        encrypted = 1;
      }
    }

    db.prepare(`
      INSERT INTO messages (id, sender_id, receiver_id, text, attachment, nonce, encrypted, read, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?)
    `).run('m-' + uid(), otherId, senderId, storedText, nonce, encrypted, now());
    db.prepare('UPDATE messages SET read = 1 WHERE sender_id = ? AND receiver_id = ?')
      .run(senderId, otherId);
    addNotification(senderId, 'message',
      encrypted ? other.name + ' replied to your message.' : other.name + ': ' + text, otherId);
    pushBootstrap(senderId);
    pushBootstrap(otherId);
  }, 1500 + Math.random() * 1000));
}

/* ---------------- auth routes ---------------- */

app.post('/api/auth/register', function (req, res) {
  if (getSetting('allow_registration', '1') !== '1') {
    return res.status(403).json({ error: 'Registration is currently disabled by the administrator.' });
  }
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const username = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!name || !username || !email || !password) {
    return res.status(400).json({ error: 'Please fill in all fields.' });
  }
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters using letters, numbers, dot, dash or underscore.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (getUserByEmail(email)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }
  if (getUserByUsername(username)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const id = 'u-' + uid();
  db.prepare(`
    INSERT INTO users (id, name, username, email, password_hash, bio, color, avatar, online, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, NULL, 1, ?)
  `).run(id, name, username, email, hashPassword(password), pickColor(), now());

  logActivity(id, 'register', 'New account @' + username + ' (' + email + ')');
  const token = createSession(id);
  res.status(201).json({ token: token, bootstrap: buildBootstrap(id) });
});

app.post('/api/auth/login', function (req, res) {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const user = getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if ((user.status || 'active') === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended by the administrator.' });
  }

  db.prepare('UPDATE users SET online = 1 WHERE id = ?').run(user.id);
  const token = createSession(user.id);
  res.json({ token: token, bootstrap: buildBootstrap(user.id) });
});

/* -------- passwordless login: request a 6-digit code by email -------- */

app.post('/api/auth/request-code', async function (req, res) {
  if (getSetting('email_login_enabled', '1') !== '1') {
    return res.status(403).json({ error: 'Email code login is currently disabled by the administrator.' });
  }

  const email = normalizeEmail((req.body || {}).email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const user = getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ error: 'No account is registered with this email address.' });
  }
  if ((user.status || 'active') === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended by the administrator.' });
  }
  if (!codeRequestAllowed(email)) {
    return res.status(429).json({ error: 'Please wait about 30 seconds before requesting another code.' });
  }
  lastCodeRequest.set(email, Date.now());

  const ttlMinutes = Math.max(1, Math.min(Number(getSetting('login_code_ttl', '10')) || 10, 60));
  const code = generateLoginCode();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();

  /* invalidate any previous unused codes for this email */
  db.prepare('UPDATE login_codes SET used = 1 WHERE email = ? AND used = 0').run(email);
  db.prepare(`
    INSERT INTO login_codes (id, email, code_hash, purpose, attempts, used, expires_at, created_at)
    VALUES (?, ?, ?, 'login', 0, 0, ?, ?)
  `).run('lc-' + uid(), email, hashPassword(code), expiresAt, now());

  const delivery = await sendLoginCode(email, code, ttlMinutes);
  logActivity(user.id, 'login.code.request', 'Requested a login code via ' + delivery.transport);

  const showDevCode = getSetting('dev_show_login_code', '1') === '1' && !delivery.delivered;
  const payload = {
    ok: true,
    email: email,
    expiresAt: expiresAt,
    ttlMinutes: ttlMinutes,
    delivered: delivery.delivered,
    transport: delivery.transport
  };
  if (showDevCode) {
    /* Only exposed when no real email transport is configured. */
    payload.devCode = code;
    payload.message = 'Email is not configured on this server, so the code is shown here for testing.';
  } else {
    payload.message = 'A verification code has been sent to ' + email + '.';
  }
  res.json(payload);
});

app.post('/api/auth/verify-code', function (req, res) {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  const code = String(body.code || '').trim();

  if (!email || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
  }

  const user = getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ error: 'No account is registered with this email address.' });
  }
  if ((user.status || 'active') === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended by the administrator.' });
  }

  const row = db.prepare(`
    SELECT * FROM login_codes
    WHERE email = ? AND used = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(email);

  if (!row) {
    return res.status(400).json({ error: 'Request a new verification code first.' });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);
    return res.status(400).json({ error: 'That code has expired. Please request a new one.' });
  }
  if (row.attempts >= 5) {
    db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);
    return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new code.' });
  }

  if (!verifyPassword(code, row.code_hash)) {
    db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.status(401).json({ error: 'That verification code is not correct.' });
  }

  db.prepare('UPDATE login_codes SET used = 1 WHERE id = ?').run(row.id);
  db.prepare('UPDATE users SET online = 1 WHERE id = ?').run(user.id);
  const token = createSession(user.id);
  logActivity(user.id, 'login.code.success', 'Signed in with an email verification code');
  res.json({ token: token, bootstrap: buildBootstrap(user.id) });
});

/* -------- mailer status (admin only) -------- */

app.get('/api/admin/mailer', requireAuth, requireAdmin, function (req, res) {
  res.json({ mailer: mailerInfo(), smtpHost: process.env.SMTP_HOST || null });
});

app.post('/api/auth/logout', requireAuth, function (req, res) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  const remaining = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(req.user.id).c;
  if (remaining === 0) {
    setOnline(req.user.id, false);
  }
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, function (req, res) {
  res.json({ user: pubUser(req.user) });
});

/* ---------------- bootstrap ---------------- */

app.get('/api/bootstrap', requireAuth, function (req, res) {
  res.json(buildBootstrap(req.user.id));
});

app.get('/api/health', function (req, res) {
  res.json({ ok: true, db: DB_PATH });
});

app.get('/api/events', requireAuth, function (req, res) {
  const userId = req.user.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  if (!eventClients.has(userId)) eventClients.set(userId, new Set());
  const clients = eventClients.get(userId);
  clients.add(res);
  setOnline(userId, true);

  res.write('event: ready\ndata: {}\n\n');

  const heartbeat = setInterval(function () {
    try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
  }, 25000);

  req.on('close', function () {
    clearInterval(heartbeat);
    clients.delete(res);
    if (!clients.size) {
      eventClients.delete(userId);
      setOnline(userId, false);
    }
  });
});

/* ---------------- profile ---------------- */

app.patch('/api/users/me', requireAuth, function (req, res) {
  const body = req.body || {};
  const userId = req.user.id;

  const name = body.name !== undefined ? String(body.name).trim() : req.user.name;
  const username = body.username !== undefined
    ? String(body.username).trim().replace(/^@/, '').toLowerCase()
    : req.user.username;
  const email = body.email !== undefined ? String(body.email).trim().toLowerCase() : req.user.email;
  const bio = body.bio !== undefined ? String(body.bio).trim().slice(0, 300) : (req.user.bio || '');

  if (!name || !username || !email) {
    return res.status(400).json({ error: 'Name, username and email are required.' });
  }
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters using letters, numbers, dot, dash or underscore.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const otherEmail = getUserByEmail(email);
  if (otherEmail && otherEmail.id !== userId) {
    return res.status(409).json({ error: 'That email is already in use.' });
  }
  const otherUsername = getUserByUsername(username);
  if (otherUsername && otherUsername.id !== userId) {
    return res.status(409).json({ error: 'That username is already in use.' });
  }

  let avatar = req.user.avatar;
  if (body.avatar !== undefined) {
    if (body.avatar === null || body.avatar === '') {
      avatar = null;
    } else if (typeof body.avatar === 'string' &&
               body.avatar.indexOf('data:image/') === 0 &&
               body.avatar.length <= 3.5 * 1024 * 1024) {
      avatar = body.avatar;
    } else {
      return res.status(400).json({ error: 'Profile photo must be an image under 2MB.' });
    }
  }

  let cover = req.user.cover || null;
  if (body.cover !== undefined) {
    if (body.cover === null || body.cover === '') {
      cover = null;
    } else if (typeof body.cover === 'string' &&
               body.cover.indexOf('data:image/') === 0 &&
               body.cover.length <= 3.5 * 1024 * 1024) {
      cover = body.cover;
    } else {
      return res.status(400).json({ error: 'Cover photo must be an image under 2MB.' });
    }
  }

  let publicKey = req.user.public_key || null;
  if (body.publicKey !== undefined) {
    if (body.publicKey === null || body.publicKey === '') {
      publicKey = null;
    } else if (typeof body.publicKey === 'string' && body.publicKey.length <= 4000) {
      publicKey = body.publicKey;
    } else {
      return res.status(400).json({ error: 'Invalid public key.' });
    }
  }

  db.prepare('UPDATE users SET name = ?, username = ?, email = ?, bio = ?, avatar = ?, cover = ?, public_key = ? WHERE id = ?')
    .run(name, username, email, bio, avatar, cover, publicKey, userId);

  pushBootstrap(userId);
  friendIdsOf(userId).forEach(function (friendId) { pushBootstrap(friendId); });
  res.json(buildBootstrap(userId));
});

/* ---------------- friends ---------------- */

app.post('/api/friends/requests/:userId', requireAuth, function (req, res) {
  const meId = req.user.id;
  const targetId = req.params.userId;

  if (targetId === meId) return res.status(400).json({ error: 'You cannot add yourself.' });
  const target = getUserById(targetId);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const already = db.prepare('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?').get(meId, targetId);
  if (already) return res.status(409).json({ error: 'You are already friends.' });

  const reverse = db.prepare('SELECT * FROM friend_requests WHERE from_user = ? AND to_user = ?').get(targetId, meId);
  if (reverse) {
    acceptRequestRow(reverse, meId);
    return res.json(buildBootstrap(meId));
  }

  const existing = db.prepare('SELECT * FROM friend_requests WHERE from_user = ? AND to_user = ?').get(meId, targetId);
  if (!existing) {
    db.prepare('INSERT INTO friend_requests (id, from_user, to_user, created_at) VALUES (?, ?, ?, ?)')
      .run('r-' + uid(), meId, targetId, now());
    addNotification(targetId, 'request', req.user.name + ' sent you a friend request.', meId);
    pushBootstrap(targetId);
  }

  pushBootstrap(meId);
  res.json(buildBootstrap(meId));
});

app.post('/api/friends/requests/:id/accept', requireAuth, function (req, res) {
  const meId = req.user.id;
  const row = db.prepare('SELECT * FROM friend_requests WHERE id = ? AND to_user = ?')
    .get(req.params.id, meId);
  if (!row) return res.status(404).json({ error: 'Friend request not found.' });

  acceptRequestRow(row, meId);
  res.json(buildBootstrap(meId));
});

app.post('/api/friends/requests/:id/decline', requireAuth, function (req, res) {
  const meId = req.user.id;
  const row = db.prepare('SELECT * FROM friend_requests WHERE id = ? AND to_user = ?')
    .get(req.params.id, meId);
  db.prepare('DELETE FROM friend_requests WHERE id = ? AND to_user = ?')
    .run(req.params.id, meId);
  if (row) pushBootstrap(row.from_user);
  pushBootstrap(meId);
  res.json(buildBootstrap(meId));
});

app.delete('/api/friends/:userId', requireAuth, function (req, res) {
  const meId = req.user.id;
  const otherId = req.params.userId;
  db.prepare('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)')
    .run(meId, otherId, otherId, meId);
  db.prepare('DELETE FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)')
    .run(meId, otherId, otherId, meId);
  pushBootstrap(meId);
  pushBootstrap(otherId);
  res.json(buildBootstrap(meId));
});

/* ---------------- messages ---------------- */

app.post('/api/chats/:userId/messages', requireAuth, function (req, res) {
  const meId = req.user.id;
  const otherId = req.params.userId;
  if (otherId === meId) return res.status(400).json({ error: 'Invalid recipient.' });

  const other = getUserById(otherId);
  if (!other) return res.status(404).json({ error: 'User not found.' });

  const body = req.body || {};

  /* -------- end-to-end encrypted message -------- */
  if (body.encrypted) {
    const ciphertext = String(body.text || '');
    const nonce = String(body.nonce || '');
    if (!ciphertext || !nonce) {
      return res.status(400).json({ error: 'Encrypted message is missing data.' });
    }
    if (ciphertext.length > 10 * 1024 * 1024 || nonce.length > 200) {
      return res.status(400).json({ error: 'Encrypted message is too large.' });
    }

    db.prepare(`
      INSERT INTO messages (id, sender_id, receiver_id, text, attachment, nonce, encrypted, read, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, 1, 0, ?)
    `).run('m-' + uid(), meId, otherId, ciphertext, nonce, now());

    addNotification(otherId, 'message', req.user.name + ' sent you an encrypted message.', meId);
    scheduleDemoReply(meId, otherId);

    pushBootstrap(meId);
    pushBootstrap(otherId);
    return res.status(201).json(buildBootstrap(meId));
  }

  /* -------- plaintext message (legacy / no keys) -------- */
  const text = String(body.text || '').trim().slice(0, 4000);

  let attachment = null;
  if (body.attachment) {
    const a = body.attachment;
    const name = String(a.name || 'file').slice(0, 200);
    const size = Number(a.size) || 0;
    const type = String(a.type || '').slice(0, 100);
    let url = null;
    if (typeof a.url === 'string' && a.url.indexOf('/uploads/') === 0) {
      url = a.url; /* already uploaded through /api/uploads */
    } else if (a.dataUrl) {
      if (typeof a.dataUrl !== 'string' || a.dataUrl.length > 21 * 1024 * 1024) {
        return res.status(400).json({ error: 'Attachment is too large (max 15 MB).' });
      }
      const saved = saveUploadFile(a.dataUrl, null);
      if (!saved.ok) return res.status(400).json({ error: saved.error });
      url = saved.url;
    }
    attachment = JSON.stringify({ name: name, size: size, type: type, url: url });
  }

  if (!text && !attachment) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  db.prepare(`
    INSERT INTO messages (id, sender_id, receiver_id, text, attachment, nonce, encrypted, read, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, 0, 0, ?)
  `).run('m-' + uid(), meId, otherId, text, attachment, now());

  addNotification(otherId, 'message', req.user.name + ' sent you a message.', meId);
  scheduleDemoReply(meId, otherId);

  pushBootstrap(meId);
  pushBootstrap(otherId);
  res.status(201).json(buildBootstrap(meId));
});

app.post('/api/chats/:userId/typing', requireAuth, function (req, res) {
  const meId = req.user.id;
  const otherId = req.params.userId;
  const typing = !!(req.body && req.body.typing);
  sendEvent(otherId, 'typing', { userId: meId, typing: typing });
  res.json({ ok: true });
});

app.post('/api/chats/:userId/read', requireAuth, function (req, res) {
  const meId = req.user.id;
  const otherId = req.params.userId;

  db.prepare('UPDATE messages SET read = 1 WHERE sender_id = ? AND receiver_id = ? AND read = 0')
    .run(otherId, meId);
  db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ? AND type = 'message' AND actor_id = ?")
    .run(meId, otherId);

  pushBootstrap(meId);
  pushBootstrap(otherId);
  res.json(buildBootstrap(meId));
});

app.delete('/api/chats/:userId/messages/:messageId', requireAuth, function (req, res) {
  const meId = req.user.id;
  const otherId = req.params.userId;
  const result = db.prepare('DELETE FROM messages WHERE id = ? AND sender_id = ? AND receiver_id = ?')
    .run(req.params.messageId, meId, otherId);
  if (!result.changes) return res.status(404).json({ error: 'Message not found.' });

  pushBootstrap(meId);
  pushBootstrap(otherId);
  res.json(buildBootstrap(meId));
});

app.delete('/api/chats/:userId', requireAuth, function (req, res) {
  const meId = req.user.id;
  const otherId = req.params.userId;
  db.prepare(`
    DELETE FROM messages
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
  `).run(meId, otherId, otherId, meId);
  db.prepare("DELETE FROM notifications WHERE user_id = ? AND type = 'message' AND actor_id = ?")
    .run(meId, otherId);

  pushBootstrap(meId);
  pushBootstrap(otherId);
  res.json(buildBootstrap(meId));
});

/* ---------------- media uploads ---------------- */

app.post('/api/uploads', requireAuth, function (req, res) {
  const body = req.body || {};
  if (!body.dataUrl) return res.status(400).json({ error: 'Nothing to upload.' });
  if (typeof body.dataUrl === 'string' && body.dataUrl.length > 21 * 1024 * 1024) {
    return res.status(400).json({ error: 'Media is too large (max 15 MB).' });
  }
  const saved = saveUploadFile(body.dataUrl, body.kind || null);
  if (!saved.ok) return res.status(400).json({ error: saved.error });
  logActivity(req.user.id, 'media.upload', 'Uploaded ' + saved.mime + ' (' + saved.bytes + ' bytes)');
  res.status(201).json({ url: saved.url, mime: saved.mime, size: saved.bytes });
});

/* ---------------- audio / video calls (WebRTC signalling) ---------------- */

function getCall(id) {
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
}

function callIsParticipant(call, userId) {
  return !!call && (call.caller_id === userId || call.receiver_id === userId);
}

function pubCall(c) {
  return {
    id: c.id,
    callerId: c.caller_id,
    receiverId: c.receiver_id,
    kind: c.kind,
    status: c.status,
    createdAt: c.created_at,
    answeredAt: c.answered_at,
    endedAt: c.ended_at
  };
}

function endCallRow(call, status) {
  db.prepare('UPDATE calls SET status = ?, ended_at = ? WHERE id = ?').run(status, now(), call.id);
  db.prepare('DELETE FROM call_signals WHERE call_id = ?').run(call.id);
}

app.post('/api/calls', requireAuth, function (req, res) {
  if (getSetting('calls_enabled', '1') !== '1') {
    return res.status(403).json({ error: 'Calls are currently disabled by the administrator.' });
  }
  const meId = req.user.id;
  const body = req.body || {};
  const toId = String(body.toUserId || '');
  const kind = body.kind === 'video' ? 'video' : 'audio';

  if (!toId || toId === meId) return res.status(400).json({ error: 'Invalid call recipient.' });
  const target = getUserById(toId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if ((target.status || 'active') === 'suspended') {
    return res.status(403).json({ error: 'This user is not available right now.' });
  }

  const id = 'c-' + uid();
  db.prepare(`
    INSERT INTO calls (id, caller_id, receiver_id, kind, status, created_at)
    VALUES (?, ?, ?, ?, 'ringing', ?)
  `).run(id, meId, toId, kind, now());

  const call = getCall(id);
  sendEvent(toId, 'call-incoming', {
    call: pubCall(call),
    from: pubContact(req.user)
  });
  logActivity(meId, 'call.start', 'Started a ' + kind + ' call to @' + target.username);
  res.status(201).json({ call: pubCall(call) });
});

app.get('/api/calls/:id', requireAuth, function (req, res) {
  const call = getCall(req.params.id);
  if (!callIsParticipant(call, req.user.id)) return res.status(404).json({ error: 'Call not found.' });
  res.json({ call: pubCall(call) });
});

app.post('/api/calls/:id/accept', requireAuth, function (req, res) {
  const call = getCall(req.params.id);
  if (!callIsParticipant(call, req.user.id)) return res.status(404).json({ error: 'Call not found.' });
  if (call.receiver_id !== req.user.id) return res.status(403).json({ error: 'Only the receiver can accept this call.' });
  if (call.status !== 'ringing') return res.status(409).json({ error: 'This call can no longer be accepted.' });

  db.prepare("UPDATE calls SET status = 'active', answered_at = ? WHERE id = ?").run(now(), call.id);
  const updated = getCall(call.id);
  sendEvent(call.caller_id, 'call-accepted', { call: pubCall(updated), by: pubContact(req.user) });
  res.json({ call: pubCall(updated) });
});

app.post('/api/calls/:id/decline', requireAuth, function (req, res) {
  const call = getCall(req.params.id);
  if (!callIsParticipant(call, req.user.id)) return res.status(404).json({ error: 'Call not found.' });
  if (call.status !== 'ringing') return res.status(409).json({ error: 'This call is no longer ringing.' });

  endCallRow(call, 'declined');
  sendEvent(call.caller_id === req.user.id ? call.receiver_id : call.caller_id, 'call-ended', {
    callId: call.id,
    status: 'declined',
    reason: 'declined'
  });
  res.json({ ok: true });
});

app.post('/api/calls/:id/end', requireAuth, function (req, res) {
  const call = getCall(req.params.id);
  if (!callIsParticipant(call, req.user.id)) return res.status(404).json({ error: 'Call not found.' });
  if (call.status === 'ended' || call.status === 'declined') return res.json({ ok: true });

  endCallRow(call, 'ended');
  const other = call.caller_id === req.user.id ? call.receiver_id : call.caller_id;
  sendEvent(other, 'call-ended', { callId: call.id, status: 'ended', reason: 'hangup' });
  res.json({ ok: true });
});

app.post('/api/calls/:id/signal', requireAuth, function (req, res) {
  const call = getCall(req.params.id);
  if (!callIsParticipant(call, req.user.id)) return res.status(404).json({ error: 'Call not found.' });
  if (call.status === 'ended' || call.status === 'declined') {
    return res.status(409).json({ error: 'This call has already ended.' });
  }

  const body = req.body || {};
  const kind = String(body.kind || '');
  if (['offer', 'answer', 'ice'].indexOf(kind) === -1) {
    return res.status(400).json({ error: 'Invalid signal type.' });
  }
  const payload = typeof body.payload === 'string' ? body.payload : JSON.stringify(body.payload || null);
  if (!payload || payload.length > 120000) {
    return res.status(400).json({ error: 'Signal payload is missing or too large.' });
  }

  const other = call.caller_id === req.user.id ? call.receiver_id : call.caller_id;
  db.prepare(`
    INSERT INTO call_signals (id, call_id, from_user, to_user, kind, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('cs-' + uid(), call.id, req.user.id, other, kind, payload, now());

  if (kind === 'answer' && call.status === 'ringing') {
    db.prepare("UPDATE calls SET status = 'active', answered_at = ? WHERE id = ?").run(now(), call.id);
    sendEvent(other, 'call-accepted', { call: pubCall(getCall(call.id)), by: pubContact(req.user) });
  }

  sendEvent(other, 'call-signal', {
    callId: call.id,
    kind: kind,
    from: req.user.id,
    payload: payload
  });
  res.json({ ok: true });
});

app.get('/api/calls/:id/signals', requireAuth, function (req, res) {
  const call = getCall(req.params.id);
  if (!callIsParticipant(call, req.user.id)) return res.status(404).json({ error: 'Call not found.' });

  const rows = db.prepare(`
    SELECT id, from_user, kind, payload, created_at
    FROM call_signals WHERE call_id = ? ORDER BY created_at ASC
  `).all(call.id);

  res.json({
    signals: rows.map(function (r) {
      return {
        id: r.id,
        from: r.from_user,
        kind: r.kind,
        payload: r.payload,
        time: r.created_at
      };
    })
  });
});

/* ---------------- stories ---------------- */

app.get('/api/stories', requireAuth, function (req, res) {
  res.json({ stories: buildStories(req.user.id) });
});

app.post('/api/stories', requireAuth, function (req, res) {
  const meId = req.user.id;
  const body = req.body || {};
  const text = String(body.text || '').trim().slice(0, 1000);

  let mediaType = null;
  let mediaData = null;
  if (body.mediaData) {
    if (typeof body.mediaData !== 'string' || body.mediaData.indexOf('data:') !== 0 ||
        body.mediaData.length > 8 * 1024 * 1024) {
      return res.status(400).json({ error: 'Story media is too large (max 5 MB).' });
    }
    mediaData = body.mediaData;
    mediaType = String(body.mediaType || '').slice(0, 100);
  }

  if (!text && !mediaData) {
    return res.status(400).json({ error: 'Add some text or media to your story.' });
  }

  const background = /^#[0-9a-fA-F]{6}$/.test(String(body.background || ''))
    ? String(body.background)
    : '#6366f1';
  const created = now();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO stories (id, user_id, text, media_type, media_data, background, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('st-' + uid(), meId, text, mediaType, mediaData, background, created, expires);

  logActivity(meId, 'story.post', 'Posted a new story');
  pushStoriesToAll();
  res.status(201).json(buildBootstrap(meId));
});

app.post('/api/stories/:id/view', requireAuth, function (req, res) {
  const story = db.prepare('SELECT id FROM stories WHERE id = ?').get(req.params.id);
  if (!story) return res.status(404).json({ error: 'Story not found.' });
  db.prepare('INSERT OR IGNORE INTO story_views (story_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(story.id, req.user.id, now());
  res.json({ ok: true });
});

app.delete('/api/stories/:id', requireAuth, function (req, res) {
  const result = db.prepare('DELETE FROM stories WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Story not found.' });
  logActivity(req.user.id, 'story.delete', 'Deleted a story');
  pushStoriesToAll();
  res.json(buildBootstrap(req.user.id));
});

/* ---------------- reels ---------------- */

function buildReels(userId) {
  const rows = db.prepare(`
    SELECT r.*,
           u.name AS author_name, u.username AS author_username,
           u.color AS author_color, u.avatar AS author_avatar,
           (SELECT COUNT(*) FROM reel_likes l WHERE l.reel_id = r.id) AS like_count,
           (SELECT COUNT(*) FROM reel_likes l WHERE l.reel_id = r.id AND l.user_id = ?) AS liked
    FROM reels r
    JOIN users u ON u.id = r.user_id
    ORDER BY r.created_at DESC
    LIMIT 200
  `).all(userId);

  return rows.map(function (r) {
    return {
      id: r.id,
      userId: r.user_id,
      author: {
        id: r.user_id,
        name: r.author_name,
        username: r.author_username,
        color: r.author_color || '#8b5cf6',
        avatar: r.author_avatar || null
      },
      caption: r.caption || '',
      url: '/uploads/' + r.media_path,
      mime: r.mime,
      views: r.views || 0,
      likes: r.like_count || 0,
      liked: !!r.liked,
      mine: r.user_id === userId,
      time: r.created_at
    };
  });
}

function pushReelsToAll() {
  eventClients.forEach(function (clients, userId) {
    sendEvent(userId, 'reels', { reels: buildReels(userId) });
  });
}

app.get('/api/reels', requireAuth, function (req, res) {
  res.json({ reels: buildReels(req.user.id) });
});

app.post('/api/reels', requireAuth, function (req, res) {
  const meId = req.user.id;
  const body = req.body || {};
  const caption = String(body.caption || '').trim();
  if (caption.length > 500) {
    return res.status(400).json({ error: 'Caption must be 500 characters or less.' });
  }
  if (!body.mediaData) {
    return res.status(400).json({ error: 'Add a video for your reel.' });
  }
  if (typeof body.mediaData !== 'string' || body.mediaData.length > 21 * 1024 * 1024) {
    return res.status(400).json({ error: 'Reel video is too large (max 15 MB).' });
  }
  const saved = saveUploadFile(body.mediaData, 'video');
  if (!saved.ok) return res.status(400).json({ error: saved.error });

  db.prepare(`
    INSERT INTO reels (id, user_id, caption, media_path, mime, views, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run('rl-' + uid(), meId, caption, saved.file, saved.mime, now());

  logActivity(meId, 'reel.post', 'Posted a new reel');
  pushReelsToAll();
  res.status(201).json({ reels: buildReels(meId) });
});

app.post('/api/reels/:id/like', requireAuth, function (req, res) {
  const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(req.params.id);
  if (!reel) return res.status(404).json({ error: 'Reel not found.' });

  const existing = db.prepare('SELECT 1 FROM reel_likes WHERE reel_id = ? AND user_id = ?')
    .get(reel.id, req.user.id);
  if (existing) {
    db.prepare('DELETE FROM reel_likes WHERE reel_id = ? AND user_id = ?').run(reel.id, req.user.id);
  } else {
    db.prepare('INSERT INTO reel_likes (reel_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(reel.id, req.user.id, now());
  }
  const likes = db.prepare('SELECT COUNT(*) AS c FROM reel_likes WHERE reel_id = ?').get(reel.id).c;
  pushReelsToAll();
  res.json({ liked: !existing, likes: likes });
});

app.post('/api/reels/:id/view', requireAuth, function (req, res) {
  db.prepare('UPDATE reels SET views = views + 1 WHERE id = ?').run(req.params.id);
  const row = db.prepare('SELECT views FROM reels WHERE id = ?').get(req.params.id);
  res.json({ views: row ? row.views : 0 });
});

app.delete('/api/reels/:id', requireAuth, function (req, res) {
  const reel = db.prepare('SELECT * FROM reels WHERE id = ?').get(req.params.id);
  if (!reel) return res.status(404).json({ error: 'Reel not found.' });
  if (reel.user_id !== req.user.id && (req.user.role || 'user') !== 'admin') {
    return res.status(403).json({ error: 'You can only delete your own reels.' });
  }
  db.prepare('DELETE FROM reels WHERE id = ?').run(reel.id);
  try { fs.unlinkSync(path.join(UPLOADS_DIR, reel.media_path)); } catch (e) { /* ignore */ }
  logActivity(req.user.id, 'reel.delete', 'Deleted a reel');
  pushReelsToAll();
  res.json({ ok: true });
});

/* ---------------- notifications ---------------- */

app.post('/api/notifications/:id/read', requireAuth, function (req, res) {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?')
    .run(req.params.id, req.user.id);
  pushBootstrap(req.user.id);
  res.json(buildBootstrap(req.user.id));
});

app.post('/api/notifications/read-all', requireAuth, function (req, res) {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  pushBootstrap(req.user.id);
  res.json(buildBootstrap(req.user.id));
});

/* ---------------- public settings ---------------- */

app.get('/api/public/settings', function (req, res) {
  const iceServers = [{
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:global.stun.twilio.com:3478'
    ]
  }];
  const turnUrl = String(getSetting('turn_url', '') || '').trim();
  if (turnUrl) {
    const turn = { urls: turnUrl.split(',').map(function (s) { return s.trim(); }).filter(Boolean) };
    const turnUser = String(getSetting('turn_username', '') || '').trim();
    const turnPass = String(getSetting('turn_credential', '') || '').trim();
    if (turnUser) turn.username = turnUser;
    if (turnPass) turn.credential = turnPass;
    iceServers.push(turn);
  }
  res.json({
    appName: getSetting('app_name', 'MCHART'),
    allowRegistration: getSetting('allow_registration', '1') === '1',
    maintenanceMessage: getSetting('maintenance_message', ''),
    welcomeMessage: getSetting('welcome_message', ''),
    emailLoginEnabled: getSetting('email_login_enabled', '1') === '1',
    callsEnabled: getSetting('calls_enabled', '1') === '1',
    appLogo: String(getSetting('app_logo', '') || ''),
    iceServers: iceServers
  });
});

/* ---------------- admin API ---------------- */

function adminUserRow(u) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    email: u.email,
    bio: u.bio || '',
    color: u.color || '#8b5cf6',
    avatar: u.avatar || null,
    online: !!u.online,
    role: u.role || 'user',
    status: u.status || 'active',
    hasPublicKey: !!u.public_key,
    createdAt: u.created_at,
    messagesSent: u.messages_sent || 0,
    friendsCount: u.friends_count || 0
  };
}

function loadAdminUsers() {
  return db.prepare(`
    SELECT u.*,
      (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS messages_sent,
      (SELECT COUNT(*) FROM friendships f WHERE f.user_id = u.id) AS friends_count
    FROM users u
    ORDER BY u.created_at ASC
  `).all().map(adminUserRow);
}

app.get('/api/admin/overview', requireAuth, requireAdmin, function (req, res) {
  function count(sql) {
    const row = db.prepare(sql).get();
    return row ? row.c : 0;
  }

  const stats = {
    users: count('SELECT COUNT(*) AS c FROM users'),
    active: count("SELECT COUNT(*) AS c FROM users WHERE status = 'active'"),
    suspended: count("SELECT COUNT(*) AS c FROM users WHERE status = 'suspended'"),
    admins: count("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'"),
    online: count('SELECT COUNT(*) AS c FROM users WHERE online = 1'),
    messages: count('SELECT COUNT(*) AS c FROM messages'),
    encryptedMessages: count('SELECT COUNT(*) AS c FROM messages WHERE encrypted = 1'),
    friends: Math.round(count('SELECT COUNT(*) AS c FROM friendships') / 2),
    requests: count('SELECT COUNT(*) AS c FROM friend_requests'),
    notifications: count('SELECT COUNT(*) AS c FROM notifications'),
    calls: count('SELECT COUNT(*) AS c FROM calls'),
    activeCalls: count("SELECT COUNT(*) AS c FROM calls WHERE status = 'active'"),
    conversations: count(`
      SELECT COUNT(*) AS c FROM (
        SELECT DISTINCT
          CASE WHEN sender_id < receiver_id THEN sender_id || '|' || receiver_id
               ELSE receiver_id || '|' || sender_id END AS pair
        FROM messages
      )
    `)
  };

  const activity = db.prepare(`
    SELECT a.id, a.action, a.detail, a.created_at, a.actor_id, u.name AS actor_name
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.created_at DESC
    LIMIT 30
  `).all();

  res.json({
    stats: stats,
    settings: allSettings(),
    activity: activity,
    database: { name: DB_NAME, file: DB_PATH }
  });
});

app.get('/api/admin/users', requireAuth, requireAdmin, function (req, res) {
  const q = String(req.query.q || '').trim().toLowerCase();
  let users = loadAdminUsers();
  if (q) {
    users = users.filter(function (u) {
      return u.name.toLowerCase().indexOf(q) !== -1 ||
        u.username.toLowerCase().indexOf(q) !== -1 ||
        u.email.toLowerCase().indexOf(q) !== -1;
    });
  }
  res.json({ users: users });
});

app.post('/api/admin/users', requireAuth, requireAdmin, function (req, res) {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const username = String(body.username || '').trim().replace(/^@/, '').toLowerCase();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const role = body.role === 'admin' ? 'admin' : 'user';
  const status = body.status === 'suspended' ? 'suspended' : 'active';

  if (!name || !username || !email || !password) {
    return res.status(400).json({ error: 'Name, username, email and password are required.' });
  }
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters using letters, numbers, dot, dash or underscore.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (getUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' });
  if (getUserByUsername(username)) return res.status(409).json({ error: 'That username is already taken.' });

  const id = 'u-' + uid();
  db.prepare(`
    INSERT INTO users (id, name, username, email, password_hash, bio, color, avatar, online, role, status, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, NULL, 0, ?, ?, ?)
  `).run(id, name, username, email, hashPassword(password), pickColor(), role, status, now());

  logActivity(req.user.id, 'admin.user.create',
    'Created @' + username + ' (' + email + ') — role=' + role + ', status=' + status);

  const created = loadAdminUsers().filter(function (u) { return u.id === id; })[0];
  res.status(201).json({ ok: true, user: created });
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, function (req, res) {
  const targetId = req.params.id;
  const target = getUserById(targetId);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const body = req.body || {};
  const isSelf = targetId === req.user.id;

  const name = body.name !== undefined ? String(body.name).trim() : target.name;
  const username = body.username !== undefined
    ? String(body.username).trim().replace(/^@/, '').toLowerCase()
    : target.username;
  const email = body.email !== undefined ? String(body.email).trim().toLowerCase() : target.email;
  const bio = body.bio !== undefined ? String(body.bio).trim().slice(0, 300) : (target.bio || '');
  let role = body.role !== undefined ? String(body.role) : (target.role || 'user');
  let status = body.status !== undefined ? String(body.status) : (target.status || 'active');

  if (!name || !username || !email) {
    return res.status(400).json({ error: 'Name, username and email are required.' });
  }
  if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters using letters, numbers, dot, dash or underscore.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (role !== 'admin' && role !== 'user') {
    return res.status(400).json({ error: 'Invalid role.' });
  }
  if (status !== 'active' && status !== 'suspended') {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  if (isSelf && (role !== 'admin' || status !== 'active')) {
    return res.status(400).json({ error: 'You cannot demote or suspend your own admin account.' });
  }

  const otherEmail = getUserByEmail(email);
  if (otherEmail && otherEmail.id !== targetId) {
    return res.status(409).json({ error: 'That email is already in use.' });
  }
  const otherUsername = getUserByUsername(username);
  if (otherUsername && otherUsername.id !== targetId) {
    return res.status(409).json({ error: 'That username is already in use.' });
  }

  let passwordHash = target.password_hash;
  if (body.password !== undefined && String(body.password).length > 0) {
    if (String(body.password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    passwordHash = hashPassword(String(body.password));
  }

  db.prepare(`
    UPDATE users SET name = ?, username = ?, email = ?, bio = ?, role = ?, status = ?, password_hash = ?
    WHERE id = ?
  `).run(name, username, email, bio, role, status, passwordHash, targetId);

  if (status === 'suspended') {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    db.prepare('UPDATE users SET online = 0 WHERE id = ?').run(targetId);
    setOnline(targetId, false);
  }

  logActivity(req.user.id, 'admin.user.update',
    'Updated @' + username + (body.password ? ' (password reset)' : '') + ' — role=' + role + ', status=' + status);

  pushBootstrap(targetId);
  friendIdsOf(targetId).forEach(function (friendId) { pushBootstrap(friendId); });

  const updated = loadAdminUsers().filter(function (u) { return u.id === targetId; })[0];
  res.json({ ok: true, user: updated });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, function (req, res) {
  const targetId = req.params.id;
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  const target = getUserById(targetId);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const friends = friendIdsOf(targetId);
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  logActivity(req.user.id, 'admin.user.delete', 'Deleted @' + target.username + ' (' + target.email + ')');
  friends.forEach(function (friendId) { pushBootstrap(friendId); });

  res.json({ ok: true });
});

app.get('/api/admin/messages', requireAuth, requireAdmin, function (req, res) {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const q = String(req.query.q || '').trim().toLowerCase();

  let rows = db.prepare(`
    SELECT m.id, m.sender_id, m.receiver_id, m.text, m.attachment, m.encrypted,
           m.nonce, m.read, m.created_at,
           s.name AS sender_name, r.name AS receiver_name
    FROM messages m
    JOIN users s ON s.id = m.sender_id
    JOIN users r ON r.id = m.receiver_id
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit);

  if (q) {
    rows = rows.filter(function (m) {
      const hay = (m.sender_name + ' ' + m.receiver_name).toLowerCase();
      const body = m.encrypted ? '' : String(m.text || '').toLowerCase();
      return hay.indexOf(q) !== -1 || body.indexOf(q) !== -1;
    });
  }

  res.json({
    messages: rows.map(function (m) {
      var att = null;
      if (!m.encrypted && m.attachment) {
        att = safeParse(m.attachment);
        if (att) att = { name: att.name, size: att.size, type: att.type };
      }
      return {
        id: m.id,
        senderId: m.sender_id,
        senderName: m.sender_name,
        receiverId: m.receiver_id,
        receiverName: m.receiver_name,
        encrypted: !!m.encrypted,
        text: m.encrypted ? null : (m.text || ''),
        attachment: att,
        read: !!m.read,
        time: m.created_at
      };
    })
  });
});

app.delete('/api/admin/messages/:id', requireAuth, requireAdmin, function (req, res) {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Message not found.' });
  db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, 'admin.message.delete', 'Deleted a message from ' + row.sender_id + ' to ' + row.receiver_id);
  pushBootstrap(row.sender_id);
  pushBootstrap(row.receiver_id);
  res.json({ ok: true });
});

app.patch('/api/admin/messages/:id', requireAuth, requireAdmin, function (req, res) {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Message not found.' });
  if (row.encrypted) {
    return res.status(400).json({ error: 'End-to-end encrypted messages cannot be edited by an admin.' });
  }

  const text = String((req.body || {}).text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Message text cannot be empty.' });

  db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(text, row.id);
  logActivity(req.user.id, 'admin.message.edit', 'Edited message ' + row.id + ' between ' + row.sender_id + ' and ' + row.receiver_id);
  pushBootstrap(row.sender_id);
  pushBootstrap(row.receiver_id);
  res.json({ ok: true });
});

app.delete('/api/admin/chats/:userA/:userB', requireAuth, requireAdmin, function (req, res) {
  const a = req.params.userA;
  const b = req.params.userB;
  if (!getUserById(a) || !getUserById(b)) return res.status(404).json({ error: 'User not found.' });

  const result = db.prepare(`
    DELETE FROM messages
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
  `).run(a, b, b, a);

  logActivity(req.user.id, 'admin.chat.delete',
    'Deleted conversation between ' + a + ' and ' + b + ' (' + result.changes + ' messages)');
  pushBootstrap(a);
  pushBootstrap(b);
  res.json({ ok: true, deleted: result.changes });
});

app.get('/api/admin/activity', requireAuth, requireAdmin, function (req, res) {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare(`
    SELECT a.id, a.action, a.detail, a.created_at, a.actor_id, u.name AS actor_name, u.username AS actor_username
    FROM activity_log a
    LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(limit);
  res.json({ activity: rows });
});

const EDITABLE_SETTINGS = [
  'app_name', 'allow_registration', 'demo_replies', 'maintenance_message', 'welcome_message',
  'email_login_enabled', 'login_code_ttl', 'dev_show_login_code', 'calls_enabled',
  'turn_url', 'turn_username', 'turn_credential'
];
const LOGO_MAX_CHARS = 1.5 * 1024 * 1024;

app.get('/api/admin/settings', requireAuth, requireAdmin, function (req, res) {
  res.json({ settings: allSettings() });
});

app.patch('/api/admin/settings', requireAuth, requireAdmin, function (req, res) {
  const body = req.body || {};
  const updated = [];
  EDITABLE_SETTINGS.forEach(function (key) {
    if (body[key] === undefined) return;
    let value = body[key];
    if (typeof value === 'boolean') value = value ? '1' : '0';
    value = String(value).slice(0, 500);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
    updated.push(key);
  });

  /* app logo is a data-URL image and needs a much bigger limit than text settings */
  if (body.app_logo !== undefined) {
    const logo = body.app_logo === null ? '' : String(body.app_logo);
    if (logo === '') {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('app_logo', '');
      updated.push('app_logo');
    } else if (logo.indexOf('data:image/') === 0 && logo.length <= LOGO_MAX_CHARS) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('app_logo', logo);
      updated.push('app_logo');
    } else {
      return res.status(400).json({ error: 'Logo must be an image file (PNG, JPG, SVG or WebP, max 1 MB).' });
    }
  }

  if (updated.length) {
    logActivity(req.user.id, 'admin.settings.update', 'Updated settings: ' + updated.join(', '));
  }
  res.json({ ok: true, settings: allSettings() });
});

app.post('/api/admin/broadcast', requireAuth, requireAdmin, function (req, res) {
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Broadcast message cannot be empty.' });

  const users = db.prepare('SELECT id FROM users').all();
  users.forEach(function (u) {
    addNotification(u.id, 'system', text, req.user.id);
    pushBootstrap(u.id);
  });
  logActivity(req.user.id, 'admin.broadcast', 'Broadcast to ' + users.length + ' users: ' + text);
  res.json({ ok: true, count: users.length });
});

/* ---------------- admin danger zone ---------------- */

function clearUploadsDir() {
  try {
    fs.readdirSync(UPLOADS_DIR).forEach(function (f) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }
}

/* Reset all system records but keep the user accounts (and admin settings). */
app.post('/api/admin/danger/reset', requireAuth, requireAdmin, function (req, res) {
  if (String((req.body || {}).confirm || '') !== 'RESET') {
    return res.status(400).json({ error: 'Confirmation failed. Type RESET to continue.' });
  }

  const tables = ['messages', 'stories', 'story_views', 'notifications', 'friendships',
    'friend_requests', 'calls', 'call_signals', 'reels', 'reel_likes', 'activity_log', 'login_codes'];
  tables.forEach(function (t) {
    db.prepare('DELETE FROM ' + t).run();
  });
  clearUploadsDir();

  logActivity(req.user.id, 'admin.danger.reset',
    'Reset ALL system records: messages, stories, reels, calls, friendships, notifications');

  eventClients.forEach(function (clients, userId) { pushBootstrap(userId); });
  pushReelsToAll();
  res.json({ ok: true, reset: true });
});

/* Delete every record AND every user account except the requesting admin. */
app.post('/api/admin/danger/wipe', requireAuth, requireAdmin, function (req, res) {
  if (String((req.body || {}).confirm || '') !== 'DELETE') {
    return res.status(400).json({ error: 'Confirmation failed. Type DELETE to continue.' });
  }

  const meId = req.user.id;

  /* cascades remove friendships, messages, stories, calls, reels, sessions etc. */
  db.prepare('DELETE FROM users WHERE id != ?').run(meId);
  ['messages', 'stories', 'story_views', 'notifications', 'friendships', 'friend_requests',
    'calls', 'call_signals', 'reels', 'reel_likes', 'activity_log', 'login_codes', 'demo_keys']
    .forEach(function (t) {
      db.prepare('DELETE FROM ' + t).run();
    });
  clearUploadsDir();

  logActivity(meId, 'admin.danger.wipe', 'Deleted ALL user accounts and records except the admin');

  /* everyone else is gone: force their open tabs to log out */
  eventClients.forEach(function (clients, userId) {
    if (userId === meId) return;
    const payload = 'event: forced-logout\ndata: {"reason":"All accounts were deleted by the administrator."}\n\n';
    clients.forEach(function (r) {
      try { r.write(payload); } catch (e) { /* ignore */ }
      try { r.end(); } catch (e) { /* ignore */ }
    });
  });

  pushBootstrap(meId);
  pushReelsToAll();
  res.json({ ok: true, wiped: true });
});

/* ---------------- errors ---------------- */

app.use(function (req, res) {
  res.status(404).json({ error: 'Not found.' });
});

app.use(function (err, req, res, next) {
  console.error(err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, function () {
  console.log('MCHART server running at http://localhost:' + PORT);
  console.log('SQLite database: ' + DB_PATH);
});
