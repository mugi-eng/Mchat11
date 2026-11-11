/* ============================================================
   MCHART — frontend logic (vanilla JavaScript)
   Talks to the Express + SQLite backend via /api.
   ============================================================ */
(function () {
  'use strict';

  var TOKEN_KEY = 'mchart_token';
  var THEME_KEY = 'mchart_theme';
  var API_BASE = window.location.protocol === 'file:' ? 'http://localhost:4000' : '';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }

  var state = null;
  var currentView = 'dashboard';
  var activeChatUserId = null;
  var pendingAttachment = null;
  var friendsTab = 'all';
  var pollTimer = null;
  var lastMutationAt = 0;
  var eventSource = null;
  var typingSentAt = 0;
  var typingStopTimer = null;
  var remoteTypingTimer = null;
  var markingRead = false;

  var publicSettings = { emailLoginEnabled: true, callsEnabled: true };
  var codeResendTimer = null;

  var mediaRecorder = null;
  var recordedChunks = [];
  var recordingStopTimer = null;
  var isRecording = false;
  var recordingBusy = false;
  var recordingTimer = null;
  var recordingStartedAt = 0;

  var callState = null;
  var incomingCall = null;

  var pendingStoryMedia = null;
  var storyBackground = '#6366f1';
  var storyViewIndex = -1;
  var storyTimer = null;

  var reelState = { list: [], loaded: false, observer: null, viewed: {} };
  var pendingReelMedia = null;

  var cameraCapture = null; /* { mode, stream, recorder, chunks, recorded } */

  var VIEW_TITLES = {
    dashboard: 'Dashboard',
    messages: 'Messages',
    stories: 'Stories',
    reels: 'Reels',
    friends: 'Friends',
    notifications: 'Notifications',
    profile: 'Profile',
    admin: 'Admin'
  };

  var adminState = {
    stats: null,
    settings: null,
    activity: [],
    users: [],
    messages: [],
    database: null,
    tab: 'users',
    search: '',
    loaded: false
  };
  var adminLoading = false;

  /* ---------------- API ---------------- */

  function clearToken() {
    token = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  async function api(path, options) {
    options = options || {};
    var method = options.method || 'GET';
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;

    var response;
    try {
      response = await fetch(API_BASE + path, {
        method: method,
        headers: headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined
      });
    } catch (networkError) {
      var err = new Error('Cannot reach the server. Is it running?');
      err.status = 0;
      throw err;
    }

    var data = null;
    try { data = await response.json(); } catch (e) { data = null; }

    if (!response.ok) {
      var error = new Error((data && data.error) || ('Request failed (' + response.status + ')'));
      error.status = response.status;

      if (response.status === 401 && token) {
        var wasInApp = $('#app-screen') && !$('#app-screen').classList.contains('hidden');
        clearToken();
        state = null;
        stopPolling();
        if (wasInApp) {
          showAuth();
          toast('Your session expired. Please log in again.');
        }
      }
      throw error;
    }

    if (method !== 'GET') lastMutationAt = Date.now();
    if (data && data.chats && data.me) {
      await hydrateBootstrap(data);
    }
    return data;
  }

  /* ---------------- Icons ---------------- */

  var ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    userPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>',
    userMinus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    single: '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    double: '<svg class="tick read" viewBox="0 0 30 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 7 17l-4-4"/><path d="M26 6 15 17"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
    ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/></svg>',
    power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    phoneOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67M4.34 8.09a19.79 19.79 0 0 1-.27-6.37A2 2 0 0 1 6.11 0h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L9.09 9.91"/><path d="M23 1 1 23"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l22 22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><path d="M12 19v4M8 23h8"/></svg>',
    cameraOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l22 22"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h3a2 2 0 0 1 2 2v9"/><path d="M9.5 13.5a4 4 0 0 0 5 5"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l8.84 8.84 8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    volumeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M23 9l-6 6M17 9l6 6"/></svg>',
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M7 3v14M17 3v14M2 8h20M2 13h20"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9z"/></svg>'
  };

  /* ---------------- Utilities ---------------- */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
  }

  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtRelative(iso) {
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + units[i];
  }

  function toast(message) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.classList.remove('show'); }, 2300);
  }

  /* ---------------- End-to-end encryption ---------------- */

  var CRYPTO_OK = !!(window.crypto && window.crypto.subtle && window.TextEncoder && window.TextDecoder);
  var selfKeys = {};
  var peerKeys = {};

  function b64encode(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function b64decode(str) {
    var binary = atob(str);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function privateStoreKey(userId) { return 'mchart_priv_' + userId; }

  function importPrivateKey(jwk) {
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
  }

  function importPublicKey(jwk) {
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  }

  function samePublicKey(serverKey, jwk) {
    if (!serverKey || !jwk) return false;
    try {
      var s = JSON.parse(serverKey);
      return !!s && s.crv === jwk.crv && s.x === jwk.x && s.y === jwk.y;
    } catch (e) {
      return false;
    }
  }

  function getSelfPrivate() {
    var u = me();
    return u ? (selfKeys[u.id] || null) : null;
  }

  function getPeerPublic(userId) {
    if (peerKeys[userId]) return Promise.resolve(peerKeys[userId]);
    var c = contact(userId);
    if (!c || !c.publicKey) return Promise.resolve(null);
    return importPublicKey(JSON.parse(c.publicKey)).then(function (key) {
      peerKeys[userId] = key;
      return key;
    }).catch(function () { return null; });
  }

  function deriveAes(privateKey, publicKey) {
    return crypto.subtle.deriveKey(
      { name: 'ECDH', public: publicKey }, privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  function canEncrypt(userId) {
    var c = contact(userId);
    return CRYPTO_OK && !!getSelfPrivate() && !!(c && c.publicKey);
  }

  async function encryptPayload(userId, payload) {
    var priv = getSelfPrivate();
    var pub = await getPeerPublic(userId);
    if (!priv || !pub) return null;
    var key = await deriveAes(priv, pub);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var data = new TextEncoder().encode(JSON.stringify(payload));
    var cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data);
    return { text: b64encode(cipher), nonce: b64encode(iv) };
  }

  async function decryptMessage(userId, m) {
    if (!m.encrypted) return { text: m.text || '', attachment: m.attachment || null };
    try {
      var priv = getSelfPrivate();
      var pub = await getPeerPublic(userId);
      if (!priv || !pub) throw new Error('keys unavailable');
      var key = await deriveAes(priv, pub);
      var plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64decode(m.nonce) }, key, b64decode(m.text)
      );
      var obj = JSON.parse(new TextDecoder().decode(plain));
      return { text: obj.text || '', attachment: obj.attachment || null };
    } catch (e) {
      return { text: 'Unable to decrypt this message on this device.', attachment: null, undecryptable: true };
    }
  }

  async function hydrateBootstrap(data) {
    if (!data || !data.chats || !data.chats.length) return data;
    for (var i = 0; i < data.chats.length; i++) {
      var chat = data.chats[i];
      for (var j = 0; j < chat.messages.length; j++) {
        var m = chat.messages[j];
        if (m.encrypted && (!m.plain || m.plain.undecryptable)) {
          m.plain = await decryptMessage(chat.userId, m);
        }
      }
    }
    return data;
  }

  async function setupEncryption() {
    if (!CRYPTO_OK || !state || !state.me) return;
    var u = state.me;
    var stored = null;
    try { stored = localStorage.getItem(privateStoreKey(u.id)); } catch (e) { stored = null; }

    var privateKey = null;
    var publicJwk = null;
    if (stored) {
      try {
        var storedJwk = JSON.parse(stored);
        privateKey = await importPrivateKey(storedJwk);
        publicJwk = { kty: storedJwk.kty, crv: storedJwk.crv, x: storedJwk.x, y: storedJwk.y };
      } catch (e) {
        privateKey = null;
      }
    }

    if (!privateKey) {
      try {
        var pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
        privateKey = pair.privateKey;
        var privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
        try { localStorage.setItem(privateStoreKey(u.id), JSON.stringify(privJwk)); } catch (e) { /* ignore */ }
        publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      } catch (e) {
        return;
      }
    }

    selfKeys[u.id] = privateKey;

    if (!samePublicKey(u.publicKey, publicJwk)) {
      try {
        state = await api('/api/users/me', { method: 'PATCH', body: { publicKey: JSON.stringify(publicJwk) } });
      } catch (e) { /* ignore */ }
    }
    if (stored === null && u.publicKey) {
      toast('New encryption keys created on this device. Older encrypted messages cannot be read here.');
    }
    state.contacts.forEach(function (c) {
      if (c.publicKey && !peerKeys[c.id]) {
        importPublicKey(JSON.parse(c.publicKey)).then(function (key) {
          peerKeys[c.id] = key;
        }).catch(function () { /* ignore */ });
      }
    });

    // Retry decryption now that this device's private key is available.
    try { await hydrateBootstrap(state); } catch (e) { /* ignore */ }
  }

  /* ---------------- Data access ---------------- */

  function me() { return state ? state.me : null; }

  function contact(id) {
    if (!state) return null;
    return state.contacts.filter(function (c) { return c.id === id; })[0] || null;
  }

  function getChat(userId) {
    if (!state) return null;
    return state.chats.filter(function (c) { return c.userId === userId; })[0] || null;
  }

  function lastMessage(chat) {
    return chat.messages.length ? chat.messages[chat.messages.length - 1] : null;
  }

  function unreadCount(chat) {
    return chat.messages.filter(function (m) { return m.from !== 'me' && !m.read; }).length;
  }

  function totalUnread() {
    if (!state) return 0;
    return state.chats.reduce(function (sum, c) { return sum + unreadCount(c); }, 0);
  }

  function msgText(m) {
    if (!m) return '';
    return m.plain ? (m.plain.text || '') : (m.text || '');
  }

  function msgAttachment(m) {
    if (!m) return null;
    return m.plain ? (m.plain.attachment || null) : (m.attachment || null);
  }

  function previewOf(m) {
    if (!m) return 'No messages yet';
    var att = msgAttachment(m);
    var text = msgText(m);
    if (att && !text) {
      if (att.type && att.type.indexOf('image/') === 0) return 'Photo';
      if (att.type && att.type.indexOf('video/') === 0) return 'Video';
      if (att.type && att.type.indexOf('audio/') === 0) return 'Voice message';
      return 'Attachment';
    }
    if (m.encrypted && m.plain && m.plain.undecryptable) return 'Encrypted message';
    return text;
  }

  function matchPerson(person, q) {
    return person && (
      person.name.toLowerCase().indexOf(q) !== -1 ||
      person.username.toLowerCase().indexOf(q) !== -1
    );
  }

  function avatarHTML(person, cls) {
    if (!person) return '';
    var klass = 'avatar' + (cls ? ' ' + cls : '');
    if (person.avatar) {
      return '<span class="' + klass + '"><img src="' + person.avatar + '" alt="' + esc(person.name) + '"></span>';
    }
    return '<span class="' + klass + '" style="--av:' + (person.color || '#8b5cf6') + '">' + esc(initials(person.name)) + '</span>';
  }

  function tickHTML(read) { return read ? ICONS.double : ICONS.single; }

  function notifIcon(type) {
    if (type === 'message') return ICONS.chat;
    if (type === 'request') return ICONS.userPlus;
    if (type === 'friend') return ICONS.users;
    return ICONS.bell;
  }

  function setBadge(el, n) {
    if (!el) return;
    if (n > 0) {
      el.textContent = n > 99 ? '99+' : String(n);
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  /* ---------------- Theme ---------------- */

  function isDark() {
    return document.documentElement.getAttribute('data-theme') !== 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
    updateThemeUI();
  }

  function toggleTheme() { applyTheme(isDark() ? 'light' : 'dark'); }

  function updateThemeUI() {
    var dark = isDark();
    $$('[data-theme-label]').forEach(function (el) { el.textContent = dark ? 'Dark mode' : 'Light mode'; });
    $$('[data-theme-icon]').forEach(function (el) { el.innerHTML = dark ? ICONS.moon : ICONS.sun; });
    var sw = $('#profile-body .switch');
    if (sw) sw.classList.toggle('on', dark);
  }

  /* ---------------- Public settings ---------------- */

  var DEFAULT_LOGO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

  /* Applies the custom app logo (or the default SVG) to every brand element
     plus the browser tab favicon. Called on load and whenever the admin
     changes the logo. */
  function applyAppLogo(logoDataUrl) {
    var html = logoDataUrl
      ? '<img src="' + logoDataUrl + '" alt="App logo">'
      : DEFAULT_LOGO_SVG;
    $$('.brand-logo').forEach(function (el) { el.innerHTML = html; });
    var favicon = $('#favicon');
    if (favicon) {
      favicon.setAttribute('href', logoDataUrl || favicon.getAttribute('href'));
      if (logoDataUrl) favicon.setAttribute('href', logoDataUrl);
    }
  }

  async function loadPublicSettings() {
    var s;
    try { s = await api('/api/public/settings'); } catch (e) { return; }

    var banner = $('#maintenance-banner');
    if (banner) {
      if (s.maintenanceMessage) {
        banner.textContent = s.maintenanceMessage;
        banner.classList.remove('hidden');
      } else {
        banner.textContent = '';
        banner.classList.add('hidden');
      }
    }
    if (s.appName) {
      $$('.brand-name').forEach(function (el) { el.textContent = s.appName; });
      document.title = s.appName + ' — Modern Messaging';
    }
    applyAppLogo(s.appLogo || '');
    var foot = $('.auth-foot');
    if (foot && s.welcomeMessage) foot.textContent = s.welcomeMessage;
    var signupTab = $('#tab-signup');
    if (signupTab) signupTab.classList.toggle('hidden', !s.allowRegistration);

    publicSettings = {
      emailLoginEnabled: s.emailLoginEnabled !== false,
      callsEnabled: s.callsEnabled !== false,
      appLogo: s.appLogo || '',
      iceServers: Array.isArray(s.iceServers) && s.iceServers.length
        ? s.iceServers
        : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
    };
    var codeTab = $('#tab-code');
    if (codeTab) codeTab.classList.toggle('hidden', !publicSettings.emailLoginEnabled);
  }

  /* ---------------- Auth ---------------- */

  function switchAuthTab(tab) {
    if (tab !== 'login' && tab !== 'code' && tab !== 'signup') tab = 'login';
    ['login', 'code', 'signup'].forEach(function (name) {
      var tabBtn = $('#tab-' + name);
      if (tabBtn) tabBtn.classList.toggle('active', name === tab);
      var form = $('#' + name + '-form');
      if (form) form.classList.toggle('hidden', name !== tab);
    });
  }

  function showAuth() {
    stopPolling();
    stopRealtime();
    $('#auth-screen').classList.remove('hidden');
    $('#app-screen').classList.add('hidden');
  }

  function enterApp() {
    $('#auth-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    activeChatUserId = null;
    pendingAttachment = null;
    renderSidebarBits();
    updateThemeUI();
    var u = me();
    setView(u && u.role === 'admin' ? 'admin' : 'dashboard');
    startRealtime();
    startPolling();
  }

  function setBusy(formId, busy, label) {
    var form = typeof formId === 'string' ? $(formId) : formId;
    var btn = form ? form.querySelector('button[type="submit"]') : null;
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = label;
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  async function login(e) {
    e.preventDefault();
    var email = $('#login-email').value.trim().toLowerCase();
    var password = $('#login-password').value;
    var err = $('#login-error');
    err.textContent = '';

    if (!email || !password) { err.textContent = 'Please enter your email and password.'; return; }

    setBusy('#login-form', true, 'Logging in...');
    try {
      var data = await api('/api/auth/login', { method: 'POST', body: { email: email, password: password } });
      token = data.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch (e2) { /* ignore */ }
      state = data.bootstrap;
      await setupEncryption();
      enterApp();
      toast('Welcome back, ' + state.me.name.split(' ')[0] + '!');
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      setBusy('#login-form', false);
    }
  }

  async function signup(e) {
    e.preventDefault();
    var name = $('#signup-name').value.trim();
    var username = $('#signup-username').value.trim().replace(/^@/, '');
    var email = $('#signup-email').value.trim();
    var password = $('#signup-password').value;
    var err = $('#signup-error');
    err.textContent = '';

    if (!name || !username || !email || !password) { err.textContent = 'Please fill in all fields.'; return; }
    if (password.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }

    setBusy('#signup-form', true, 'Creating account...');
    try {
      var data = await api('/api/auth/register', {
        method: 'POST',
        body: { name: name, username: username, email: email, password: password }
      });
      token = data.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch (e2) { /* ignore */ }
      state = data.bootstrap;
      await setupEncryption();
      enterApp();
      toast('Account created. Welcome to MCHART!');
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      setBusy('#signup-form', false);
    }
  }

  function startCodeCooldown(seconds) {
    clearInterval(codeResendTimer);
    var btn = $('#send-code-btn');
    var left = seconds;
    if (btn) { btn.disabled = true; btn.textContent = 'Resend in ' + left + 's'; }
    codeResendTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(codeResendTimer);
        codeResendTimer = null;
        if (btn) { btn.disabled = false; btn.textContent = 'Send verification code'; }
      } else if (btn) {
        btn.textContent = 'Resend in ' + left + 's';
      }
    }, 1000);
  }

  async function requestLoginCode() {
    var email = $('#code-email').value.trim().toLowerCase();
    var err = $('#code-error');
    var hint = $('#code-hint');
    var btn = $('#send-code-btn');
    err.textContent = '';

    if (!email) { err.textContent = 'Enter your email address first.'; return; }

    var oldLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending...';
    try {
      var data = await api('/api/auth/request-code', { method: 'POST', body: { email: email } });
      $('#code-input').value = '';
      $('#code-input').focus();
      if (data.devCode) {
        hint.innerHTML = 'Email is not configured on this server, so your code is shown here: ' +
          '<strong>' + esc(data.devCode) + '</strong> (valid for ' + data.ttlMinutes + ' minutes).';
      } else {
        hint.textContent = 'A verification code was sent to ' + email + '. It is valid for ' + data.ttlMinutes + ' minutes.';
      }
      toast('Verification code requested.');
      startCodeCooldown(30);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  }

  async function verifyLoginCode(e) {
    e.preventDefault();
    var email = $('#code-email').value.trim().toLowerCase();
    var code = $('#code-input').value.trim();
    var err = $('#code-error');
    err.textContent = '';

    if (!email) { err.textContent = 'Enter your email address.'; return; }
    if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code from your email.'; return; }

    setBusy('#code-form', true, 'Verifying...');
    try {
      var data = await api('/api/auth/verify-code', {
        method: 'POST',
        body: { email: email, code: code }
      });
      token = data.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch (e2) { /* ignore */ }
      state = data.bootstrap;
      await setupEncryption();
      enterApp();
      toast('Signed in with email verification.');
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      setBusy('#code-form', false);
    }
  }

  async function logout() {
    stopPolling();
    stopRealtime();
    try { if (token) await api('/api/auth/logout', { method: 'POST' }); } catch (ex) { /* ignore */ }
    clearToken();
    state = null;
    activeChatUserId = null;
    pendingAttachment = null;
    $('#login-password').value = '';
    $('#login-error').textContent = '';
    $('#app-screen').classList.add('hidden');
    $('#auth-screen').classList.remove('hidden');
    switchAuthTab('login');
    toast('You have been logged out.');
  }

  /* ---------------- Sidebar / navigation ---------------- */

  function renderSidebarBits() {
    var u = me();
    if (!u) return;
    setBadge($('#nav-msg-badge'), totalUnread());
    setBadge($('#nav-friend-badge'), state.requests.length);
    setBadge($('#nav-notif-badge'), state.notifications.filter(function (n) { return !n.read; }).length);
    setBadge($('#nav-story-badge'), (state.stories || []).filter(function (s) { return !s.mine && !s.viewed; }).length);

    var adminNav = $('#nav-admin');
    if (adminNav) adminNav.classList.toggle('hidden', u.role !== 'admin');

    $('#mini-profile').innerHTML =
      avatarHTML(u, 'sm') +
      '<span class="pm-info"><span class="pm-name">' + esc(u.name) + '</span>' +
      '<span class="pm-user">@' + esc(u.username) + '</span></span>';

    $('#top-avatar').innerHTML = avatarHTML(u, '');
  }

  function openSidebar() {
    $('#sidebar').classList.add('open');
    $('#backdrop').classList.add('show');
  }

  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#backdrop').classList.remove('show');
  }

  function setView(view) {
    if (!VIEW_TITLES[view]) view = 'dashboard';
    currentView = view;
    $$('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === view);
    });
    $$('.view').forEach(function (s) {
      s.classList.toggle('hidden', s.id !== 'view-' + view);
    });
    $('#view-title').textContent = VIEW_TITLES[view];

    if (view === 'dashboard') renderDashboard();
    else if (view === 'messages') renderMessages();
    else if (view === 'stories') renderStories();
    else if (view === 'reels') renderReels();
    else if (view === 'friends') renderFriends();
    else if (view === 'notifications') renderNotifications();
    else if (view === 'profile') renderProfile();
    else if (view === 'admin') renderAdmin();

    closeSidebar();
  }

  function renderAfterMutation() {
    if (currentView === 'dashboard') renderDashboard();
    else if (currentView === 'messages') { renderConvList(); if (activeChatUserId) renderChat(); }
    else if (currentView === 'stories') renderStories();
    else if (currentView === 'friends') renderFriends();
    else if (currentView === 'notifications') renderNotifications();
    else if (currentView === 'profile') renderProfile();
    else if (currentView === 'admin') renderAdmin();
  }

  /* ---------------- Dashboard ---------------- */

  function renderDashboard() {
    var u = me();
    if (!u) return;
    var hour = new Date().getHours();
    var greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    $('#dash-greeting').textContent = greet + ', ' + u.name.split(' ')[0];
    $('#dash-sub').textContent = "Here's what's happening with your conversations today.";

    var chatsWith = state.chats.filter(function (c) { return c.messages.length; });
    var stats = [
      { label: 'Active chats', value: chatsWith.length, icon: ICONS.chat },
      { label: 'Friends', value: state.friends.length, icon: ICONS.users },
      { label: 'Unread messages', value: totalUnread(), icon: ICONS.inbox },
      { label: 'Notifications', value: state.notifications.filter(function (n) { return !n.read; }).length, icon: ICONS.bell }
    ];
    $('#dash-stats').innerHTML = stats.map(function (s) {
      return '<div class="stat"><span class="stat-icon">' + s.icon + '</span>' +
        '<div class="stat-info"><span class="stat-value">' + s.value + '</span>' +
        '<span class="stat-label">' + s.label + '</span></div></div>';
    }).join('');

    var recent = chatsWith.slice().sort(function (a, b) {
      return new Date(lastMessage(b).time) - new Date(lastMessage(a).time);
    }).slice(0, 4);

    var rc = $('#dash-chats');
    if (!recent.length) {
      rc.innerHTML = '<div class="empty">No conversations yet. Start a new chat.</div>';
    } else {
      rc.innerHTML = recent.map(function (c) {
        var p = contact(c.userId);
        var lm = lastMessage(c);
        if (!p) return '';
        var unread = unreadCount(c);
        return '<button class="recent-item" type="button" data-action="open-chat" data-user="' + c.userId + '">' +
          '<span class="recent-avatar">' + avatarHTML(p) + (p.online ? '<i class="dot online"></i>' : '') + '</span>' +
          '<span class="recent-main"><span class="recent-top"><span class="recent-name">' + esc(p.name) + '</span>' +
          '<span class="recent-time">' + (lm ? fmtTime(lm.time) : '') + '</span></span>' +
          '<span class="recent-preview">' + esc(previewOf(lm)) + '</span></span>' +
          (unread ? '<span class="unread-dot"></span>' : '') +
          '</button>';
      }).join('');
    }

    var rq = $('#dash-requests');
    if (!state.requests.length) {
      rq.innerHTML = '<div class="empty">No pending requests.</div>';
    } else {
      rq.innerHTML = state.requests.slice(0, 3).map(function (r) {
        var p = contact(r.userId);
        if (!p) return '';
        return '<div class="request-row">' + avatarHTML(p, 'sm') +
          '<div class="request-info"><span class="request-name">' + esc(p.name) + '</span>' +
          '<span class="request-user">@' + esc(p.username) + '</span></div>' +
          '<div class="request-actions">' +
          '<button class="chip-btn accept" type="button" title="Accept" aria-label="Accept" data-action="accept-request" data-req="' + r.id + '">' + ICONS.check + '</button>' +
          '<button class="chip-btn decline" type="button" title="Decline" aria-label="Decline" data-action="decline-request" data-req="' + r.id + '">' + ICONS.x + '</button>' +
          '</div></div>';
      }).join('');
    }
  }

  /* ---------------- Messages ---------------- */

  function renderMessages() {
    renderConvList();
    renderChat();
  }

  function renderConvList() {
    var q = ($('#conv-search').value || '').trim().toLowerCase();
    var box = $('#conv-items');
    var chats = state.chats.filter(function (c) { return c.messages.length && contact(c.userId); });

    chats.sort(function (a, b) {
      return new Date(lastMessage(b).time) - new Date(lastMessage(a).time);
    });

    if (q) chats = chats.filter(function (c) { return matchPerson(contact(c.userId), q); });

    if (!chats.length) {
      box.innerHTML = '<div class="empty">' + (q ? 'No chats found.' : 'No conversations yet.') + '</div>';
      return;
    }

    box.innerHTML = chats.map(function (c) {
      var p = contact(c.userId);
      var lm = lastMessage(c);
      var unread = unreadCount(c);
      var preview = previewOf(lm);
      if (preview.length > 38) preview = preview.slice(0, 38) + '...';
      var tick = lm && lm.from === 'me' ? tickHTML(lm.read) : '';
      return '<button class="conv-item' + (activeChatUserId === c.userId ? ' active' : '') + '" type="button" data-action="open-chat" data-user="' + c.userId + '">' +
        '<span class="conv-avatar">' + avatarHTML(p) + (p.online ? '<i class="dot online"></i>' : '') + '</span>' +
        '<span class="conv-main"><span class="conv-top"><span class="conv-name">' + esc(p.name) + '</span>' +
        '<span class="conv-time">' + (lm ? fmtTime(lm.time) : '') + '</span></span>' +
        '<span class="conv-bottom"><span class="conv-preview">' + tick + esc(preview) + '</span>' +
        (unread ? '<span class="badge">' + unread + '</span>' : '') + '</span></span>' +
        '</button>';
    }).join('');
  }

  function renderChat() {
    var empty = $('#chat-empty');
    var inner = $('#chat-inner');
    var view = $('#view-messages');
    var person = activeChatUserId ? contact(activeChatUserId) : null;

    if (!person) {
      empty.classList.remove('hidden');
      inner.classList.add('hidden');
      view.classList.remove('chat-open');
      return;
    }

    empty.classList.add('hidden');
    inner.classList.remove('hidden');

    var callBtns = publicSettings.callsEnabled
      ? '<button class="icon-btn" type="button" data-action="start-audio-call" title="Audio call" aria-label="Audio call">' + ICONS.phone + '</button>' +
        '<button class="icon-btn" type="button" data-action="start-video-call" title="Video call" aria-label="Video call">' + ICONS.video + '</button>'
      : '';

    $('#chat-head').innerHTML =
      '<button class="icon-btn back-btn" type="button" data-action="back-chat" aria-label="Back">' + ICONS.arrowLeft + '</button>' +
      '<span class="chat-head-avatar">' + avatarHTML(person) + '</span>' +
      '<div class="chat-head-info"><strong>' + esc(person.name) + '</strong>' +
      '<span class="status ' + (person.online ? 'online' : '') + '" id="chat-status">' + (person.online ? 'Online' : 'Offline') + '</span></div>' +
      '<div class="chat-head-actions">' + callBtns +
      '<button class="icon-btn" type="button" data-action="clear-chat" title="Clear conversation" aria-label="Clear conversation">' + ICONS.trash + '</button>' +
      '</div>';

    var emojiPanel = $('#emoji-panel');
    if (emojiPanel) emojiPanel.classList.add('hidden');

    var chat = getChat(person.id);
    var body = $('#chat-body');
    if (!chat || !chat.messages.length) {
      body.innerHTML = '<div class="chat-start">Say hello to ' + esc(person.name) + '</div>';
    } else {
      body.innerHTML = chat.messages.map(msgHTML).join('');
    }

    renderAttachmentPreview();
    requestAnimationFrame(function () { body.scrollTop = body.scrollHeight; });
    view.classList.add('chat-open');
  }

  function msgHTML(m) {
    var mine = m.from === 'me';
    var content = '';
    var att = msgAttachment(m);
    var text = msgText(m);

    if (att) {
      /* New messages store media on the server (att.url); older messages
         keep their inline base64 payload (att.dataUrl). Both are playable. */
      var src = att.url || att.dataUrl || '';
      if (att.type && att.type.indexOf('image/') === 0 && src) {
        content += '<img class="msg-img" src="' + src + '" alt="' + esc(att.name) + '">';
      } else if (att.type && att.type.indexOf('video/') === 0 && src) {
        content += '<video class="msg-video" controls playsinline preload="metadata" src="' + src + '"></video>';
      } else if (att.type && att.type.indexOf('audio/') === 0 && src) {
        content += '<span class="voice-msg">' + ICONS.mic +
          '<audio class="msg-audio" controls preload="metadata" src="' + src + '"></audio></span>';
      } else {
        var chip = '<span class="file-chip">' + ICONS.file +
          '<span class="file-meta"><span class="file-name">' + esc(att.name) + '</span>' +
          '<span class="file-size">' + fmtSize(att.size) + '</span></span></span>';
        if (src) {
          chip = '<a class="file-chip" href="' + src + '" download="' + esc(att.name) + '" target="_blank" rel="noopener">' + ICONS.file +
            '<span class="file-meta"><span class="file-name">' + esc(att.name) + '</span>' +
            '<span class="file-size">' + fmtSize(att.size) + ' · download</span></span></a>';
        }
        content += chip;
      }
    }

    if (text) {
      content += '<span class="msg-text">' + esc(text).replace(/\n/g, '<br>') + '</span>';
    }

    var del = mine
      ? '<button class="msg-del" type="button" title="Delete message" aria-label="Delete message" data-action="delete-message" data-msg="' + esc(m.id) + '">' + ICONS.x + '</button>'
      : '';

    return '<div class="msg ' + (mine ? 'mine' : 'theirs') + '">' + del +
      '<div class="bubble">' + content +
      '<span class="msg-meta">' + (m.encrypted ? '<span class="ticks" title="End-to-end encrypted">' + ICONS.lock + '</span>' : '') +
      '<span class="msg-time">' + fmtTime(m.time) + '</span>' +
      (mine ? '<span class="ticks">' + tickHTML(m.read) + '</span>' : '') +
      '</span></div></div>';
  }

  function renderAttachmentPreview() {
    var box = $('#attach-preview');
    if (!pendingAttachment) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    var a = pendingAttachment;
    var isImage = a.type && a.type.indexOf('image/') === 0;
    var isVideo = a.type && a.type.indexOf('video/') === 0;
    var isAudio = a.type && a.type.indexOf('audio/') === 0;
    var thumb;
    if (isImage && a.dataUrl) {
      thumb = '<img src="' + a.dataUrl + '" alt="">';
    } else if (isVideo && a.dataUrl) {
      thumb = '<video class="ap-video" controls playsinline preload="metadata" src="' + a.dataUrl + '"></video>';
    } else if (isAudio) {
      thumb = '<span class="ap-icon">' + ICONS.mic + '</span>';
    } else {
      thumb = '<span class="ap-icon">' + ICONS.file + '</span>';
    }
    var playControls = '';
    if (isAudio && a.dataUrl) {
      /* Explicit Play / Preview control requested for voice messages */
      playControls = '<audio class="ap-audio" controls preload="metadata" src="' + a.dataUrl + '"></audio>';
    }
    var sendBtn = (isAudio || isVideo || isImage)
      ? '<button class="btn primary small" type="button" data-action="send-attachment" title="Send now" aria-label="Send now">' + ICONS.send + ' Send</button>'
      : '';
    box.innerHTML = thumb +
      '<span class="ap-name">' + esc(a.name) + '</span>' + playControls +
      '<span class="ap-actions">' + sendBtn +
      '<button class="chip-btn decline" type="button" data-action="clear-attachment" title="Delete" aria-label="Delete">' + ICONS.trash + '</button>' +
      '</span>';
  }

  function sendPendingAttachment() {
    var form = $('#chat-form');
    if (form) {
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event('submit'));
    }
  }

  function openChat(userId) {
    if (!contact(userId)) return;
    closeModal();
    activeChatUserId = userId;

    var chat = getChat(userId);
    if (chat) {
      chat.messages.forEach(function (m) { if (m.from !== 'me') m.read = true; });
    }
    renderSidebarBits();
    setView('messages');

    api('/api/chats/' + encodeURIComponent(userId) + '/read', { method: 'POST' }).catch(function () { /* ignore */ });
  }

  function setChatStatus(typing) {
    var el = $('#chat-status');
    var person = activeChatUserId ? contact(activeChatUserId) : null;
    if (!el || !person) return;
    if (typing) {
      el.textContent = 'typing...';
      el.className = 'status typing';
    } else {
      el.textContent = person.online ? 'Online' : 'Offline';
      el.className = 'status' + (person.online ? ' online' : '');
    }
  }

  function sendTyping(typing) {
    if (!activeChatUserId) return;
    api('/api/chats/' + encodeURIComponent(activeChatUserId) + '/typing', {
      method: 'POST',
      body: { typing: typing }
    }).catch(function () { /* ignore */ });
  }

  function handleTypingInput() {
    if (!activeChatUserId) return;
    var now = Date.now();
    if (now - typingSentAt > 1200) {
      typingSentAt = now;
      sendTyping(true);
    }
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(function () {
      typingSentAt = 0;
      sendTyping(false);
    }, 2200);
  }

  async function deleteMessage(messageId) {
    var userId = activeChatUserId;
    if (!userId || !messageId) return;
    try {
      state = await api('/api/chats/' + encodeURIComponent(userId) + '/messages/' + encodeURIComponent(messageId), { method: 'DELETE' });
      renderSidebarBits();
      renderConvList();
      renderChat();
      toast('Message deleted.');
    } catch (ex) {
      toast(ex.message);
    }
  }

  async function clearChat() {
    var userId = activeChatUserId;
    if (!userId) return;
    var person = contact(userId);
    var label = person ? person.name : 'this person';
    if (!window.confirm('Clear the entire conversation with ' + label + '? This cannot be undone.')) return;
    try {
      state = await api('/api/chats/' + encodeURIComponent(userId), { method: 'DELETE' });
      renderSidebarBits();
      renderConvList();
      renderChat();
      toast('Conversation cleared.');
    } catch (ex) {
      toast(ex.message);
    }
  }

  async function sendMessage(e) {
    e.preventDefault();
    if (!activeChatUserId) return;
    var input = $('#message-input');
    var text = input.value.trim();
    if (!text && !pendingAttachment) return;

    var attachment = pendingAttachment;
    var userId = activeChatUserId;

    input.value = '';
    pendingAttachment = null;
    $('#file-input').value = '';
    renderAttachmentPreview();
    clearTimeout(typingStopTimer);
    typingSentAt = 0;
    sendTyping(false);

    try {
      var payload = { text: text, attachment: attachment };
      var body = { text: text, attachment: attachment };

      /* Files are sent as plain attachments; only text-only messages are encrypted. */
      if (!attachment && canEncrypt(userId)) {
        try {
          var enc = await encryptPayload(userId, payload);
          if (enc) body = { encrypted: true, text: enc.text, nonce: enc.nonce };
        } catch (e) {
          body = { text: text, attachment: attachment };
        }
      }

      var data = await api('/api/chats/' + encodeURIComponent(userId) + '/messages', {
        method: 'POST',
        body: body
      });
      state = data;
      renderSidebarBits();
      renderConvList();
      if (activeChatUserId === userId) renderChat();
    } catch (ex) {
      toast(ex.message);
      input.value = text;
      pendingAttachment = attachment;
      renderAttachmentPreview();
    }
  }

  function handleFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';

    var type = file.type || 'application/octet-stream';
    var limitMb = 5;
    if (type.indexOf('video/') === 0) limitMb = 15;
    else if (type.indexOf('audio/') === 0) limitMb = 8;
    if (file.size > limitMb * 1024 * 1024) {
      toast('File is too large. Please choose a ' + type.split('/')[0] + ' under ' + limitMb + ' MB.');
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      pendingAttachment = {
        name: file.name,
        size: file.size,
        type: type,
        dataUrl: reader.result
      };
      renderAttachmentPreview();
      toast('File ready to send (sent unencrypted).');
    };
    reader.readAsDataURL(file);
  }

  /* ---------------- Stories ---------------- */

  var STORY_COLORS = ['#6366f1', '#8b5cf6', '#db2777', '#0d9488', '#f59e0b', '#e11d48', '#2563eb', '#111827'];

  function orderedStories() {
    return (state && state.stories ? state.stories : []).slice().sort(function (a, b) {
      if (!!a.mine !== !!b.mine) return a.mine ? -1 : 1;
      return new Date(b.time) - new Date(a.time);
    });
  }

  function renderStories() {
    if (!state) return;

    var composeAvatar = $('#story-compose-avatar');
    if (composeAvatar) composeAvatar.innerHTML = avatarHTML(me(), 'sm');

    renderStoryColors();
    renderStoryPreview();

    var feed = $('#story-feed');
    if (!feed) return;

    var stories = orderedStories();
    if (!stories.length) {
      feed.innerHTML = '<div class="story-empty">No stories yet. Be the first to share something!</div>';
      return;
    }

    feed.innerHTML = stories.map(function (s, i) {
      var author = s.author || contact(s.userId) || { name: 'Someone', color: '#8b5cf6' };
      var media = '';
      if (s.mediaData) {
        if (s.mediaType && s.mediaType.indexOf('video/') === 0) {
          media = '<video class="story-card-media" src="' + s.mediaData + '" muted playsinline preload="metadata"></video>';
        } else {
          media = '<img class="story-card-media" src="' + s.mediaData + '" alt="">';
        }
      }
      var shade = media ? '<span class="story-card-shade"></span>' : '';
      var bg = media ? '' : ' style="background:' + esc(s.background || '#6366f1') + '"';
      var badge = s.mine ? '<span class="story-card-badge">Your story</span>' : '';
      var actions = s.mine
        ? '<div class="story-card-actions"><button class="icon-btn" type="button" title="Delete story" aria-label="Delete story" data-action="delete-story" data-story="' + esc(s.id) + '">' + ICONS.trash + '</button></div>'
        : '';
      var foot = fmtRelative(s.time) + ' · ' + (s.mine
        ? s.views + ' view' + (s.views === 1 ? '' : 's')
        : (s.viewed ? 'Seen' : 'New'));

      return '<div class="story-card" role="button" tabindex="0" data-action="open-story" data-index="' + i + '"' + bg + '>' +
        media + shade + badge + actions +
        '<div class="story-card-content">' +
          '<div class="story-card-author">' + avatarHTML(author) +
            '<span class="story-card-name">' + esc(s.mine ? 'You' : author.name) + '</span>' +
          '</div>' +
          (s.text ? '<span class="story-card-text">' + esc(s.text) + '</span>' : '') +
          '<span class="story-card-time">' + foot + '</span>' +
        '</div></div>';
    }).join('');
  }

  function renderStoryColors() {
    var box = $('#story-colors');
    if (!box) return;
    box.innerHTML = STORY_COLORS.map(function (c) {
      return '<button type="button" class="story-color' + (c === storyBackground ? ' active' : '') + '" ' +
        'data-action="story-color" data-color="' + c + '" style="background:' + c + '" ' +
        'aria-label="Story background ' + c + '"></button>';
    }).join('');
  }

  function renderStoryPreview() {
    var box = $('#story-preview');
    if (!box) return;
    if (!pendingStoryMedia) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    var m = pendingStoryMedia;
    var thumb = (m.type && m.type.indexOf('video/') === 0)
      ? '<video src="' + m.dataUrl + '" muted playsinline preload="metadata"></video>'
      : '<img src="' + m.dataUrl + '" alt="">';
    box.innerHTML = thumb + '<span class="ap-name">' + esc(m.name) + '</span>' +
      '<button class="chip-btn decline" type="button" data-action="clear-story-media" aria-label="Remove media">' + ICONS.x + '</button>';
  }

  function handleStoryFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    if (!file.type || (file.type.indexOf('image/') !== 0 && file.type.indexOf('video/') !== 0)) {
      toast('Choose an image or video for your story.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast('Story media must be 5 MB or smaller.');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      pendingStoryMedia = { name: file.name, type: file.type, dataUrl: reader.result };
      renderStoryPreview();
    };
    reader.readAsDataURL(file);
  }

  async function shareStory(e) {
    e.preventDefault();
    var textEl = $('#story-text');
    var text = textEl ? textEl.value.trim() : '';
    if (!text && !pendingStoryMedia) {
      toast('Add some text or media to your story first.');
      return;
    }

    var body = { text: text, background: storyBackground };
    if (pendingStoryMedia) {
      body.mediaType = pendingStoryMedia.type;
      body.mediaData = pendingStoryMedia.dataUrl;
    }

    try {
      var data = await api('/api/stories', { method: 'POST', body: body });
      state = data;
      if (textEl) textEl.value = '';
      pendingStoryMedia = null;
      renderStoryPreview();
      renderStories();
      renderSidebarBits();
      toast('Story shared! It will disappear in 24 hours.');
    } catch (ex) {
      toast(ex.message);
    }
  }

  async function deleteStory(id) {
    if (!id) return;
    if (!window.confirm('Delete this story?')) return;
    try {
      state = await api('/api/stories/' + encodeURIComponent(id), { method: 'DELETE' });
      renderStories();
      toast('Story deleted.');
    } catch (ex) {
      toast(ex.message);
    }
  }

  function openStoryViewer(index) {
    var list = orderedStories();
    if (!list.length) return;
    storyViewIndex = Math.max(0, Math.min(Number(index) || 0, list.length - 1));
    var viewer = $('#story-viewer');
    if (!viewer) return;
    viewer.classList.remove('hidden');
    renderStoryViewer();
  }

  function renderStoryViewer() {
    var list = orderedStories();
    if (!list.length) { closeStoryViewer(); return; }
    if (storyViewIndex >= list.length) { closeStoryViewer(); return; }
    if (storyViewIndex < 0) storyViewIndex = 0;

    var s = list[storyViewIndex];
    var author = s.author || contact(s.userId) || { name: 'Someone', color: '#8b5cf6' };

    var authorBox = $('#story-viewer-author');
    if (authorBox) {
      authorBox.innerHTML = avatarHTML(author, 'sm') +
        '<span>' + esc(s.mine ? 'Your story' : author.name) + '</span>';
    }

    var progress = $('#story-progress');
    if (progress) {
      progress.innerHTML = list.map(function (_, i) {
        var cls = i < storyViewIndex ? 'done' : (i === storyViewIndex ? 'active' : '');
        return '<i class="' + cls + '"><span></span></i>';
      }).join('');
    }

    var body = $('#story-viewer-body');
    if (body) {
      body.style.background = s.background || '#6366f1';
      var media = '';
      if (s.mediaData) {
        media = (s.mediaType && s.mediaType.indexOf('video/') === 0)
          ? '<video src="' + s.mediaData + '" controls autoplay playsinline></video>'
          : '<img src="' + s.mediaData + '" alt="">';
      }
      body.innerHTML = media + (s.text
        ? '<div class="story-text-overlay">' + esc(s.text).replace(/\n/g, '<br>') + '</div>'
        : '');
    }

    var foot = $('#story-viewer-foot');
    if (foot) {
      foot.innerHTML = '<span>' + fmtRelative(s.time) + '</span><span>' +
        (s.mine
          ? s.views + ' view' + (s.views === 1 ? '' : 's')
          : 'Story ' + (storyViewIndex + 1) + ' of ' + list.length) +
        '</span>';
    }

    if (!s.mine) {
      s.viewed = true;
      api('/api/stories/' + encodeURIComponent(s.id) + '/view', { method: 'POST' })
        .catch(function () { /* ignore */ });
    }

    clearTimeout(storyTimer);
    storyTimer = setTimeout(function () { nextStory(); }, 6000);
  }

  function nextStory() {
    var list = orderedStories();
    if (storyViewIndex + 1 < list.length) {
      storyViewIndex += 1;
      renderStoryViewer();
    } else {
      closeStoryViewer();
    }
  }

  function prevStory() {
    if (storyViewIndex > 0) {
      storyViewIndex -= 1;
      renderStoryViewer();
    }
  }

  function closeStoryViewer() {
    clearTimeout(storyTimer);
    storyTimer = null;
    storyViewIndex = -1;
    var viewer = $('#story-viewer');
    if (viewer) viewer.classList.add('hidden');
    var body = $('#story-viewer-body');
    if (body) body.innerHTML = '';
  }

  /* ---------------- Reels ---------------- */

  async function loadReels() {
    try {
      var data = await api('/api/reels');
      reelState.list = data.reels || [];
      reelState.loaded = true;
    } catch (ex) {
      toast(ex.message);
      return;
    }
    if (currentView === 'reels') renderReels();
  }

  function teardownReelObserver() {
    if (reelState.observer) {
      try { reelState.observer.disconnect(); } catch (e) { /* ignore */ }
      reelState.observer = null;
    }
  }

  function setupReelObserver() {
    teardownReelObserver();
    if (!('IntersectionObserver' in window)) return;
    reelState.observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var video = entry.target.querySelector('.reel-video');
        if (!video) return;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          video.play().catch(function () { /* autoplay guard */ });
          var id = entry.target.getAttribute('data-reel');
          if (id && !reelState.viewed[id]) {
            reelState.viewed[id] = true;
            api('/api/reels/' + encodeURIComponent(id) + '/view', { method: 'POST' })
              .catch(function () { /* ignore */ });
            var r = reelState.list.filter(function (x) { return x.id === id; })[0];
            if (r) r.views = (r.views || 0) + 1;
          }
        } else {
          video.pause();
        }
      });
    }, { threshold: [0.6] });
    $$('#reels-feed .reel-card').forEach(function (card) {
      reelState.observer.observe(card);
    });
  }

  function renderReels() {
    var feed = $('#reels-feed');
    if (!feed) return;
    if (!reelState.loaded) { loadReels(); return; }

    if (!reelState.list.length) {
      feed.innerHTML = '<div class="empty">No reels yet. Tap "New reel" to share the first short video!</div>';
      teardownReelObserver();
      return;
    }

    feed.innerHTML = reelState.list.map(reelCardHTML).join('');
    setupReelObserver();
  }

  function reelCardHTML(r) {
    return '<div class="reel-card" data-reel="' + esc(r.id) + '">' +
      '<video class="reel-video" src="' + esc(r.url) + '" loop muted playsinline preload="metadata"></video>' +
      '<button class="reel-tap" type="button" data-action="reel-toggle-sound" data-reel="' + esc(r.id) + '" aria-label="Toggle sound"></button>' +
      '<div class="reel-side">' +
      '<button class="reel-side-btn like' + (r.liked ? ' liked' : '') + '" type="button" data-action="reel-like" data-reel="' + esc(r.id) + '" aria-label="Like">' +
      ICONS.heart + '<span class="reel-count">' + (r.likes || 0) + '</span></button>' +
      '<div class="reel-side-btn views">' + ICONS.play + '<span class="reel-count">' + (r.views || 0) + '</span></div>' +
      (r.mine ? '<button class="reel-side-btn del" type="button" data-action="reel-delete" data-reel="' + esc(r.id) + '" aria-label="Delete reel">' + ICONS.trash + '</button>' : '') +
      '</div>' +
      '<div class="reel-info">' +
      '<div class="reel-author">' + avatarHTML(r.author, 'sm') +
      '<span class="reel-author-name">' + esc(r.author.name) + '</span></div>' +
      (r.caption ? '<p class="reel-caption">' + esc(r.caption) + '</p>' : '') +
      '<span class="reel-time">' + fmtRelative(r.time) + '</span>' +
      '</div></div>';
  }

  async function likeReel(id) {
    var r = reelState.list.filter(function (x) { return x.id === id; })[0];
    try {
      var res = await api('/api/reels/' + encodeURIComponent(id) + '/like', { method: 'POST' });
      if (r) { r.liked = res.liked; r.likes = res.likes; }
      var btn = $('#reels-feed .reel-side-btn.like[data-reel="' + id + '"]');
      if (btn) {
        btn.classList.toggle('liked', !!res.liked);
        var count = btn.querySelector('.reel-count');
        if (count) count.textContent = res.likes;
      }
    } catch (ex) { toast(ex.message); }
  }

  async function deleteReel(id) {
    if (!window.confirm('Delete this reel?')) return;
    try {
      await api('/api/reels/' + encodeURIComponent(id), { method: 'DELETE' });
      reelState.list = reelState.list.filter(function (x) { return x.id !== id; });
      renderReels();
      toast('Reel deleted.');
    } catch (ex) { toast(ex.message); }
  }

  function toggleReelSound(id) {
    var card = $('#reels-feed .reel-card[data-reel="' + id + '"]');
    var video = card ? card.querySelector('.reel-video') : null;
    if (!video) return;
    video.muted = !video.muted;
    toast(video.muted ? 'Reel muted' : 'Reel sound on');
  }

  function openReelComposer() {
    pendingReelMedia = null;
    openModal('New reel',
      '<form id="reel-form" class="form-grid" novalidate>' +
      '<p class="muted">Short vertical videos — up to 15 MB.</p>' +
      '<div class="reel-compose-source">' +
      '<input type="file" id="reel-file" accept="video/*" hidden>' +
      '<button type="button" class="btn ghost" data-action="reel-choose-file">' + ICONS.image + ' Choose video</button>' +
      '<button type="button" class="btn ghost" data-action="reel-record">' + ICONS.video + ' Record with camera</button>' +
      '</div>' +
      '<div class="reel-compose-preview hidden" id="reel-compose-preview"></div>' +
      '<label class="field"><span>Caption</span>' +
      '<textarea id="reel-caption" maxlength="500" rows="2" placeholder="Say something about this reel..."></textarea></label>' +
      '<p class="form-error" id="reel-error"></p>' +
      '<div class="admin-modal-actions">' +
      '<button type="button" class="btn ghost" data-action="close-modal">Cancel</button>' +
      '<button type="submit" class="btn primary">Share reel</button>' +
      '</div></form>');
  }

  function renderReelComposePreview() {
    var box = $('#reel-compose-preview');
    if (!box) return;
    if (!pendingReelMedia) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = '<video controls playsinline preload="metadata" src="' + pendingReelMedia.dataUrl + '"></video>' +
      '<button class="chip-btn decline" type="button" data-action="reel-clear-media" aria-label="Remove video">' + ICONS.x + '</button>';
  }

  function handleReelFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = '';
    if (!file.type || file.type.indexOf('video/') !== 0) {
      toast('Choose a video file for your reel.');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast('Reel videos must be 15 MB or smaller.');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      pendingReelMedia = { dataUrl: reader.result, type: file.type, size: file.size, name: file.name };
      renderReelComposePreview();
    };
    reader.readAsDataURL(file);
  }

  function recordReelWithCamera() {
    openCameraCapture({
      mode: 'video',
      title: 'Record a reel',
      onConfirm: function (rec) {
        pendingReelMedia = { dataUrl: rec.dataUrl, type: rec.type, size: rec.size || 0, name: rec.name || 'reel.webm' };
        openReelComposer();
        renderReelComposePreview();
      }
    });
  }

  async function shareReel(e) {
    e.preventDefault();
    var err = $('#reel-error');
    if (err) err.textContent = '';
    var caption = $('#reel-caption') ? $('#reel-caption').value.trim() : '';

    if (!pendingReelMedia) {
      if (err) err.textContent = 'Add a video first.';
      else toast('Add a video first.');
      return;
    }

    var submitBtn = $('#reel-form button[type="submit"]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sharing...'; }

    try {
      await api('/api/reels', {
        method: 'POST',
        body: { caption: caption, mediaData: pendingReelMedia.dataUrl }
      });
      pendingReelMedia = null;
      closeModal();
      toast('Reel shared!');
      reelState.loaded = false; /* force a fresh fetch on render */
      setView('reels');
    } catch (ex) {
      if (err) err.textContent = ex.message;
      else toast(ex.message);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Share reel'; }
    }
  }

  /* ---------------- Emoji picker ---------------- */

  var EMOJIS = [
    '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
    '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚',
    '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🥳',
    '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫',
    '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤗', '🤔',
    '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦',
    '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴',
    '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿',
    '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '👏', '🙌', '👐',
    '🙏', '🤝', '💪', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤',
    '🔥', '✨', '🎉', '🎊', '💯', '✅', '❌', '⭐', '🌟', '💬'
  ];

  function toggleEmojiPanel() {
    var panel = $('#emoji-panel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) {
      if (!panel.dataset.ready) {
        panel.innerHTML = EMOJIS.map(function (e) {
          return '<button type="button" class="emoji-item" data-action="emoji-pick" data-emoji="' + e + '">' + e + '</button>';
        }).join('');
        panel.dataset.ready = '1';
      }
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  }

  function insertEmoji(emoji) {
    var input = $('#message-input');
    if (!input) return;
    var start = input.selectionStart == null ? input.value.length : input.selectionStart;
    var end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    var pos = start + emoji.length;
    input.focus();
    try { input.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
  }

  /* ---------------- Voice recording ---------------- */

  function setRecordingUI(on) {
    isRecording = on;
    var btn = $('#record-btn');
    if (btn) {
      btn.classList.toggle('recording', on);
      btn.title = on ? 'Stop recording' : 'Record voice message';
      btn.setAttribute('aria-label', on ? 'Stop recording' : 'Record voice message');
    }
    clearInterval(recordingTimer);
    recordingTimer = null;
    var timerEl = $('#recording-timer');
    if (timerEl) timerEl.classList.toggle('hidden', !on);
    if (on) {
      recordingStartedAt = Date.now();
      updateRecordingTimer();
      recordingTimer = setInterval(updateRecordingTimer, 500);
    }
  }

  function updateRecordingTimer() {
    var el = $('#recording-timer');
    if (!el) return;
    var seconds = Math.max(0, Math.floor((Date.now() - recordingStartedAt) / 1000));
    var mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    var ss = String(seconds % 60).padStart(2, '0');
    el.textContent = mm + ':' + ss + ' / 01:00';
  }

  function pickAudioMime() {
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    if (!window.MediaRecorder || !window.MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return '';
  }

  /* WebM/Opus in Chrome & Firefox, MP4 in Safari. */
  function audioExtForMime(mime) {
    if (mime && mime.indexOf('mp4') !== -1) return 'm4a';
    if (mime && mime.indexOf('ogg') !== -1) return 'ogg';
    return 'webm';
  }

  function stopRecording() {
    clearTimeout(recordingStopTimer);
    recordingStopTimer = null;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch (e) { /* ignore */ }
    }
  }

  async function toggleRecording() {
    if (isRecording) { stopRecording(); return; }
    if (recordingBusy) return;
    if (!activeChatUserId) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('Voice recording is not supported in this browser.');
      return;
    }

    /* Guard against a second click while the microphone permission
       prompt is still open (this previously aborted recordings early). */
    recordingBusy = true;

    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      recordingBusy = false;
      toast('Microphone access was denied.');
      return;
    }

    var mime = pickAudioMime();
    try {
      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (e) {
      recordingBusy = false;
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e2) { /* ignore */ } });
      toast('Could not start recording.');
      return;
    }
    recordingBusy = false;

    recordedChunks = [];
    mediaRecorder.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) recordedChunks.push(ev.data);
    };
    mediaRecorder.onerror = function () {
      toast('Recording was interrupted.');
      stopRecording();
    };
    mediaRecorder.onstop = function () {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e2) { /* ignore */ } });
      setRecordingUI(false);
      clearTimeout(recordingStopTimer);
      recordingStopTimer = null;

      var blob = new Blob(recordedChunks, { type: (mime ? mime.split(';')[0] : 'audio/webm') });
      recordedChunks = [];
      mediaRecorder = null;

      if (!blob.size) { toast('No audio was recorded.'); return; }
      if (blob.size > 8 * 1024 * 1024) {
        toast('Recording is too long. Please keep it under about 60 seconds.');
        return;
      }

      var reader = new FileReader();
      reader.onload = function () {
        var stamp = new Date().toLocaleTimeString();
        var ext = audioExtForMime(blob.type || mime);
        pendingAttachment = {
          name: 'Voice message ' + stamp + '.' + ext,
          size: blob.size,
          type: blob.type || 'audio/webm',
          dataUrl: reader.result
        };
        renderAttachmentPreview();
        toast('Voice message ready — play it to preview, then send.');
      };
      reader.readAsDataURL(blob);
    };

    /* timeslice keeps chunks flowing every second — this makes stop()
       reliable even for very short recordings (fixes 1-second cutoffs). */
    mediaRecorder.start(1000);
    setRecordingUI(true);
    toast('Recording... press the mic button again to stop.');
    recordingStopTimer = setTimeout(stopRecording, 60000);
  }

  /* ---------------- Camera capture (photo / video) ---------------- */

  function stopCameraStream() {
    if (cameraCapture && cameraCapture.stream) {
      cameraCapture.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
    }
  }

  function closeCameraCapture() {
    stopCameraStream();
    if (cameraCapture && cameraCapture.recorder && cameraCapture.recorder.state !== 'inactive') {
      try { cameraCapture.recorder.stop(); } catch (e) { /* ignore */ }
    }
    cameraCapture = null;
    closeModal();
  }

  function pickVideoMime() {
    var types = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    if (!window.MediaRecorder || !window.MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < types.length; i++) {
      if (MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return '';
  }

  async function openCameraCapture(options) {
    /* options: { mode: 'photo'|'video', title, confirmLabel, onConfirm({dataUrl,type,size,name}) } */
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Camera capture is not supported in this browser.');
      return;
    }

    var wantAudio = options.mode === 'video';
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: wantAudio
      });
    } catch (e) {
      toast(wantAudio ? 'Could not access your camera and microphone.' : 'Could not access your camera.');
      return;
    }

    cameraCapture = { mode: options.mode, stream: stream, recorder: null, chunks: [], recorded: null, onConfirm: options.onConfirm, reopen: options };

    var controls = options.mode === 'photo'
      ? '<button class="btn primary" type="button" data-action="cam-capture">' + ICONS.camera + ' Capture photo</button>'
      : '<button class="btn primary" type="button" data-action="cam-toggle-record" id="cam-record-btn">' + ICONS.video + ' Start recording</button>';

    openModal(options.title || 'Camera',
      '<div class="cam-wrap">' +
      '<video id="cam-video" class="cam-video" autoplay playsinline muted></video>' +
      '<div class="cam-controls">' + controls +
      '<button class="btn ghost" type="button" data-action="cam-cancel">Cancel</button>' +
      '</div></div>');

    var video = $('#cam-video');
    if (video) video.srcObject = stream;
  }

  function capturePhotoFromCamera() {
    if (!cameraCapture || !cameraCapture.stream) return;
    var video = $('#cam-video');
    if (!video) return;

    var canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 720;
    canvas.height = video.videoHeight || 540;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    var dataUrl = canvas.toDataURL('image/jpeg', 0.9);

    stopCameraStream();
    cameraCapture.recorded = { dataUrl: dataUrl, type: 'image/jpeg', name: 'Camera photo ' + new Date().toLocaleTimeString() + '.jpg' };

    openModal('Photo captured',
      '<div class="cam-wrap">' +
      '<img class="cam-preview" src="' + dataUrl + '" alt="Captured photo">' +
      '<div class="cam-controls">' +
      '<button class="btn primary" type="button" data-action="cam-confirm">' + ICONS.check + ' Use photo</button>' +
      '<button class="btn ghost" type="button" data-action="cam-retake">' + ICONS.refresh + ' Retake</button>' +
      '</div></div>');
  }

  function toggleCameraRecording() {
    if (!cameraCapture || !cameraCapture.stream) return;
    var btn = $('#cam-record-btn');

    if (!cameraCapture.recorder) {
      var mime = pickVideoMime();
      var recorder;
      try {
        recorder = mime ? new MediaRecorder(cameraCapture.stream, { mimeType: mime }) : new MediaRecorder(cameraCapture.stream);
      } catch (e) {
        toast('Could not start video recording.');
        return;
      }
      cameraCapture.recorder = recorder;
      cameraCapture.chunks = [];
      cameraCapture.recordStartedAt = Date.now();

      recorder.ondataavailable = function (ev) {
        if (ev.data && ev.data.size) cameraCapture.chunks.push(ev.data);
      };
      recorder.onstop = function () {
        if (!cameraCapture) return; /* modal was closed — discard */
        var blob = new Blob(cameraCapture.chunks, { type: (mime ? mime.split(';')[0] : 'video/webm') });
        cameraCapture.chunks = [];
        cameraCapture.recorder = null;
        if (!blob.size) { toast('No video was recorded.'); return; }
        if (blob.size > 15 * 1024 * 1024) { toast('Video is too large (max 15 MB).'); return; }

        var reader = new FileReader();
        reader.onload = function () {
          stopCameraStream();
          cameraCapture.recorded = { dataUrl: reader.result, type: blob.type, size: blob.size };
          var ext = blob.type.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
          cameraCapture.recorded.name = 'Camera video ' + new Date().toLocaleTimeString() + '.' + ext;

          openModal('Video recorded',
            '<div class="cam-wrap">' +
            '<video class="cam-preview" controls playsinline src="' + reader.result + '"></video>' +
            '<div class="cam-controls">' +
            '<button class="btn primary" type="button" data-action="cam-confirm">' + ICONS.check + ' Use video</button>' +
            '<button class="btn ghost" type="button" data-action="cam-retake">' + ICONS.refresh + ' Retake</button>' +
            '</div></div>');
        };
        reader.readAsDataURL(blob);
      };

      recorder.start(1000);
      if (btn) btn.innerHTML = ICONS.phoneOff + ' Stop recording';
      toast('Recording video...');
      cameraCapture.recordTimer = setTimeout(function () { toggleCameraRecording(); }, 180000); /* 3 min max */
      return;
    }

    /* stop */
    clearTimeout(cameraCapture.recordTimer);
    var rec = cameraCapture.recorder;
    cameraCapture.recorder = null;
    try { rec.stop(); } catch (e) { /* ignore */ }
    if (btn) btn.innerHTML = 'Processing...';
  }

  function confirmCameraCapture() {
    if (!cameraCapture || !cameraCapture.recorded || !cameraCapture.onConfirm) {
      closeCameraCapture();
      return;
    }
    var rec = cameraCapture.recorded;
    var cb = cameraCapture.onConfirm;
    stopCameraStream();
    cameraCapture = null;
    closeModal();
    cb(rec);
  }

  function retakeCameraCapture() {
    var options = cameraCapture ? cameraCapture.reopen : null;
    closeCameraCapture();
    if (options) openCameraCapture(options);
  }

  /* ---------------- Audio / video calls (WebRTC) ---------------- */

  function callSupported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /* -------- ringtone, duration and ringing timeout -------- */

  var RING_TIMEOUT_MS = 45000;
  var ringtoneCtx = null;
  var ringtoneTimer = null;
  var callDurationTimer = null;
  var ringingTimeoutTimer = null;

  /* Simple WebAudio ringtone — works offline, no assets needed. */
  function startRingtone(fast) {
    stopRingtone();
    try {
      ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { ringtoneCtx = null; return; }
    var pattern = fast
      ? [0, 250, 500, 750]
      : [0, 600];
    var play = function () {
      pattern.forEach(function (offset) {
        [880, 660].forEach(function (freq, i) {
          var osc = ringtoneCtx.createOscillator();
          var gain = ringtoneCtx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0, ringtoneCtx.currentTime + (offset + i * 0.12) / 1000);
          gain.gain.linearRampToValueAtTime(0.12, ringtoneCtx.currentTime + (offset + i * 0.12 + 20) / 1000);
          gain.gain.linearRampToValueAtTime(0, ringtoneCtx.currentTime + (offset + i * 0.12 + 160) / 1000);
          osc.connect(gain);
          gain.connect(ringtoneCtx.destination);
          osc.start(ringtoneCtx.currentTime + (offset + i * 0.12) / 1000);
          osc.stop(ringtoneCtx.currentTime + (offset + i * 0.12 + 200) / 1000);
        });
      });
    };
    play();
    ringtoneTimer = setInterval(play, fast ? 2000 : 3000);
    if (navigator.vibrate) {
      try { navigator.vibrate(fast ? [200, 100, 200] : [400, 200, 400]); } catch (e) { /* ignore */ }
    }
  }

  function stopRingtone() {
    clearInterval(ringtoneTimer);
    ringtoneTimer = null;
    if (ringtoneCtx) {
      try { ringtoneCtx.close(); } catch (e) { /* ignore */ }
      ringtoneCtx = null;
    }
    if (navigator.vibrate) {
      try { navigator.vibrate(0); } catch (e) { /* ignore */ }
    }
  }

  function startCallDuration() {
    stopCallDuration();
    var startedAt = Date.now();
    callDurationTimer = setInterval(function () {
      var seconds = Math.floor((Date.now() - startedAt) / 1000);
      var mm = String(Math.floor(seconds / 60)).padStart(2, '0');
      var ss = String(seconds % 60).padStart(2, '0');
      var el = $('#call-status');
      if (el) el.textContent = 'Connected · ' + mm + ':' + ss;
    }, 1000);
  }

  function stopCallDuration() {
    clearInterval(callDurationTimer);
    callDurationTimer = null;
  }

  /* Nobody picked up within RING_TIMEOUT_MS → hang up automatically. */
  function startRingingTimeout() {
    clearTimeout(ringingTimeoutTimer);
    ringingTimeoutTimer = setTimeout(function () {
      if (callState && callState.role === 'caller') {
        toast('No answer.');
        endCall();
      }
    }, RING_TIMEOUT_MS);
  }

  function stopRingingTimeout() {
    clearTimeout(ringingTimeoutTimer);
    ringingTimeoutTimer = null;
  }

  function setCallStatus(text) {
    var el = $('#call-status');
    if (el) el.textContent = text;
  }

  function showCallOverlay(person, kind, status, mode) {
    var overlay = $('#call-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    overlay.classList.toggle('video-mode', kind === 'video');
    overlay.classList.toggle('incoming-mode', mode === 'incoming');

    var nameEl = $('#call-name');
    if (nameEl) nameEl.textContent = person ? person.name : 'Call';
    setCallStatus(status || '');

    var av = $('#call-avatar');
    if (av) av.innerHTML = person ? avatarHTML(person, 'xl') : '';

    var remote = $('#call-remote');
    if (remote) remote.classList.toggle('hidden', kind !== 'video');
    var local = $('#call-local');
    if (local) local.classList.toggle('hidden', kind !== 'video');

    var actions = $('#call-actions');
    if (!actions) return;
    if (mode === 'incoming') {
      actions.innerHTML =
        '<button class="call-btn decline" type="button" data-action="call-decline" aria-label="Decline">' + ICONS.phoneOff + '</button>' +
        '<button class="call-btn accept" type="button" data-action="call-accept" aria-label="Accept">' +
        (kind === 'video' ? ICONS.video : ICONS.phone) + '</button>';
    } else {
      actions.innerHTML =
        '<button class="call-btn" type="button" data-action="call-mute" id="call-mute-btn" title="Mute" aria-label="Mute">' + ICONS.mic + '</button>' +
        (kind === 'video'
          ? '<button class="call-btn" type="button" data-action="call-camera" id="call-camera-btn" title="Camera" aria-label="Camera">' + ICONS.video + '</button>'
          : '') +
        '<button class="call-btn decline" type="button" data-action="call-end" title="End call" aria-label="End call">' + ICONS.phoneOff + '</button>';
    }
  }

  function hideCallOverlay() {
    var overlay = $('#call-overlay');
    if (overlay) overlay.classList.add('hidden');
    var actions = $('#call-actions');
    if (actions) actions.innerHTML = '';
  }

  function cleanupCall() {
    stopRingtone();
    stopCallDuration();
    stopRingingTimeout();
    if (callState) {
      if (callState.localStream) {
        callState.localStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
      }
      if (callState.pc) {
        try { callState.pc.onicecandidate = null; callState.pc.close(); } catch (e) { /* ignore */ }
      }
    }
    callState = null;
    incomingCall = null;
    var local = $('#call-local');
    if (local) local.srcObject = null;
    var remote = $('#call-remote');
    if (remote) remote.srcObject = null;
    hideCallOverlay();
  }

  function sendCallSignal(kind, payload) {
    if (!callState || !callState.id) return Promise.resolve();
    return api('/api/calls/' + encodeURIComponent(callState.id) + '/signal', {
      method: 'POST',
      body: { kind: kind, payload: JSON.stringify(payload) }
    }).catch(function () { /* signalling errors are non-fatal */ });
  }

  function createPeerConnection(cs) {
    /* STUN defaults + optional TURN server configured by the admin. */
    var pc = new RTCPeerConnection({
      iceServers: (publicSettings && publicSettings.iceServers) ||
        [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
    });
    cs.pc = pc;

    if (cs.localStream) {
      cs.localStream.getTracks().forEach(function (track) {
        try { pc.addTrack(track, cs.localStream); } catch (e) { /* ignore */ }
      });
    }

    pc.onicecandidate = function (ev) {
      if (ev.candidate) sendCallSignal('ice', ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate);
    };

    pc.ontrack = function (ev) {
      var remote = $('#call-remote');
      if (!remote) return;
      if (ev.streams && ev.streams[0]) {
        remote.srcObject = ev.streams[0];
      } else {
        if (!cs.remoteStream) cs.remoteStream = new MediaStream();
        cs.remoteStream.addTrack(ev.track);
        remote.srcObject = cs.remoteStream;
      }
      startCallDuration();
    };

    pc.onconnectionstatechange = function () {
      if (!callState || callState.pc !== pc) return;
      if (pc.connectionState === 'connected') {
        stopRingtone();
        stopRingingTimeout();
        startCallDuration();
      } else if (pc.connectionState === 'failed') {
        toast('The call connection failed.');
        endCall();
      }
    };

    return pc;
  }

  async function processPendingSignals() {
    var cs = callState;
    if (!cs || !cs.pc || cs.processing) return;
    cs.processing = true;
    try {
      if (cs.pendingOffer && !cs.pc.remoteDescription) {
        await cs.pc.setRemoteDescription(new RTCSessionDescription(cs.pendingOffer));
        cs.pendingOffer = null;
        if (cs.role === 'callee') {
          var answer = await cs.pc.createAnswer();
          await cs.pc.setLocalDescription(answer);
          await sendCallSignal('answer', cs.pc.localDescription);
        }
      }
      if (cs.pendingAnswer && !cs.pc.remoteDescription) {
        await cs.pc.setRemoteDescription(new RTCSessionDescription(cs.pendingAnswer));
        cs.pendingAnswer = null;
      }
      while (cs.pendingIce && cs.pendingIce.length) {
        var cand = cs.pendingIce.shift();
        try { await cs.pc.addIceCandidate(cand); } catch (e) { /* ignore late candidates */ }
      }
    } catch (e) {
      console.warn('Call signal error', e);
    } finally {
      cs.processing = false;
    }
  }

  function handleCallSignal(data) {
    if (!callState || callState.id !== data.callId) return;
    var payload;
    try { payload = JSON.parse(data.payload); } catch (e) { return; }
    if (data.kind === 'offer') callState.pendingOffer = payload;
    else if (data.kind === 'answer') callState.pendingAnswer = payload;
    else if (data.kind === 'ice') {
      callState.pendingIce = callState.pendingIce || [];
      callState.pendingIce.push(payload);
    }
    processPendingSignals();
  }

  async function startCall(kind) {
    if (!publicSettings.callsEnabled) { toast('Calls are currently disabled.'); return; }
    if (!activeChatUserId) return;
    if (callState) { toast('You are already in a call.'); return; }
    if (!callSupported()) { toast('Calls are not supported in this browser.'); return; }

    var person = contact(activeChatUserId);
    if (!person) return;

    callState = {
      id: null, role: 'caller', kind: kind, peerId: person.id,
      pc: null, localStream: null, remoteStream: null,
      pendingOffer: null, pendingAnswer: null, pendingIce: [], processing: false
    };
    showCallOverlay(person, kind, 'Calling ' + person.name + '...', 'active');

    try {
      callState.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' });
    } catch (e) {
      toast('Could not access your ' + (kind === 'video' ? 'camera/microphone' : 'microphone') + '.');
      cleanupCall();
      return;
    }
    var local = $('#call-local');
    if (local) local.srcObject = callState.localStream;

    try {
      var res = await api('/api/calls', { method: 'POST', body: { toUserId: person.id, kind: kind } });
      callState.id = res.call.id;
    } catch (ex) {
      toast(ex.message);
      cleanupCall();
      return;
    }

    startRingtone(false); /* outgoing ring-back tone */
    startRingingTimeout();

    createPeerConnection(callState);
    try {
      var offer = await callState.pc.createOffer();
      await callState.pc.setLocalDescription(offer);
      await sendCallSignal('offer', callState.pc.localDescription);
    } catch (e) {
      toast('Could not start the call.');
      cleanupCall();
    }
  }

  async function acceptIncomingCall() {
    if (!incomingCall) return;
    if (!callSupported()) { toast('Calls are not supported in this browser.'); return; }

    var ic = incomingCall;
    incomingCall = null;
    stopRingtone(); /* accepted — stop the incoming ringtone */
    callState = {
      id: ic.call.id, role: 'callee', kind: ic.call.kind, peerId: ic.from.id,
      pc: null, localStream: null, remoteStream: null,
      pendingOffer: null, pendingAnswer: null, pendingIce: [], processing: false
    };
    showCallOverlay(ic.from, ic.call.kind, 'Connecting...', 'active');

    try {
      callState.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: ic.call.kind === 'video'
      });
    } catch (e) {
      toast('Could not access your microphone/camera.');
      declineIncomingCall();
      return;
    }
    var local = $('#call-local');
    if (local) local.srcObject = callState.localStream;

    try {
      await api('/api/calls/' + encodeURIComponent(ic.call.id) + '/accept', { method: 'POST' });
    } catch (ex) {
      toast(ex.message);
      cleanupCall();
      return;
    }

    createPeerConnection(callState);

    try {
      /* Re-apply any signals the caller stored while we were ringing.
         The GET /signals response rows carry {id, from, kind, payload} —
         map them onto handleCallSignal's {callId, kind, payload} shape. */
      var res = await api('/api/calls/' + encodeURIComponent(ic.call.id) + '/signals');
      (res.signals || []).forEach(function (sig) {
        handleCallSignal({ callId: ic.call.id, kind: sig.kind, payload: sig.payload });
      });
    } catch (e) { /* ignore */ }
  }

  function declineIncomingCall() {
    if (incomingCall) {
      api('/api/calls/' + encodeURIComponent(incomingCall.call.id) + '/decline', { method: 'POST' })
        .catch(function () { /* ignore */ });
    }
    cleanupCall();
    toast('Call declined.');
  }

  function endCall() {
    if (callState && callState.id) {
      api('/api/calls/' + encodeURIComponent(callState.id) + '/end', { method: 'POST' })
        .catch(function () { /* ignore */ });
    }
    cleanupCall();
  }

  function toggleCallMute() {
    if (!callState || !callState.localStream) return;
    var tracks = callState.localStream.getAudioTracks();
    if (!tracks.length) return;
    var enabled = !tracks[0].enabled;
    tracks.forEach(function (t) { t.enabled = enabled; });
    var btn = $('#call-mute-btn');
    if (btn) {
      btn.classList.toggle('off', !enabled);
      btn.innerHTML = enabled ? ICONS.mic : ICONS.micOff;
    }
    toast(enabled ? 'Microphone on' : 'Microphone muted');
  }

  function toggleCallCamera() {
    if (!callState || !callState.localStream) return;
    var tracks = callState.localStream.getVideoTracks();
    if (!tracks.length) return;
    var enabled = !tracks[0].enabled;
    tracks.forEach(function (t) { t.enabled = enabled; });
    var btn = $('#call-camera-btn');
    if (btn) {
      btn.classList.toggle('off', !enabled);
      btn.innerHTML = enabled ? ICONS.video : ICONS.cameraOff;
    }
    toast(enabled ? 'Camera on' : 'Camera off');
  }

  /* ---------------- Friends ---------------- */

  function friendCard(p) {
    return '<div class="person-card">' + avatarHTML(p) +
      '<div class="person-info"><span class="person-name">' + esc(p.name) + '</span>' +
      '<span class="person-user">@' + esc(p.username) + '</span></div>' +
      '<div class="person-actions">' +
      '<button class="btn primary small" type="button" data-action="message-friend" data-user="' + p.id + '">' + ICONS.chat + ' Message</button>' +
      '<button class="chip-btn decline" type="button" title="Remove friend" aria-label="Remove friend" data-action="remove-friend" data-user="' + p.id + '">' + ICONS.userMinus + '</button>' +
      '</div></div>';
  }

  function suggestCard(p) {
    return '<div class="person-card">' + avatarHTML(p) +
      '<div class="person-info"><span class="person-name">' + esc(p.name) + '</span>' +
      '<span class="person-user">@' + esc(p.username) + '</span></div>' +
      '<div class="person-actions">' +
      '<button class="btn ghost small" type="button" data-action="add-friend" data-user="' + p.id + '">' + ICONS.userPlus + ' Add</button>' +
      '</div></div>';
  }

  function renderFriends() {
    var q = ($('#friend-search').value || '').trim().toLowerCase();
    $('#friends-count').textContent = state.friends.length;
    $('#requests-count').textContent = state.requests.length;
    $$('.tab[data-tab]').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === friendsTab);
    });

    var body = $('#friends-body');
    if (friendsTab === 'all') {
      var friends = state.friends.map(contact).filter(Boolean);
      if (q) friends = friends.filter(function (p) { return matchPerson(p, q); });

      var suggestions = state.contacts.filter(function (p) {
        return state.friends.indexOf(p.id) === -1 &&
          !state.requests.some(function (r) { return r.userId === p.id; }) &&
          state.sentRequests.indexOf(p.id) === -1;
      });
      if (q) suggestions = suggestions.filter(function (p) { return matchPerson(p, q); });

      var html = '<div class="section-title">Your friends</div>';
      html += friends.length
        ? '<div class="people-grid">' + friends.map(friendCard).join('') + '</div>'
        : '<div class="empty">No friends found.</div>';

      if (!q || suggestions.length) {
        html += '<div class="section-title">Suggested people</div>';
        html += suggestions.length
          ? '<div class="people-grid">' + suggestions.map(suggestCard).join('') + '</div>'
          : '<div class="empty">No suggestions right now.</div>';
      }
      body.innerHTML = html;
    } else {
      renderRequestsTab(body, q);
    }
  }

  function renderRequestsTab(body, q) {
    var incoming = state.requests.map(function (r) {
      return { r: r, p: contact(r.userId) };
    }).filter(function (x) { return x.p && (!q || matchPerson(x.p, q)); });

    var sent = state.sentRequests.map(contact).filter(Boolean).filter(function (p) {
      return !q || matchPerson(p, q);
    });

    var html = '<div class="section-title">Incoming requests</div>';
    html += incoming.length
      ? '<div class="people-grid">' + incoming.map(function (x) {
        return '<div class="person-card">' + avatarHTML(x.p) +
          '<div class="person-info"><span class="person-name">' + esc(x.p.name) + '</span>' +
          '<span class="person-user">@' + esc(x.p.username) + '</span></div>' +
          '<div class="person-actions">' +
          '<button class="btn primary small" type="button" data-action="accept-request" data-req="' + x.r.id + '">Accept</button>' +
          '<button class="btn ghost small" type="button" data-action="decline-request" data-req="' + x.r.id + '">Decline</button>' +
          '</div></div>';
      }).join('') + '</div>'
      : '<div class="empty">No incoming requests.</div>';

    html += '<div class="section-title">Sent requests</div>';
    html += sent.length
      ? '<div class="people-grid">' + sent.map(function (p) {
        return '<div class="person-card">' + avatarHTML(p) +
          '<div class="person-info"><span class="person-name">' + esc(p.name) + '</span>' +
          '<span class="person-user">@' + esc(p.username) + '</span></div>' +
          '<div class="person-actions"><span class="pill">Pending</span></div></div>';
      }).join('') + '</div>'
      : '<div class="empty">No sent requests.</div>';

    body.innerHTML = html;
  }

  async function acceptRequest(reqId) {
    try {
      state = await api('/api/friends/requests/' + encodeURIComponent(reqId) + '/accept', { method: 'POST' });
      renderSidebarBits();
      renderAfterMutation();
      toast('Friend request accepted.');
    } catch (ex) { toast(ex.message); }
  }

  async function declineRequest(reqId) {
    try {
      state = await api('/api/friends/requests/' + encodeURIComponent(reqId) + '/decline', { method: 'POST' });
      renderSidebarBits();
      renderAfterMutation();
      toast('Friend request declined.');
    } catch (ex) { toast(ex.message); }
  }

  async function removeFriend(userId) {
    var p = contact(userId);
    try {
      state = await api('/api/friends/' + encodeURIComponent(userId), { method: 'DELETE' });
      renderSidebarBits();
      renderAfterMutation();
      toast(p ? p.name + ' removed from your friends.' : 'Friend removed.');
    } catch (ex) { toast(ex.message); }
  }

  async function addFriend(userId) {
    var p = contact(userId);
    try {
      state = await api('/api/friends/requests/' + encodeURIComponent(userId), { method: 'POST' });
      renderSidebarBits();
      renderAfterMutation();
      toast(p ? 'Friend request sent to ' + p.name + '.' : 'Friend request sent.');
    } catch (ex) { toast(ex.message); }
  }

  /* ---------------- Notifications ---------------- */

  function renderNotifications() {
    var list = state.notifications.slice().sort(function (a, b) {
      return new Date(b.time) - new Date(a.time);
    });
    var body = $('#notif-body');
    if (!list.length) {
      body.innerHTML = '<div class="empty">You are all caught up.</div>';
      return;
    }
    body.innerHTML = list.map(function (n) {
      return '<button class="notif-item' + (n.read ? '' : ' unread') + '" type="button" data-action="open-notif" data-notif="' + n.id + '">' +
        '<span class="notif-icon ' + n.type + '">' + notifIcon(n.type) + '</span>' +
        '<span class="notif-body"><span class="notif-text">' + esc(n.text) + '</span>' +
        '<span class="notif-time">' + fmtRelative(n.time) + '</span></span>' +
        (n.read ? '' : '<span class="notif-dot"></span>') +
        '</button>';
    }).join('');
  }

  async function openNotification(id) {
    var n = state.notifications.filter(function (x) { return x.id === id; })[0];
    if (!n) return;

    n.read = true;
    renderSidebarBits();
    renderNotifications();

    api('/api/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST' }).catch(function () { /* ignore */ });

    if (n.type === 'request') {
      friendsTab = 'requests';
      setView('friends');
    } else if (n.userId && contact(n.userId)) {
      openChat(n.userId);
    }
  }

  async function markAllRead() {
    try {
      state = await api('/api/notifications/read-all', { method: 'POST' });
      renderSidebarBits();
      renderNotifications();
      toast('All notifications marked as read.');
    } catch (ex) { toast(ex.message); }
  }

  /* ---------------- Profile ---------------- */

  function renderProfile() {
    var u = me();
    if (!u) return;
    var chatCount = state.chats.filter(function (c) { return c.messages.length; }).length;

    var coverStyle = u.cover
      ? ' style="background-image:url(' + u.cover + ')"'
      : ' style="background:linear-gradient(120deg,var(--primary),var(--accent))"';

    $('#profile-body').innerHTML =
      '<div class="profile-grid">' +
      '<div class="card profile-card">' +
      '<div class="profile-cover"' + coverStyle + '>' +
      '<button class="cover-edit" type="button" data-action="change-cover" title="Change cover photo">' + ICONS.camera + ' Change cover</button>' +
      '</div>' +
      '<div class="avatar-wrap">' + avatarHTML(u, 'xl overlap') +
      '<div class="avatar-btns">' +
      '<button class="avatar-edit" type="button" data-action="change-avatar">' + ICONS.camera + ' Change photo</button>' +
      (u.avatar ? '<button class="avatar-edit" type="button" data-action="remove-avatar">' + ICONS.trash + ' Remove</button>' : '') +
      '</div>' +
      '<input type="file" id="avatar-input" accept="image/*" hidden>' +
      '<input type="file" id="cover-input" accept="image/*" hidden>' +
      '</div>' +
      '<h2 class="profile-name">' + esc(u.name) + '</h2>' +
      '<p class="profile-username">@' + esc(u.username) + '</p>' +
      '<p class="profile-bio">' + esc(u.bio || 'No bio yet.') + '</p>' +
      '<div class="profile-stats">' +
      '<div class="pstat"><b>' + state.friends.length + '</b><span>Friends</span></div>' +
      '<div class="pstat"><b>' + chatCount + '</b><span>Chats</span></div>' +
      '<div class="pstat"><b>' + totalUnread() + '</b><span>Unread</span></div>' +
      '</div></div>' +

      '<div class="card">' +
      '<div class="card-head"><h3>Account details</h3></div>' +
      '<form id="profile-form" class="form-grid" novalidate>' +
      '<div class="two-col">' +
      '<label class="field"><span>Full name</span><input type="text" id="profile-name" value="' + esc(u.name) + '"></label>' +
      '<label class="field"><span>Username</span><input type="text" id="profile-username" value="' + esc(u.username) + '"></label>' +
      '</div>' +
      '<label class="field"><span>Email</span><input type="email" id="profile-email" value="' + esc(u.email) + '"></label>' +
      '<label class="field"><span>Bio</span><textarea id="profile-bio">' + esc(u.bio || '') + '</textarea></label>' +
      '<p class="form-error" id="profile-error"></p>' +
      '<div><button type="submit" class="btn primary">Save changes</button></div>' +
      '</form>' +
      '<div class="settings-row">' +
      '<div class="settings-info"><strong>Dark mode</strong><span>Switch between dark and light theme.</span></div>' +
      '<button class="switch ' + (isDark() ? 'on' : '') + '" type="button" data-action="theme" aria-label="Toggle dark mode"></button>' +
      '</div>' +
      '<div class="settings-row">' +
      '<div class="settings-info"><strong>Log out</strong><span>End your session on this device.</span></div>' +
      '<button class="btn danger-soft" type="button" data-action="logout" style="width:auto;padding:9px 16px">Logout</button>' +
      '</div>' +
      '</div></div>';
  }

  /* Chooser modal: camera capture vs. gallery upload. */
  function openPhotoChooser(kind) {
    /* kind: 'avatar' | 'cover' */
    openModal(kind === 'cover' ? 'Change cover photo' : 'Change profile photo',
      '<div class="chooser">' +
      '<button class="chooser-item" type="button" data-action="' + kind + '-camera">' + ICONS.camera +
      '<span><b>Take a photo</b><span>Use your camera now</span></span></button>' +
      '<button class="chooser-item" type="button" data-action="' + kind + '-gallery">' + ICONS.image +
      '<span><b>Choose from gallery</b><span>Pick an image file</span></span></button>' +
      '</div>');
  }

  function saveProfilePhoto(kind, dataUrl) {
    var body = {};
    body[kind] = dataUrl || null;
    api('/api/users/me', { method: 'PATCH', body: body }).then(function (data) {
      state = data;
      renderProfile();
      renderSidebarBits();
      toast(kind === 'cover' ? 'Cover photo updated.' : 'Profile photo updated.');
    }).catch(function (ex) { toast(ex.message); });
  }

  function removeProfilePhoto(kind) {
    if (!window.confirm('Remove your ' + (kind === 'cover' ? 'cover photo' : 'profile photo') + '?')) return;
    saveProfilePhoto(kind, null);
  }

  async function saveProfile(e) {
    e.preventDefault();
    var name = $('#profile-name').value.trim();
    var username = $('#profile-username').value.trim().replace(/^@/, '');
    var email = $('#profile-email').value.trim();
    var bio = $('#profile-bio').value.trim();
    var err = $('#profile-error');
    err.textContent = '';

    if (!name || !username || !email) {
      err.textContent = 'Name, username and email are required.';
      return;
    }

    try {
      state = await api('/api/users/me', {
        method: 'PATCH',
        body: { name: name, username: username, email: email, bio: bio }
      });
      renderProfile();
      renderSidebarBits();
      toast('Profile updated.');
    } catch (ex) {
      err.textContent = ex.message;
    }
  }

  function handlePhotoFileChange(e, kind) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast('Please choose an image under 2MB.');
      e.target.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      saveProfilePhoto(kind, reader.result);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  /* ---------------- Admin dashboard ---------------- */

  function renderAdmin() {
    if (!me() || me().role !== 'admin') { setView('dashboard'); return; }
    renderAdminStats();
    renderAdminTabs();
    renderAdminTab();
    loadAdminData();
  }

  async function loadAdminData() {
    if (!me() || me().role !== 'admin' || adminLoading) return;
    adminLoading = true;
    try {
      var results = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/users'),
        api('/api/admin/messages?limit=100')
      ]);
      adminState.stats = results[0].stats;
      adminState.settings = results[0].settings;
      adminState.activity = results[0].activity;
      adminState.database = results[0].database;
      adminState.users = results[1].users;
      adminState.messages = results[2].messages;
      adminState.loaded = true;
      if (currentView === 'admin') {
        renderAdminStats();
        renderAdminTabs();
        renderAdminTab();
      }
    } catch (ex) {
      toast(ex.message);
    } finally {
      adminLoading = false;
    }
  }

  function renderAdminStats() {
    var box = $('#admin-stats');
    if (!box) return;
    var s = adminState.stats;
    if (!s) { box.innerHTML = '<div class="empty">Loading admin data...</div>'; return; }
    var items = [
      { label: 'Total users', value: s.users, icon: ICONS.users },
      { label: 'Online now', value: s.online, icon: ICONS.activity },
      { label: 'Messages', value: s.messages, icon: ICONS.chat },
      { label: 'Encrypted messages', value: s.encryptedMessages, icon: ICONS.lock },
      { label: 'Suspended users', value: s.suspended, icon: ICONS.ban },
      { label: 'Connections', value: s.friends, icon: ICONS.userPlus },
      { label: 'Pending requests', value: s.requests, icon: ICONS.inbox },
      { label: 'Conversations', value: s.conversations, icon: ICONS.chat },
      { label: 'Database', value: adminState.database ? adminState.database.name : 'Mchat_Database1', icon: ICONS.shield }
    ];
    box.innerHTML = items.map(function (it) {
      return '<div class="stat"><span class="stat-icon">' + it.icon + '</span>' +
        '<div class="stat-info"><span class="stat-value">' + it.value + '</span>' +
        '<span class="stat-label">' + it.label + '</span></div></div>';
    }).join('');
  }

  function renderAdminTabs() {
    $$('#admin-tabs .tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === adminState.tab);
    });
    var count = $('#admin-users-count');
    if (count) count.textContent = adminState.users.length;
  }

  function renderAdminTab() {
    if (adminState.tab === 'messages') renderAdminMessages();
    else if (adminState.tab === 'activity') renderAdminActivity();
    else if (adminState.tab === 'settings') renderAdminSettings();
    else renderAdminUsers();
  }

  function renderAdminUsers() {
    var body = $('#admin-body');
    var q = adminState.search.toLowerCase();
    var users = adminState.users.filter(function (u) {
      return !q || u.name.toLowerCase().indexOf(q) !== -1 ||
        u.username.toLowerCase().indexOf(q) !== -1 ||
        u.email.toLowerCase().indexOf(q) !== -1;
    });

    var html = '<div class="admin-toolbar">' +
      '<div class="search">' + ICONS.search +
      '<input type="search" id="admin-user-search" placeholder="Search users by name, username or email" value="' + esc(adminState.search) + '"></div>' +
      '<span class="admin-count">' + users.length + ' of ' + adminState.users.length + ' users</span>' +
      '</div>';

    if (!users.length) {
      body.innerHTML = html + '<div class="empty">No users match your search.</div>';
      return;
    }

    html += '<div class="admin-table-wrap"><table class="admin-table"><thead><tr>' +
      '<th>User</th><th>Role</th><th>Status</th><th>Messages</th><th>Friends</th>' +
      '<th>Crypto</th><th>Joined</th><th></th></tr></thead><tbody>';

    html += users.map(function (u) {
      var isAdmin = u.role === 'admin';
      var suspended = u.status === 'suspended';
      return '<tr>' +
        '<td><div class="admin-user-cell">' + avatarHTML(u, 'sm') +
        '<div class="uc-text"><span class="uc-name">' + esc(u.name) + '</span>' +
        '<span class="uc-mail">@' + esc(u.username) + ' · ' + esc(u.email) + '</span></div></div></td>' +
        '<td><span class="role-badge' + (isAdmin ? ' admin' : '') + '">' + esc(u.role) + '</span></td>' +
        '<td><span class="status-badge ' + (suspended ? 'suspended' : 'active') + '">' + esc(u.status) + '</span></td>' +
        '<td>' + u.messagesSent + '</td>' +
        '<td>' + u.friendsCount + '</td>' +
        '<td>' + (u.hasPublicKey ? '<span class="lock-tag">' + ICONS.lock + 'E2E</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + esc(new Date(u.createdAt).toLocaleDateString()) + '</td>' +
        '<td><div class="row-actions">' +
        '<button class="chip-btn primary-soft" type="button" title="Edit user" data-action="admin-edit-user" data-user="' + u.id + '">' + ICONS.edit + '</button>' +
        (suspended
          ? '<button class="chip-btn" type="button" title="Activate" data-action="admin-set-active" data-user="' + u.id + '">' + ICONS.power + '</button>'
          : '<button class="chip-btn decline" type="button" title="Suspend" data-action="admin-set-suspended" data-user="' + u.id + '">' + ICONS.ban + '</button>') +
        (isAdmin
          ? '<button class="chip-btn" type="button" title="Remove admin" data-action="admin-demote" data-user="' + u.id + '">' + ICONS.userMinus + '</button>'
          : '<button class="chip-btn" type="button" title="Make admin" data-action="admin-promote" data-user="' + u.id + '">' + ICONS.shield + '</button>') +
        '<button class="chip-btn decline" type="button" title="Delete user" data-action="admin-delete-user" data-user="' + u.id + '">' + ICONS.trash + '</button>' +
        '</div></td></tr>';
    }).join('');

    html += '</tbody></table></div>';
    body.innerHTML = html;
  }

  function adminActionIcon(action) {
    if (action.indexOf('delete') !== -1) return { cls: 'danger', icon: ICONS.trash };
    if (action.indexOf('settings') !== -1) return { cls: '', icon: ICONS.gear };
    if (action.indexOf('broadcast') !== -1) return { cls: '', icon: ICONS.send };
    if (action.indexOf('register') !== -1) return { cls: 'success', icon: ICONS.userPlus };
    return { cls: '', icon: ICONS.activity };
  }

  function renderAdminActivity() {
    var body = $('#admin-body');
    if (!adminState.activity.length) {
      body.innerHTML = '<div class="empty">No activity recorded yet.</div>';
      return;
    }
    body.innerHTML = '<div class="admin-list">' + adminState.activity.map(function (a) {
      var meta = adminActionIcon(a.action);
      var who = a.actor_name ? esc(a.actor_name) : 'System';
      return '<div class="admin-list-item">' +
        '<span class="ali-icon ' + meta.cls + '">' + meta.icon + '</span>' +
        '<div class="ali-main"><div class="ali-title">' + esc(a.detail || a.action) + '</div>' +
        '<div class="ali-sub">' + who + ' · ' + esc(a.action) + '</div></div>' +
        '<span class="ali-time">' + fmtRelative(a.created_at) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderAdminMessages() {
    var body = $('#admin-body');
    var html = '<div class="admin-note">' + ICONS.lock +
      'Admin view shows message metadata and non-encrypted content only. Encrypted message bodies cannot be read on the server.</div>';
    if (!adminState.messages.length) {
      body.innerHTML = html + '<div class="empty">No messages yet.</div>';
      return;
    }
    html += '<div class="admin-list">' + adminState.messages.map(function (m) {
      var preview = m.encrypted
        ? '<span class="lock-tag">' + ICONS.lock + 'Encrypted message</span>'
        : esc(m.text || (m.attachment ? 'Attachment: ' + m.attachment.name : ''));
      return '<div class="admin-list-item">' +
        '<span class="ali-icon">' + (m.encrypted ? ICONS.lock : ICONS.chat) + '</span>' +
        '<div class="ali-main"><div class="ali-title">' + esc(m.senderName) + ' → ' + esc(m.receiverName) + '</div>' +
        '<div class="ali-sub">' + preview + '</div></div>' +
        '<span class="ali-time">' + fmtRelative(m.time) + '</span>' +
        '<div class="row-actions">' +
        (m.encrypted ? '' : '<button class="chip-btn" type="button" title="Edit message" data-action="admin-edit-message" data-msg="' + m.id + '">' + ICONS.edit + '</button>') +
        '<button class="chip-btn decline" type="button" title="Delete message" data-action="admin-delete-message" data-msg="' + m.id + '">' + ICONS.trash + '</button>' +
        '<button class="chip-btn decline" type="button" title="Delete whole conversation" data-action="admin-delete-chat" data-a="' + m.senderId + '" data-b="' + m.receiverId + '">' + ICONS.ban + '</button>' +
        '</div></div>';
    }).join('') + '</div>';
    body.innerHTML = html;
  }

  function renderAdminSettings() {
    var st = adminState.settings || {};
    var body = $('#admin-body');
    var logo = st.app_logo || '';
    var logoPreview = logo
      ? '<img src="' + logo + '" alt="Current logo">'
      : '<span class="logo-default">' + ICONS.chat + ' (default)</span>';
    body.innerHTML =
      '<div class="admin-card">' +
      '<div class="admin-note">' + ICONS.lock +
      ' Chat messages are end-to-end encrypted in the browser. Admins manage accounts and settings but cannot read encrypted content.</div>' +
      '<div class="settings-grid">' +
      '<div class="setting-row"><div class="setting-info"><strong>App name</strong><span>Brand name displayed across the app.</span></div>' +
      '<label class="field"><input type="text" id="admin-app-name" value="' + esc(st.app_name || 'MCHART') + '"></label></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>Application logo</strong><span>Upload a custom logo (PNG, JPG, SVG, WebP — max 1 MB). It updates everywhere instantly and is saved permanently.</span></div>' +
      '<div class="logo-editor">' +
      '<span class="logo-preview" id="logo-preview">' + logoPreview + '</span>' +
      '<input type="file" id="admin-logo-input" accept="image/*" hidden>' +
      '<button class="btn ghost small" type="button" data-action="admin-logo-upload">' + ICONS.camera + ' Upload logo</button>' +
      (logo ? '<button class="btn ghost small" type="button" data-action="admin-logo-clear">' + ICONS.trash + ' Remove</button>' : '') +
      '</div></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>Allow registration</strong><span>Let new people create accounts.</span></div>' +
      '<button class="switch' + (st.allow_registration === '1' ? ' on' : '') + '" type="button" data-action="admin-toggle-setting" data-key="allow_registration" aria-label="Toggle registration"></button></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>Demo auto-replies</strong><span>Demo accounts automatically reply to messages.</span></div>' +
      '<button class="switch' + (st.demo_replies === '1' ? ' on' : '') + '" type="button" data-action="admin-toggle-setting" data-key="demo_replies" aria-label="Toggle demo replies"></button></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>Email code login</strong><span>Allow users to sign in with a 6-digit code sent to their email.</span></div>' +
      '<button class="switch' + (st.email_login_enabled === '1' ? ' on' : '') + '" type="button" data-action="admin-toggle-setting" data-key="email_login_enabled" aria-label="Toggle email code login"></button></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>Show login codes on screen</strong><span>Development aid: display the code when email delivery is not configured.</span></div>' +
      '<button class="switch' + (st.dev_show_login_code === '1' ? ' on' : '') + '" type="button" data-action="admin-toggle-setting" data-key="dev_show_login_code" aria-label="Toggle on-screen codes"></button></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>Login code lifetime</strong><span>Minutes a verification code stays valid (1-60).</span></div>' +
      '<label class="field"><input type="number" id="admin-code-ttl" min="1" max="60" value="' + esc(st.login_code_ttl || '10') + '"></label></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>Audio / video calls</strong><span>Allow users to start calls from a conversation.</span></div>' +
      '<button class="switch' + (st.calls_enabled === '1' ? ' on' : '') + '" type="button" data-action="admin-toggle-setting" data-key="calls_enabled" aria-label="Toggle calls"></button></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>TURN server (advanced)</strong><span>Optional TURN relay for calls behind strict firewalls, e.g. turn:turn.example.com:3478. Leave empty to use STUN only.</span></div>' +
      '<label class="field"><input type="text" id="admin-turn-url" placeholder="turn:turn.example.com:3478" value="' + esc(st.turn_url || '') + '"></label></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>TURN username</strong><span>Username for the TURN server (if required).</span></div>' +
      '<label class="field"><input type="text" id="admin-turn-username" placeholder="" value="' + esc(st.turn_username || '') + '"></label></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>TURN credential</strong><span>Password / secret for the TURN server.</span></div>' +
      '<label class="field"><input type="password" id="admin-turn-credential" placeholder="" value="' + esc(st.turn_credential || '') + '"></label></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>Welcome message</strong><span>Shown on the sign-in screen.</span></div>' +
      '<label class="field"><textarea id="admin-welcome" style="min-height:70px">' + esc(st.welcome_message || '') + '</textarea></label></div>' +
      '<div class="setting-row"><div class="setting-info"><strong>Maintenance notice</strong><span>Optional banner message for all users.</span></div>' +
      '<label class="field"><textarea id="admin-maintenance" style="min-height:70px">' + esc(st.maintenance_message || '') + '</textarea></label></div>' +
      '</div>' +
      '<div class="admin-modal-actions"><button class="btn primary" type="button" data-action="admin-save-settings">Save settings</button></div>' +
      '</div>' +

      '<div class="admin-danger">' +
      '<div class="admin-danger-head">' + ICONS.alert +
      '<div><h3>Danger Zone</h3><p>Irreversible, destructive operations for the entire system.</p></div></div>' +
      '<div class="admin-danger-row">' +
      '<div class="setting-info"><strong>Reset all records</strong><span>Deletes every message, story, reel, call, friendship and notification. User accounts, settings and logins are kept.</span></div>' +
      '<button class="btn danger" type="button" data-action="admin-danger-reset">Reset all records</button>' +
      '</div>' +
      '<div class="admin-danger-row">' +
      '<div class="setting-info"><strong>Delete everything</strong><span>Deletes ALL user accounts (except yours) plus every record. A completely fresh system.</span></div>' +
      '<button class="btn danger" type="button" data-action="admin-danger-wipe">Delete everything</button>' +
      '</div>' +
      '</div>';
  }

  /* -------- admin logo -------- */

  function handleAdminLogoFile(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type || file.type.indexOf('image/') !== 0) {
      toast('Choose an image file (PNG, JPG, SVG or WebP).');
      return;
    }
    if (file.size > 1024 * 1024) {
      toast('Logo must be 1 MB or smaller.');
      return;
    }
    var reader = new FileReader();
    reader.onload = async function () {
      try {
        var res = await api('/api/admin/settings', { method: 'PATCH', body: { app_logo: reader.result } });
        adminState.settings = res.settings;
        renderAdminSettings();
        loadPublicSettings();
        toast('Logo updated across the app.');
      } catch (ex) { toast(ex.message); }
    };
    reader.readAsDataURL(file);
  }

  async function clearAdminLogo() {
    if (!window.confirm('Remove the custom logo and restore the default MCHART logo?')) return;
    try {
      var res = await api('/api/admin/settings', { method: 'PATCH', body: { app_logo: '' } });
      adminState.settings = res.settings;
      renderAdminSettings();
      loadPublicSettings();
      toast('Logo reset to default.');
    } catch (ex) { toast(ex.message); }
  }

  /* -------- admin danger zone -------- */

  function openDangerConfirm(action) {
    var isWipe = action === 'wipe';
    var word = isWipe ? 'DELETE' : 'RESET';
    openModal(isWipe ? 'Delete everything?' : 'Reset all records?',
      '<div class="danger-confirm">' +
      '<p class="danger-text">' + ICONS.alert +
      (isWipe
        ? 'This will permanently delete <strong>every user account except yours</strong> and all messages, stories, reels, calls, friendships and notifications. Everyone will be logged out.'
        : 'This will permanently delete <strong>all messages, stories, reels, calls, friendships, requests and notifications</strong>. User accounts and logins are kept.') +
      '</p>' +
      '<p class="muted">This action cannot be undone. Type <strong>' + word + '</strong> below to confirm.</p>' +
      '<label class="field"><input type="text" id="danger-confirm-input" placeholder="Type ' + word + '" autocomplete="off"></label>' +
      '<p class="form-error" id="danger-confirm-error"></p>' +
      '<div class="admin-modal-actions">' +
      '<button class="btn ghost" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn danger" type="button" data-action="admin-danger-confirm" data-danger="' + action + '">' +
      (isWipe ? 'Yes, delete everything' : 'Yes, reset all records') + '</button>' +
      '</div></div>');
    var input = $('#danger-confirm-input');
    if (input) setTimeout(function () { input.focus(); }, 60);
  }

  async function runDangerAction(action) {
    var isWipe = action === 'wipe';
    var word = isWipe ? 'DELETE' : 'RESET';
    var input = $('#danger-confirm-input');
    var err = $('#danger-confirm-error');
    if (!input || input.value.trim().toUpperCase() !== word) {
      if (err) err.textContent = 'Type ' + word + ' to confirm.';
      return;
    }
    try {
      var btn = $('#modal .btn.danger');
      if (btn) { btn.disabled = true; btn.textContent = 'Working...'; }
      await api('/api/admin/danger/' + action, { method: 'POST', body: { confirm: word } });
      closeModal();
      toast(isWipe ? 'All accounts and records deleted.' : 'All records reset.');
      reelState = { list: [], loaded: false, observer: null, viewed: {} };
      teardownReelObserver();
      loadAdminData();
      loadPublicSettings();
    } catch (ex) {
      if (err) err.textContent = ex.message;
      else toast(ex.message);
    }
  }

  function openAdminEditUser(userId) {
    var u = adminState.users.filter(function (x) { return x.id === userId; })[0];
    if (!u) return;
    openModal('Edit user',
      '<form id="admin-user-form" class="form-grid" data-user="' + u.id + '" novalidate>' +
      '<div class="form-grid two">' +
      '<label class="field"><span>Full name</span><input type="text" id="admin-u-name" value="' + esc(u.name) + '"></label>' +
      '<label class="field"><span>Username</span><input type="text" id="admin-u-username" value="' + esc(u.username) + '"></label>' +
      '<label class="field"><span>Email</span><input type="email" id="admin-u-email" value="' + esc(u.email) + '"></label>' +
      '<label class="field"><span>New password</span><input type="password" id="admin-u-password" placeholder="Leave blank to keep current"></label>' +
      '<label class="field"><span>Role</span><select id="admin-u-role">' +
      '<option value="user"' + (u.role === 'user' ? ' selected' : '') + '>User</option>' +
      '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>Admin</option></select></label>' +
      '<label class="field"><span>Status</span><select id="admin-u-status">' +
      '<option value="active"' + (u.status === 'active' ? ' selected' : '') + '>Active</option>' +
      '<option value="suspended"' + (u.status === 'suspended' ? ' selected' : '') + '>Suspended</option></select></label>' +
      '</div>' +
      '<p class="form-error" id="admin-user-error"></p>' +
      '<div class="admin-modal-actions">' +
      '<button class="btn ghost" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" type="submit">Save changes</button></div>' +
      '</form>');
  }

  function openAdminCreateUser() {
    openModal('Create user',
      '<form id="admin-create-form" class="form-grid" novalidate>' +
      '<div class="form-grid two">' +
      '<label class="field"><span>Full name</span><input type="text" id="admin-c-name" placeholder="Jane Doe"></label>' +
      '<label class="field"><span>Username</span><input type="text" id="admin-c-username" placeholder="janedoe"></label>' +
      '<label class="field"><span>Email</span><input type="email" id="admin-c-email" placeholder="jane@example.com"></label>' +
      '<label class="field"><span>Password</span><input type="password" id="admin-c-password" placeholder="At least 6 characters"></label>' +
      '<label class="field"><span>Role</span><select id="admin-c-role">' +
      '<option value="user">User</option><option value="admin">Admin</option></select></label>' +
      '<label class="field"><span>Status</span><select id="admin-c-status">' +
      '<option value="active">Active</option><option value="suspended">Suspended</option></select></label>' +
      '</div>' +
      '<p class="form-error" id="admin-create-error"></p>' +
      '<div class="admin-modal-actions">' +
      '<button class="btn ghost" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" type="submit">Create user</button></div>' +
      '</form>');
  }

  async function saveAdminCreateUser(e) {
    e.preventDefault();
    var body = {
      name: $('#admin-c-name').value.trim(),
      username: $('#admin-c-username').value.trim(),
      email: $('#admin-c-email').value.trim(),
      password: $('#admin-c-password').value,
      role: $('#admin-c-role').value,
      status: $('#admin-c-status').value
    };
    try {
      await api('/api/admin/users', { method: 'POST', body: body });
      closeModal();
      toast('User created.');
      loadAdminData();
    } catch (ex) {
      var err = $('#admin-create-error');
      if (err) err.textContent = ex.message;
      else toast(ex.message);
    }
  }

  async function saveAdminUser(e) {
    e.preventDefault();
    var form = e.target;
    var id = form.getAttribute('data-user');
    var body = {
      name: $('#admin-u-name').value.trim(),
      username: $('#admin-u-username').value.trim(),
      email: $('#admin-u-email').value.trim(),
      role: $('#admin-u-role').value,
      status: $('#admin-u-status').value
    };
    var pw = $('#admin-u-password').value;
    if (pw) body.password = pw;

    try {
      await api('/api/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: body });
      closeModal();
      toast('User updated.');
      loadAdminData();
    } catch (ex) {
      var err = $('#admin-user-error');
      if (err) err.textContent = ex.message;
      else toast(ex.message);
    }
  }

  async function adminSetStatus(userId, status) {
    try {
      await api('/api/admin/users/' + encodeURIComponent(userId), { method: 'PATCH', body: { status: status } });
      toast('User ' + (status === 'suspended' ? 'suspended' : 'activated') + '.');
      loadAdminData();
    } catch (ex) { toast(ex.message); }
  }

  async function adminSetRole(userId, role) {
    try {
      await api('/api/admin/users/' + encodeURIComponent(userId), { method: 'PATCH', body: { role: role } });
      toast(role === 'admin' ? 'User promoted to admin.' : 'Admin privileges removed.');
      loadAdminData();
    } catch (ex) { toast(ex.message); }
  }

  async function adminDeleteUser(userId) {
    if (!window.confirm('Delete this user and all of their conversations? This cannot be undone.')) return;
    try {
      await api('/api/admin/users/' + encodeURIComponent(userId), { method: 'DELETE' });
      toast('User deleted.');
      loadAdminData();
    } catch (ex) { toast(ex.message); }
  }

  async function adminDeleteMessage(messageId) {
    if (!window.confirm('Delete this message permanently?')) return;
    try {
      await api('/api/admin/messages/' + encodeURIComponent(messageId), { method: 'DELETE' });
      toast('Message deleted.');
      loadAdminData();
    } catch (ex) { toast(ex.message); }
  }

  function openAdminEditMessage(messageId) {
    var m = adminState.messages.filter(function (x) { return x.id === messageId; })[0];
    if (!m) return;
    if (m.encrypted) { toast('Encrypted messages cannot be edited.'); return; }
    openModal('Edit message',
      '<form id="admin-message-form" class="form-grid" data-msg="' + m.id + '" novalidate>' +
      '<p class="muted">From <strong>' + esc(m.senderName) + '</strong> to <strong>' + esc(m.receiverName) + '</strong></p>' +
      '<label class="field"><span>Message text</span>' +
      '<textarea id="admin-m-text" maxlength="4000" style="min-height:110px">' + esc(m.text || '') + '</textarea></label>' +
      '<p class="form-error" id="admin-message-error"></p>' +
      '<div class="admin-modal-actions">' +
      '<button class="btn ghost" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" type="submit">Save message</button></div>' +
      '</form>');
  }

  async function saveAdminMessage(e) {
    e.preventDefault();
    var form = e.target;
    var id = form.getAttribute('data-msg');
    var text = $('#admin-m-text').value.trim();
    try {
      await api('/api/admin/messages/' + encodeURIComponent(id), { method: 'PATCH', body: { text: text } });
      closeModal();
      toast('Message updated.');
      loadAdminData();
    } catch (ex) {
      var err = $('#admin-message-error');
      if (err) err.textContent = ex.message;
      else toast(ex.message);
    }
  }

  async function adminDeleteChat(userA, userB) {
    if (!userA || !userB) return;
    if (!window.confirm('Delete the entire conversation between these two users? This cannot be undone.')) return;
    try {
      var res = await api('/api/admin/chats/' + encodeURIComponent(userA) + '/' + encodeURIComponent(userB), { method: 'DELETE' });
      toast('Conversation deleted (' + res.deleted + ' messages).');
      loadAdminData();
    } catch (ex) { toast(ex.message); }
  }

  function toggleValue(key) {
    var el = $('[data-key="' + key + '"]');
    return el && el.classList.contains('on') ? '1' : '0';
  }

  async function saveAdminSettings() {
    var ttlEl = $('#admin-code-ttl');
    var ttl = ttlEl ? Number(ttlEl.value) : 10;
    if (!ttl || ttl < 1) ttl = 10;
    if (ttl > 60) ttl = 60;

    var body = {
      app_name: $('#admin-app-name').value.trim(),
      allow_registration: toggleValue('allow_registration'),
      demo_replies: toggleValue('demo_replies'),
      email_login_enabled: toggleValue('email_login_enabled'),
      dev_show_login_code: toggleValue('dev_show_login_code'),
      calls_enabled: toggleValue('calls_enabled'),
      login_code_ttl: String(ttl),
      welcome_message: $('#admin-welcome').value.trim(),
      maintenance_message: $('#admin-maintenance').value.trim(),
      turn_url: ($('#admin-turn-url') ? $('#admin-turn-url').value.trim() : ''),
      turn_username: ($('#admin-turn-username') ? $('#admin-turn-username').value.trim() : ''),
      turn_credential: ($('#admin-turn-credential') ? $('#admin-turn-credential').value : '')
    };
    try {
      var res = await api('/api/admin/settings', { method: 'PATCH', body: body });
      adminState.settings = res.settings;
      loadPublicSettings();
      if (activeChatUserId) renderChat();
      toast('Settings saved.');
    } catch (ex) { toast(ex.message); }
  }

  function openBroadcastModal() {
    openModal('Send broadcast',
      '<div class="broadcast-form">' +
      '<p class="muted">This notification will be delivered to every user on the platform.</p>' +
      '<label class="field"><span>Announcement</span>' +
      '<textarea id="broadcast-text" maxlength="500" placeholder="Type an announcement..."></textarea></label>' +
      '<div class="admin-modal-actions">' +
      '<button class="btn ghost" type="button" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" type="button" data-action="admin-send-broadcast">Send to all</button>' +
      '</div></div>');
  }

  async function sendBroadcast() {
    var el = $('#broadcast-text');
    var text = el ? el.value.trim() : '';
    if (!text) return;
    try {
      var res = await api('/api/admin/broadcast', { method: 'POST', body: { text: text } });
      closeModal();
      toast('Broadcast sent to ' + res.count + ' users.');
      loadAdminData();
    } catch (ex) { toast(ex.message); }
  }

  /* ---------------- Modal ---------------- */

  function openModal(title, content) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = content;
    $('#modal').classList.remove('hidden');
  }

  function closeModal() {
    /* make sure a live camera preview never keeps running behind the modal */
    if (cameraCapture) closeCameraCapture();
    $('#modal').classList.add('hidden');
  }

  function openNewChatModal() {
    closeSidebar();
    openModal('New chat',
      '<div class="search" style="margin-bottom:12px">' + ICONS.search +
      '<input type="search" id="modal-search" placeholder="Search people by name or username" /></div>' +
      '<div id="modal-results"></div>');
    renderNewChatList('');
    setTimeout(function () { var i = $('#modal-search'); if (i) i.focus(); }, 60);
  }

  function renderNewChatList(q) {
    var box = $('#modal-results');
    if (!box) return;
    q = (q || '').trim().toLowerCase();
    var list = state.contacts.filter(function (p) { return !q || matchPerson(p, q); });
    if (!list.length) {
      box.innerHTML = '<div class="empty">No people found.</div>';
      return;
    }
    box.innerHTML = list.map(function (p) {
      return '<button class="new-chat-item" type="button" data-action="open-chat" data-user="' + p.id + '">' +
        avatarHTML(p) +
        '<span class="nc-info"><span class="nc-name">' + esc(p.name) + '</span>' +
        '<span class="nc-user">@' + esc(p.username) + '</span></span>' +
        '</button>';
    }).join('');
  }

  function openChatCamera() {
    if (!activeChatUserId) { toast('Open a conversation first.'); return; }
    openModal('Camera',
      '<div class="chooser">' +
      '<button class="chooser-item" type="button" data-action="chat-camera-photo">' + ICONS.camera +
      '<span><b>Take a photo</b><span>Send a photo you take now</span></span></button>' +
      '<button class="chooser-item" type="button" data-action="chat-camera-video">' + ICONS.video +
      '<span><b>Record a video</b><span>Send a video message</span></span></button>' +
      '</div>');
  }

  /* ---------------- Realtime ---------------- */

  async function applyBootstrap(data) {
    state = await hydrateBootstrap(data);
    renderSidebarBits();
    if (currentView === 'profile' || currentView === 'admin') return;

    if (currentView === 'messages') {
      renderConvList();
      if (activeChatUserId) renderChat();
    } else if (currentView === 'dashboard') {
      renderDashboard();
    } else if (currentView === 'stories') {
      renderStories();
    } else if (currentView === 'friends') {
      renderFriends();
    } else if (currentView === 'notifications') {
      renderNotifications();
    }
    maybeMarkRead();
  }

  function maybeMarkRead() {
    if (markingRead || currentView !== 'messages' || !activeChatUserId) return;
    var chat = getChat(activeChatUserId);
    if (!chat) return;
    var hasUnread = chat.messages.some(function (m) { return m.from !== 'me' && !m.read; });
    if (!hasUnread) return;

    markingRead = true;
    var userId = activeChatUserId;
    api('/api/chats/' + encodeURIComponent(userId) + '/read', { method: 'POST' })
      .catch(function () { /* ignore */ })
      .then(function () { markingRead = false; });
  }

  function startRealtime() {
    stopRealtime();
    if (!token || typeof EventSource === 'undefined') return;

    try {
      eventSource = new EventSource(API_BASE + '/api/events?token=' + encodeURIComponent(token));
    } catch (e) {
      eventSource = null;
      return;
    }

    eventSource.addEventListener('bootstrap', function (evt) {
      if (!evt.data) return;
      try { applyBootstrap(JSON.parse(evt.data)).catch(function () { /* ignore */ }); } catch (e) { /* ignore */ }
    });

    eventSource.addEventListener('stories', function (evt) {
      if (!evt.data || !state) return;
      try { state.stories = JSON.parse(evt.data) || []; } catch (e) { return; }
      renderSidebarBits();
      if (currentView === 'stories') renderStories();
    });

    eventSource.addEventListener('reels', function (evt) {
      if (!evt.data) return;
      try { reelState.list = (JSON.parse(evt.data).reels) || []; } catch (e) { return; }
      reelState.loaded = true;
      if (currentView === 'reels') renderReels();
    });

    eventSource.addEventListener('forced-logout', function () {
      stopPolling();
      stopRealtime();
      cleanupCall();
      clearToken();
      state = null;
      activeChatUserId = null;
      pendingAttachment = null;
      reelState = { list: [], loaded: false, observer: null, viewed: {} };
      teardownReelObserver();
      showAuth();
      toast('All accounts and records were deleted by the administrator. Please log in again.');
    });

    eventSource.addEventListener('presence', function (evt) {
      var data;
      try { data = JSON.parse(evt.data); } catch (e) { return; }
      if (!state) return;
      state.contacts.forEach(function (c) { if (c.id === data.userId) c.online = !!data.online; });
      if (currentView === 'messages') {
        renderConvList();
        if (activeChatUserId === data.userId) renderChat();
      } else if (currentView === 'friends') {
        renderFriends();
      } else if (currentView === 'dashboard') {
        renderDashboard();
      }
    });

    eventSource.addEventListener('typing', function (evt) {
      var data;
      try { data = JSON.parse(evt.data); } catch (e) { return; }
      if (currentView !== 'messages' || data.userId !== activeChatUserId) return;
      setChatStatus(!!data.typing);
      clearTimeout(remoteTypingTimer);
      if (data.typing) {
        remoteTypingTimer = setTimeout(function () { setChatStatus(false); }, 4000);
      }
    });

    eventSource.addEventListener('call-incoming', function (evt) {
      var data;
      try { data = JSON.parse(evt.data); } catch (e) { return; }
      if (!data || !data.call) return;

      if (callState) {
        api('/api/calls/' + encodeURIComponent(data.call.id) + '/decline', { method: 'POST' })
          .catch(function () { /* ignore */ });
        return;
      }
      incomingCall = data;
      showCallOverlay(data.from, data.call.kind, 'Incoming ' + data.call.kind + ' call', 'incoming');
      startRingtone(true); /* incoming ringtone */
      toast((data.from && data.from.name ? data.from.name : 'Someone') + ' is calling you.');
    });

    eventSource.addEventListener('call-signal', function (evt) {
      var data;
      try { data = JSON.parse(evt.data); } catch (e) { return; }
      handleCallSignal(data);
    });

    eventSource.addEventListener('call-accepted', function () {
      if (callState) {
        stopRingtone();
        stopRingingTimeout();
        setCallStatus('Connecting...');
      }
    });

    eventSource.addEventListener('call-ended', function (evt) {
      var data;
      try { data = JSON.parse(evt.data); } catch (e) { data = {}; }
      if (callState && (!data.callId || callState.id === data.callId)) {
        toast('Call ended.');
        cleanupCall();
      } else if (incomingCall && data.callId === incomingCall.call.id) {
        cleanupCall();
      }
    });
  }

  function stopRealtime() {
    if (eventSource) {
      try { eventSource.close(); } catch (e) { /* ignore */ }
      eventSource = null;
    }
    clearTimeout(remoteTypingTimer);
  }

  /* ---------------- Polling fallback ---------------- */

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(poll, 6000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function poll() {
    if (!token || !state || document.hidden) return;
    if (eventSource && eventSource.readyState === 1) return;
    if (Date.now() - lastMutationAt < 2500) return;

    try {
      var data = await api('/api/bootstrap');
      applyBootstrap(data).catch(function () { /* ignore */ });
    } catch (ex) {
      /* network hiccup or handled 401 */
    }
  }

  /* ---------------- Event delegation ---------------- */

  function runAction(action, el) {
    switch (action) {
      case 'open-sidebar': openSidebar(); break;
      case 'close-sidebar': closeSidebar(); break;
      case 'theme': toggleTheme(); break;
      case 'logout': logout(); break;
      case 'new-chat': openNewChatModal(); break;
      case 'close-modal': closeModal(); break;
      case 'open-chat': openChat(el.getAttribute('data-user')); break;
      case 'back-chat':
        clearTimeout(typingStopTimer);
        typingSentAt = 0;
        sendTyping(false);
        activeChatUserId = null;
        $('#view-messages').classList.remove('chat-open');
        renderChat();
        renderConvList();
        break;
      case 'delete-message': deleteMessage(el.getAttribute('data-msg')); break;
      case 'clear-chat': clearChat(); break;
      case 'attach': { var fi = $('#file-input'); if (fi) fi.click(); break; }
      case 'camera': openChatCamera(); break;
      case 'chat-camera-photo':
        openCameraCapture({
          mode: 'photo',
          title: 'Take a photo',
          onConfirm: function (rec) {
            pendingAttachment = {
              name: rec.name || 'Camera photo.jpg',
              type: rec.type || 'image/jpeg',
              size: Math.round((rec.dataUrl.length * 3) / 4),
              dataUrl: rec.dataUrl
            };
            renderAttachmentPreview();
            toast('Photo ready — send it when you like.');
          }
        });
        break;
      case 'chat-camera-video':
        openCameraCapture({
          mode: 'video',
          title: 'Record a video message',
          onConfirm: function (rec) {
            pendingAttachment = {
              name: rec.name || 'Camera video.webm',
              type: rec.type || 'video/webm',
              size: rec.size || Math.round((rec.dataUrl.length * 3) / 4),
              dataUrl: rec.dataUrl
            };
            renderAttachmentPreview();
            toast('Video ready — send it when you like.');
          }
        });
        break;
      case 'send-attachment': sendPendingAttachment(); break;
      case 'clear-attachment':
        pendingAttachment = null;
        $('#file-input').value = '';
        renderAttachmentPreview();
        break;
      case 'emoji': toggleEmojiPanel(); break;
      case 'emoji-pick': insertEmoji(el.getAttribute('data-emoji')); break;
      case 'record': toggleRecording(); break;
      case 'cam-capture': capturePhotoFromCamera(); break;
      case 'cam-toggle-record': toggleCameraRecording(); break;
      case 'cam-confirm': confirmCameraCapture(); break;
      case 'cam-retake': retakeCameraCapture(); break;
      case 'cam-cancel': closeCameraCapture(); break;
      case 'focus-story': {
        setView('stories');
        var st = $('#story-text');
        if (st) { st.focus(); st.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        break;
      }
      case 'story-attach': { var sf = $('#story-file'); if (sf) sf.click(); break; }
      case 'clear-story-media':
        pendingStoryMedia = null;
        var sfi = $('#story-file');
        if (sfi) sfi.value = '';
        renderStoryPreview();
        break;
      case 'story-color':
        storyBackground = el.getAttribute('data-color') || '#6366f1';
        renderStoryColors();
        break;
      case 'open-story': openStoryViewer(el.getAttribute('data-index')); break;
      case 'delete-story': deleteStory(el.getAttribute('data-story')); break;
      case 'close-story': closeStoryViewer(); break;
      case 'story-next': nextStory(); break;
      case 'story-prev': prevStory(); break;
      case 'start-audio-call': startCall('audio'); break;
      case 'start-video-call': startCall('video'); break;
      case 'call-accept': acceptIncomingCall(); break;
      case 'call-decline': declineIncomingCall(); break;
      case 'call-end': endCall(); break;
      case 'call-mute': toggleCallMute(); break;
      case 'call-camera': toggleCallCamera(); break;
      case 'accept-request': acceptRequest(el.getAttribute('data-req')); break;
      case 'decline-request': declineRequest(el.getAttribute('data-req')); break;
      case 'remove-friend': removeFriend(el.getAttribute('data-user')); break;
      case 'add-friend': addFriend(el.getAttribute('data-user')); break;
      case 'message-friend': openChat(el.getAttribute('data-user')); break;
      case 'friends-tab': friendsTab = el.getAttribute('data-tab'); renderFriends(); break;
      case 'mark-all-read': markAllRead(); break;
      case 'open-notif': openNotification(el.getAttribute('data-notif')); break;
      case 'change-avatar': openPhotoChooser('avatar'); break;
      case 'avatar-gallery': { var ai = $('#avatar-input'); if (ai) ai.click(); break; }
      case 'avatar-camera':
        openCameraCapture({
          mode: 'photo',
          title: 'New profile photo',
          onConfirm: function (rec) { saveProfilePhoto('avatar', rec.dataUrl); }
        });
        break;
      case 'remove-avatar': removeProfilePhoto('avatar'); break;
      case 'change-cover': openPhotoChooser('cover'); break;
      case 'cover-gallery': { var ci = $('#cover-input'); if (ci) ci.click(); break; }
      case 'cover-camera':
        openCameraCapture({
          mode: 'photo',
          title: 'New cover photo',
          onConfirm: function (rec) { saveProfilePhoto('cover', rec.dataUrl); }
        });
        break;
      case 'open-reel-composer': openReelComposer(); break;
      case 'reel-choose-file': { var rf = $('#reel-file'); if (rf) rf.click(); break; }
      case 'reel-record': recordReelWithCamera(); break;
      case 'reel-clear-media':
        pendingReelMedia = null;
        renderReelComposePreview();
        break;
      case 'reel-like': likeReel(el.getAttribute('data-reel')); break;
      case 'reel-delete': deleteReel(el.getAttribute('data-reel')); break;
      case 'reel-toggle-sound': toggleReelSound(el.getAttribute('data-reel')); break;
      case 'admin-tab':
        adminState.tab = el.getAttribute('data-tab');
        renderAdminTabs();
        renderAdminTab();
        break;
      case 'admin-refresh': loadAdminData(); break;
      case 'admin-broadcast': openBroadcastModal(); break;
      case 'admin-send-broadcast': sendBroadcast(); break;
      case 'admin-edit-user': openAdminEditUser(el.getAttribute('data-user')); break;
      case 'admin-set-suspended': adminSetStatus(el.getAttribute('data-user'), 'suspended'); break;
      case 'admin-set-active': adminSetStatus(el.getAttribute('data-user'), 'active'); break;
      case 'admin-promote': adminSetRole(el.getAttribute('data-user'), 'admin'); break;
      case 'admin-demote': adminSetRole(el.getAttribute('data-user'), 'user'); break;
      case 'admin-delete-user': adminDeleteUser(el.getAttribute('data-user')); break;
      case 'admin-create-user': openAdminCreateUser(); break;
      case 'admin-edit-message': openAdminEditMessage(el.getAttribute('data-msg')); break;
      case 'admin-delete-message': adminDeleteMessage(el.getAttribute('data-msg')); break;
      case 'admin-delete-chat': adminDeleteChat(el.getAttribute('data-a'), el.getAttribute('data-b')); break;
      case 'admin-save-settings': saveAdminSettings(); break;
      case 'admin-toggle-setting': el.classList.toggle('on'); break;
      case 'admin-logo-upload': { var lf = $('#admin-logo-input'); if (lf) lf.click(); break; }
      case 'admin-logo-clear': clearAdminLogo(); break;
      case 'admin-danger-reset': openDangerConfirm('reset'); break;
      case 'admin-danger-wipe': openDangerConfirm('wipe'); break;
      case 'admin-danger-confirm': runDangerAction(el.getAttribute('data-danger')); break;
      default: break;
    }
  }

  function handleClick(e) {
    var emojiPanel = $('#emoji-panel');
    if (emojiPanel && !emojiPanel.classList.contains('hidden') &&
        !e.target.closest('#emoji-panel') && !e.target.closest('[data-action="emoji"]')) {
      emojiPanel.classList.add('hidden');
    }

    var actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      runAction(actionEl.getAttribute('data-action'), actionEl);
      return;
    }
    var viewEl = e.target.closest('[data-view]');
    if (viewEl) {
      setView(viewEl.getAttribute('data-view'));
      return;
    }
    if (e.target.closest('#backdrop')) closeSidebar();
  }

  function handleSubmit(e) {
    var id = e.target.id;
    if (id === 'login-form') login(e);
    else if (id === 'code-form') verifyLoginCode(e);
    else if (id === 'signup-form') signup(e);
    else if (id === 'chat-form') sendMessage(e);
    else if (id === 'story-form') shareStory(e);
    else if (id === 'profile-form') saveProfile(e);
    else if (id === 'reel-form') shareReel(e);
    else if (id === 'admin-user-form') saveAdminUser(e);
    else if (id === 'admin-create-form') saveAdminCreateUser(e);
    else if (id === 'admin-message-form') saveAdminMessage(e);
  }

  function handleInput(e) {
    if (e.target.id === 'conv-search') renderConvList();
    else if (e.target.id === 'friend-search') renderFriends();
    else if (e.target.id === 'modal-search') renderNewChatList(e.target.value);
    else if (e.target.id === 'message-input') handleTypingInput();
    else if (e.target.id === 'admin-user-search') {
      adminState.search = e.target.value;
      renderAdminUsers();
      var box = $('#admin-user-search');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    }
  }

  function handleChange(e) {
    if (e.target.id === 'file-input') handleFile(e);
    else if (e.target.id === 'story-file') handleStoryFile(e);
    else if (e.target.id === 'avatar-input') handlePhotoFileChange(e, 'avatar');
    else if (e.target.id === 'cover-input') handlePhotoFileChange(e, 'cover');
    else if (e.target.id === 'reel-file') handleReelFile(e);
    else if (e.target.id === 'admin-logo-input') handleAdminLogoFile(e);
  }

  /* ---------------- Boot ---------------- */

  async function init() {
    var savedTheme = 'dark';
    try { savedTheme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) { /* ignore */ }
    document.documentElement.setAttribute('data-theme', savedTheme);

    loadPublicSettings();

    $('#tab-login').addEventListener('click', function () { switchAuthTab('login'); });
    $('#tab-signup').addEventListener('click', function () { switchAuthTab('signup'); });
    var codeTabBtn = $('#tab-code');
    if (codeTabBtn) codeTabBtn.addEventListener('click', function () { switchAuthTab('code'); });
    var sendCodeBtn = $('#send-code-btn');
    if (sendCodeBtn) sendCodeBtn.addEventListener('click', requestLoginCode);
    var codeEmailInput = $('#code-email');
    if (codeEmailInput) {
      codeEmailInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); requestLoginCode(); }
      });
    }
    $('#demo-login').addEventListener('click', function () {
      $('#login-email').value = 'aline@mchart.app';
      $('#login-password').value = '123456';
      $('#login-error').textContent = '';
      var form = $('#login-form');
      if (form.requestSubmit) form.requestSubmit();
      else login(new Event('submit'));
    });
    var adminLoginBtn = $('#admin-login');
    if (adminLoginBtn) {
      adminLoginBtn.addEventListener('click', function () {
        $('#login-email').value = 'admin@mchart.app';
        $('#login-password').value = 'admin123';
        $('#login-error').textContent = '';
        var form = $('#login-form');
        if (form.requestSubmit) form.requestSubmit();
        else login(new Event('submit'));
      });
    }

    document.addEventListener('click', handleClick);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleChange);

    var modal = $('#modal');
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var viewer = $('#story-viewer');
        if (viewer && !viewer.classList.contains('hidden')) { closeStoryViewer(); return; }
        if (!modal.classList.contains('hidden')) closeModal();
      }
    });

    updateThemeUI();

    if (token) {
      try {
        state = await api('/api/bootstrap');
        await setupEncryption();
        enterApp();
        return;
      } catch (ex) {
        clearToken();
        state = null;
      }
    }
    showAuth();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
