/* ============================================================
   MCHART — SQLite database (built-in node:sqlite)
   Creates the schema and seeds sample data on first run.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_NAME = 'Mchat_Database1';
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, DB_NAME + '.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    bio           TEXT DEFAULT '',
    color         TEXT DEFAULT '#8b5cf6',
    avatar        TEXT,
    online        INTEGER DEFAULT 0,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS friendships (
    user_id    TEXT NOT NULL,
    friend_id  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, friend_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id         TEXT PRIMARY KEY,
    from_user  TEXT NOT NULL,
    to_user    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (from_user, to_user),
    FOREIGN KEY (from_user) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (to_user) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    sender_id   TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    text        TEXT DEFAULT '',
    attachment  TEXT,
    read        INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    type       TEXT NOT NULL,
    text       TEXT NOT NULL,
    actor_id   TEXT,
    read       INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id         TEXT PRIMARY KEY,
    actor_id   TEXT,
    action     TEXT NOT NULL,
    detail     TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS demo_keys (
    user_id     TEXT PRIMARY KEY,
    private_key TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  /* one-time email verification codes used for passwordless login */
  CREATE TABLE IF NOT EXISTS login_codes (
    id         TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    purpose    TEXT DEFAULT 'login',
    attempts   INTEGER DEFAULT 0,
    used       INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  /* audio / video calls between users */
  CREATE TABLE IF NOT EXISTS calls (
    id          TEXT PRIMARY KEY,
    caller_id   TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'audio',
    status      TEXT NOT NULL DEFAULT 'ringing',
    created_at  TEXT NOT NULL,
    answered_at TEXT,
    ended_at    TEXT,
    FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
  );

  /* WebRTC signalling messages (offer / answer / ice) */
  CREATE TABLE IF NOT EXISTS call_signals (
    id         TEXT PRIMARY KEY,
    call_id    TEXT NOT NULL,
    from_user  TEXT NOT NULL,
    to_user    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE
  );

  /* reels: short vertical videos */
  CREATE TABLE IF NOT EXISTS reels (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    caption    TEXT DEFAULT '',
    media_path TEXT NOT NULL,
    mime       TEXT NOT NULL DEFAULT 'video/webm',
    views      INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reel_likes (
    reel_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (reel_id, user_id),
    FOREIGN KEY (reel_id) REFERENCES reels(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  /* stories expire after 24 hours */
  CREATE TABLE IF NOT EXISTS stories (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    text       TEXT DEFAULT '',
    media_type TEXT,
    media_data TEXT,
    background TEXT DEFAULT '#6366f1',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS story_views (
    story_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (story_id, user_id),
    FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair
    ON messages (sender_id, receiver_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_receiver
    ON messages (receiver_id, read);
  CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications (user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_activity_created
    ON activity_log (created_at);
  CREATE INDEX IF NOT EXISTS idx_login_codes_email
    ON login_codes (email, created_at);
  CREATE INDEX IF NOT EXISTS idx_calls_pair
    ON calls (caller_id, receiver_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_call_signals_call
    ON call_signals (call_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_stories_user
    ON stories (user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_stories_expires
    ON stories (expires_at);
  CREATE INDEX IF NOT EXISTS idx_reels_created
    ON reels (created_at);
  CREATE INDEX IF NOT EXISTS idx_reel_likes_reel
    ON reel_likes (reel_id);
`);

/* ---------------- schema migrations (safe to re-run) ---------------- */

function hasColumn(table, column) {
  return db.prepare('PRAGMA table_info(' + table + ')').all()
    .some(function (c) { return c.name === column; });
}
function ensureColumn(table, column, definition) {
  if (!hasColumn(table, column)) {
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition + ';');
  }
}

ensureColumn('users', 'role', "TEXT DEFAULT 'user'");
ensureColumn('users', 'status', "TEXT DEFAULT 'active'");
ensureColumn('users', 'public_key', 'TEXT');
ensureColumn('users', 'cover', 'TEXT');
ensureColumn('messages', 'encrypted', 'INTEGER DEFAULT 0');
ensureColumn('messages', 'nonce', 'TEXT');

/* ---------------- default settings ---------------- */

const DEFAULT_SETTINGS = {
  app_name: 'MCHART',
  allow_registration: '1',
  demo_replies: '1',
  maintenance_message: '',
  welcome_message: 'Welcome to MCHART — real-time messaging served by Express and SQLite.',
  email_login_enabled: '1',
  login_code_ttl: '10',
  dev_show_login_code: '1',
  calls_enabled: '1',
  app_logo: '',
  turn_url: '',
  turn_username: '',
  turn_credential: ''
};
Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .run(key, DEFAULT_SETTINGS[key]);
});

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

/* Demo accounts (aline + the demo bots). u1 is the account referenced by the
   "Try the demo account" button on the login screen; u2-u7 are the bots that
   auto-reply and hold demo ECDH keys. */
function demoUsers() {
  return [
    {
      id: 'u1', name: 'Aline Uwase', username: 'aline', email: 'aline@mchart.app',
      password: hashPassword('123456'), bio: 'Product designer. Coffee and pixels.',
      color: '#8b5cf6', avatar: null, online: 1
    },
    { id: 'u2', name: 'Liam Carter', username: 'liam', email: 'liam@mchart.app', password: hashPassword('demo1234'), bio: 'Frontend developer and coffee addict.', color: '#7c3aed', avatar: null, online: 1 },
    { id: 'u3', name: 'Sofia Reyes', username: 'sofia', email: 'sofia@mchart.app', password: hashPassword('demo1234'), bio: 'Photographer. Always chasing light.', color: '#db2777', avatar: null, online: 0 },
    { id: 'u4', name: 'Noah Bennett', username: 'noah', email: 'noah@mchart.app', password: hashPassword('demo1234'), bio: 'Product manager. Runner.', color: '#2563eb', avatar: null, online: 1 },
    { id: 'u5', name: 'Maya Chen', username: 'maya', email: 'maya@mchart.app', password: hashPassword('demo1234'), bio: 'UX researcher and illustrator.', color: '#0d9488', avatar: null, online: 1 },
    { id: 'u6', name: 'Ethan Brooks', username: 'ethan', email: 'ethan@mchart.app', password: hashPassword('demo1234'), bio: 'Full-stack dev. Guitar in spare time.', color: '#d97706', avatar: null, online: 0 },
    { id: 'u7', name: 'Zara Ali', username: 'zara', email: 'zara@mchart.app', password: hashPassword('demo1234'), bio: 'Content creator and traveler.', color: '#e11d48', avatar: null, online: 1 }
  ];
}

/* Guarantee the demo accounts exist even when the database was created with
   real users first (the seed below only runs on an empty database). This keeps
   the frontend "Try the demo account" button working without touching any
   existing user data. */
function ensureDemoAccounts() {
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, name, username, email, password_hash, bio, color, avatar, online, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const created = new Date().toISOString();
  demoUsers().forEach(function (u) {
    insertUser.run(u.id, u.name, u.username, u.email, u.password, u.bio, u.color, u.avatar, u.online, created);
  });
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const now = new Date().toISOString();

  const users = demoUsers();

  const insertUser = db.prepare(`
    INSERT INTO users (id, name, username, email, password_hash, bio, color, avatar, online, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  users.forEach(function (u) {
    insertUser.run(u.id, u.name, u.username, u.email, u.password, u.bio, u.color, u.avatar, u.online, now);
  });

  const insertFriend = db.prepare('INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)');
  ['u2', 'u3', 'u5', 'u6'].forEach(function (id) {
    insertFriend.run('u1', id, now);
    insertFriend.run(id, 'u1', now);
  });

  const insertRequest = db.prepare('INSERT INTO friend_requests (id, from_user, to_user, created_at) VALUES (?, ?, ?, ?)');
  insertRequest.run('r1', 'u7', 'u1', minutesAgo(30));
  insertRequest.run('r2', 'u4', 'u1', minutesAgo(120));

  const insertMessage = db.prepare(`
    INSERT INTO messages (id, sender_id, receiver_id, text, attachment, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const messages = [
    ['m1', 'u1', 'u2', 'Hey Liam! Did you get a chance to look at the new chat design?', null, 1, minutesAgo(62)],
    ['m2', 'u2', 'u1', 'Yes! It looks super clean. The purple accents are perfect.', null, 1, minutesAgo(58)],
    ['m3', 'u2', 'u1', 'Can we tweak the spacing in the sidebar though?', null, 1, minutesAgo(57)],
    ['m4', 'u1', 'u2', "Sure, I'll adjust it before the demo.", null, 1, minutesAgo(40)],
    ['m5', 'u2', 'u1', "You're the best. Sending the updated assets in a sec.", null, 0, minutesAgo(12)],
    ['m6', 'u3', 'u1', "The shoot went amazing today. I'll share the photos tonight.", null, 1, minutesAgo(180)],
    ['m7', 'u1', 'u3', "Can't wait to see them!", null, 1, minutesAgo(175)],
    ['m8', 'u1', 'u5', 'Maya, the user survey results are in. 92% loved the onboarding!', null, 1, minutesAgo(1440)],
    ['m9', 'u5', 'u1', "That's huge. Let's present it on Friday.", null, 0, minutesAgo(1400)]
  ];
  messages.forEach(function (m) { insertMessage.run.apply(insertMessage, m); });

  const insertNotification = db.prepare(`
    INSERT INTO notifications (id, user_id, type, text, actor_id, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  [
    ['n1', 'message', 'Liam Carter sent you a message.', 'u2', 0, minutesAgo(12)],
    ['n2', 'request', 'Zara Ali sent you a friend request.', 'u7', 0, minutesAgo(30)],
    ['n3', 'request', 'Noah Bennett sent you a friend request.', 'u4', 0, minutesAgo(120)],
    ['n4', 'message', 'Maya Chen replied about the survey results.', 'u5', 1, minutesAgo(1400)],
    ['n5', 'friend', 'Ethan Brooks accepted your friend request.', 'u6', 1, minutesAgo(2880)]
  ].forEach(function (n) {
    insertNotification.run(n[0], 'u1', n[1], n[2], n[3], n[4], n[5]);
  });
}

seed();

/* ---------------- guaranteed admin account ---------------- */

function ensureAdmin() {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get('admin@mchart.app');
  if (existing) {
    // make sure the role/status columns are correct even on older databases
    db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?").run(existing.id);
    return;
  }
  let id = 'u-admin';
  if (db.prepare('SELECT id FROM users WHERE id = ?').get(id)) {
    id = 'u-admin-' + Date.now();
  }
  let username = 'admin';
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    username = 'admin-mchart';
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      username = 'admin-mchart-' + Date.now();
    }
  }
  db.prepare(`
    INSERT INTO users (id, name, username, email, password_hash, bio, color, avatar, online, role, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 'admin', 'active', ?)
  `).run(
    id, 'MCHART Admin', username, 'admin@mchart.app',
    hashPassword('admin123'), 'Platform administrator.', '#6366f1', new Date().toISOString()
  );
}

/* ---------------- demo users get ECDH keypairs (demo only) ---------------- */

const DEMO_USER_IDS = ['u2', 'u3', 'u4', 'u5', 'u6', 'u7'];

function ensureDemoKeys() {
  DEMO_USER_IDS.forEach(function (id) {
    const user = db.prepare('SELECT id, public_key FROM users WHERE id = ?').get(id);
    if (!user) return;
    const keyRow = db.prepare('SELECT user_id FROM demo_keys WHERE user_id = ?').get(id);
    if (user.public_key && keyRow) return;

    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicJwk = pair.publicKey.export({ format: 'jwk' });
    const privateJwk = pair.privateKey.export({ format: 'jwk' });

    db.prepare('UPDATE users SET public_key = ? WHERE id = ?').run(JSON.stringify(publicJwk), id);
    db.prepare('INSERT OR REPLACE INTO demo_keys (user_id, private_key) VALUES (?, ?)')
      .run(id, JSON.stringify(privateJwk));
  });
}

ensureAdmin();
ensureDemoAccounts();
ensureDemoKeys();

module.exports = { db, DB_PATH, DB_NAME, DEMO_USER_IDS };
