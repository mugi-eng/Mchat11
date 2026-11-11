/* ============================================================
   MCHART — password hashing and token helpers
   Uses Node's built-in crypto (scrypt), no extra dependencies.
   ============================================================ */
'use strict';

const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + derived;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || stored.indexOf(':') === -1) return false;
  const parts = stored.split(':');
  const salt = parts[0];
  const hash = parts[1];
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { hashPassword, verifyPassword, newToken };
