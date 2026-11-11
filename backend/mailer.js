/* ============================================================
   MCHART — email delivery helper
   Sends login verification codes by email.

   - If SMTP_* environment variables are set and the optional
     "nodemailer" package is installed, a real email is sent.
   - Otherwise the app falls back to a local "outbox" so the
     project still works offline (the code is printed to the
     server console and appended to data/email_outbox.log).
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const OUTBOX_PATH = path.join(DATA_DIR, 'email_outbox.log');

const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || 'MCHART <no-reply@mchart.app>'
};

function smtpConfigured() {
  return !!(SMTP.host && SMTP.user && SMTP.pass);
}

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!smtpConfigured()) return null;
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host: SMTP.host,
    port: SMTP.port,
    secure: SMTP.secure,
    auth: { user: SMTP.user, pass: SMTP.pass }
  });
  return transporter;
}

function appendOutbox(email, subject, text) {
  const entry = [
    '----- ' + new Date().toISOString() + ' -----',
    'To: ' + email,
    'Subject: ' + subject,
    '',
    text,
    ''
  ].join('\n');
  try { fs.appendFileSync(OUTBOX_PATH, entry + '\n', 'utf8'); } catch (e) { /* ignore */ }
}

function mailerInfo() {
  if (smtpConfigured() && getTransporter()) {
    return { transport: 'smtp', delivered: true };
  }
  return { transport: 'local-outbox', delivered: false };
}

/**
 * Send a login verification code.
 * Resolves with { delivered, transport, error } and never rejects,
 * so the login flow keeps working even when email is unavailable.
 */
async function sendLoginCode(email, code, ttlMinutes) {
  const subject = 'Your MCHART verification code';
  const text =
    'Your MCHART verification code is: ' + code + '\n\n' +
    'This code expires in ' + ttlMinutes + ' minute(s).\n' +
    'If you did not request this code you can safely ignore this email.';

  const tx = getTransporter();
  if (tx) {
    try {
      await tx.sendMail({ from: SMTP.from, to: email, subject: subject, text: text });
      return { delivered: true, transport: 'smtp' };
    } catch (err) {
      console.error('[mailer] SMTP send failed:', err.message);
      appendOutbox(email, subject, text + '\n(SMTP delivery failed: ' + err.message + ')');
      return { delivered: false, transport: 'local-outbox', error: err.message };
    }
  }

  console.log('\n============================================================');
  console.log(' MCHART verification code for ' + email + ': ' + code);
  console.log(' (expires in ' + ttlMinutes + ' minutes)');
  console.log(' Email is not configured, so the code was written to:');
  console.log(' ' + OUTBOX_PATH);
  console.log('============================================================\n');
  appendOutbox(email, subject, text);
  return { delivered: false, transport: 'local-outbox' };
}

module.exports = { sendLoginCode, mailerInfo, OUTBOX_PATH, smtpConfigured };
