'use strict';
/*
  StoryT server
  - Serves the app from /public
  - Stores everything in DATA_DIR (a Railway volume): db.json + uploaded media
  - No database server needed
*/
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ---------- Settings (change with Railway variables) ---------- */
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const PER_100_LIKES = Number(process.env.DOLLARS_PER_100_LIKES || 1); // $1 for every 100 thumbs up
const MIN_WITHDRAW = Number(process.env.MIN_WITHDRAW || 10);  // dollars
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 300);
const SEED_SAMPLES = process.env.SEED_SAMPLES !== 'false';

const LIMITS = { tea: 240, gossip: 360, source: 60, comment: 5000, title: 150, note: 200, bio: 160 };
// Followers commenting on a creator's video have no practical limit (safety ceiling only, about 20 pages of text)
const FOLLOWER_COMMENT_MAX = 100000;
const REACTIONS = ['up', 'down', 'laugh', 'sip'];
const MESSAGE_MAX = 2000;

const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
// On Railway, data only survives restarts when a Volume is attached
const STORAGE_OK = !process.env.RAILWAY_ENVIRONMENT_NAME && !process.env.RAILWAY_ENVIRONMENT || !!process.env.DATA_DIR || !!process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (!STORAGE_OK) console.warn('WARNING: No Railway Volume attached. Accounts, posts and videos will be ERASED on every redeploy. Add a Volume mounted at /data.');

/* ---------- Tiny JSON database ---------- */
let db = { users: {}, sessions: {}, posts: [], reactions: {}, comments: {}, withdrawals: [], follows: {}, messages: {}, reads: {}, push: {}, vapid: null };
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 150); }
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => { try { flush(); } catch (e) {} process.exit(0); }));

const uid = () => crypto.randomUUID();
const now = () => Date.now();
const fmtDur = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

function seed() {
  const mk = (username, name) => {
    const id = uid();
    db.users[id] = { id, username, name, bio: '', city: '', phone: '', avatar: null, passwordHash: null, createdAt: now(), sample: true };
    return id;
  };
  const kiki = mk('kiki.sips', 'Kiki'), ton = mk('tonton.talks', 'Tonton'), lady = mk('lady.verdict', 'Verdict');
  const samples = [
    { u: kiki, type: 'tea', dur: 222, hue: 28, title: 'The bridesmaid group chat got sent to the groom. Part 1 of 3.',
      quote: 'Someone hit "forward" on the bridesmaid chat. To the groom.', r: { up: 12400, down: 860, laugh: 5310, sip: 3900 } },
    { u: ton, type: 'gossip', kind: 'image', dur: 348, hue: 200, note: 'The "surprise" cake that says HAPPY RETIREMENT to a 25-year-old',
      title: 'Breaking down this bakery photo frame by frame.', quote: "Retirement cake. She is twenty-five. Let's talk about it.",
      r: { up: 8100, down: 2400, laugh: 9800, sip: 1200 } },
    { u: lady, type: 'gossip', kind: 'video', dur: 301, hue: 100, note: 'Drive-thru proposal clip',
      title: "I watched the drive-thru proposal so you don't have to.", quote: 'He proposed at the drive-thru. The cashier said no first.',
      r: { up: 3300, down: 5100, laugh: 2600, sip: 700 } },
  ];
  samples.forEach((s, i) => {
    const id = uid();
    db.posts.push({ id, userId: s.u, type: s.type, title: s.title, quote: s.quote, note: s.note || '', duration: s.dur,
      video: null, source: s.type === 'gossip' ? { kind: s.kind, url: null } : null, sample: true, hue: s.hue, r: s.r,
      createdAt: now() - (i + 1) * 3600e3 });
    if (i === 0) db.comments[id] = [
      { id: uid(), userId: ton, text: 'PART 2 NOW PLEASE', at: now() - 120e3 },
      { id: uid(), userId: lady, text: 'The maid of honor knew exactly what she was doing.', at: now() - 540e3 },
    ];
  });
}

if (fs.existsSync(DB_FILE)) {
  try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch (e) { console.error('db.json could not be read. Fix or remove it.', e); process.exit(1); }
} else {
  if (SEED_SAMPLES) seed();
  flush();
}

/* ---------- Push notifications ---------- */
// Keys are created once and kept in the database, so nothing needs to be set up by hand
if (!db.vapid) { db.vapid = webpush.generateVAPIDKeys(); flush(); }
webpush.setVapidDetails(process.env.PUSH_CONTACT || 'mailto:admin@storyt.app', db.vapid.publicKey, db.vapid.privateKey);
function notify(userId, payload) {
  const subs = db.push[userId] || [];
  subs.forEach(sub => {
    webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 * 24 }).catch(err => {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {      // phone unsubscribed: forget it
        db.push[userId] = (db.push[userId] || []).filter(x => x.endpoint !== sub.endpoint); save();
      }
    });
  });
}

/* ---------- Helpers ---------- */
// $1 for every full 100 thumbs up, paid only while thumbs up beat thumbs down
const earned = p => (p.r.up > p.r.down ? Math.floor(p.r.up / 100) * PER_100_LIKES : 0);
const publicUser = u => ({ username: u.username || null, handle: '@' + (u.username || 'deleted'), name: u.name || 'Deleted user', avatar: u.avatar || null });
const followingOf = id => (db.follows[id] = db.follows[id] || []);
const isFollowing = (viewerId, creatorId) => !!viewerId && (db.follows[viewerId] || []).includes(creatorId);
const followerCount = creatorId => Object.values(db.follows).reduce((n, list) => n + (list.includes(creatorId) ? 1 : 0), 0);
const commentLimitFor = (viewerId, p) => (viewerId && (viewerId === p.userId || isFollowing(viewerId, p.userId)) ? FOLLOWER_COMMENT_MAX : LIMITS.comment);
const privateUser = u => ({ ...publicUser(u), username: u.username, bio: u.bio || '', city: u.city || '', phone: u.phone || '', createdAt: u.createdAt });
function postView(p, viewerId, withMoney) {
  const v = {
    id: p.id, type: p.type, title: p.title, quote: p.quote || '', note: p.note || '', duration: p.duration,
    video: p.video, source: p.source, sample: !!p.sample, hue: p.hue, createdAt: p.createdAt,
    author: { ...publicUser(db.users[p.userId] || {}), following: isFollowing(viewerId, p.userId) },
    own: !!viewerId && p.userId === viewerId,
    r: p.r, mine: ((db.reactions[p.id] || {})[viewerId]) || [],
    comments: (db.comments[p.id] || []).length,
  };
  if (withMoney) v.earning = earned(p); // money only shows on the owner's Profile
  return v;
}
const findByUsername = name => Object.values(db.users).find(u => u.username === name);
const cleanUsername = s => String(s || '').trim().toLowerCase().replace(/^@/, '');
const validUsername = s => /^[a-z0-9._]{3,24}$/.test(s);
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

class UserError extends Error { constructor(msg, code = 400) { super(msg); this.code = code; } }
const fail = (msg, code) => { throw new UserError(msg, code); };

function tokenUser(req) {
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const s = t && db.sessions[t];
  return s && db.users[s.userId] ? { user: db.users[s.userId], token: t } : null;
}
function auth(req, res, next) {
  const tu = tokenUser(req);
  if (!tu) return res.status(401).json({ error: 'Please log in again.' });
  req.user = tu.user; req.token = tu.token; next();
}
function newSession(userId) { const t = crypto.randomBytes(32).toString('hex'); db.sessions[t] = { userId, at: now() }; save(); return t; }
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function removeMedia(url) {
  if (!url || !url.startsWith('/media/')) return;
  const f = path.join(MEDIA_DIR, path.basename(url));
  fs.unlink(f, () => {});
}
function removeUploaded(req) {
  const all = req.file ? [req.file] : Object.values(req.files || {}).flat();
  all.forEach(f => fs.unlink(f.path, () => {}));
}

/* ---------- Uploads ---------- */
function extOf(f) {
  const e = path.extname(f.originalname || '').toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(e)) return e;
  const sub = (f.mimetype.split('/')[1] || '').split(';')[0].replace(/[^a-z0-9]/g, '');
  return '.' + (sub || (f.mimetype.startsWith('image/') ? 'jpg' : 'webm'));
}
const upload = multer({
  storage: multer.diskStorage({ destination: MEDIA_DIR, filename: (req, f, cb) => cb(null, uid() + extOf(f)) }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 2 },
  fileFilter: (req, f, cb) => {
    const ok = f.fieldname === 'avatar' ? f.mimetype.startsWith('image/')
      : f.fieldname === 'video' ? f.mimetype.startsWith('video/')
      : f.fieldname === 'source' ? /^(image|video)\//.test(f.mimetype) : false;
    ok ? cb(null, true) : cb(new UserError(f.fieldname === 'video' ? 'Your post must be a video file.' : 'That file type is not allowed here.'));
  },
});

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use('/media', express.static(MEDIA_DIR, { maxAge: '7d' }));
// For the Google Play app: put assetlinks.json in public/.well-known/

// The app files can sit in a "public" folder or right next to server.js
const STATIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
app.use((req, res, next) => /^\/(server\.js|package(-lock)?\.json|README\.md|\.gitignore|data\/.*)$/i.test(req.path) ? res.status(404).end() : next());
app.use(express.static(STATIC_DIR, {
  setHeaders: (res, file) => {
    const name = path.basename(file);
    if (name === 'sw.js' || name === 'index.html') res.setHeader('Cache-Control', 'no-cache');
    if (name === 'manifest.json') res.setHeader('Content-Type', 'application/manifest+json');
  },
}));
app.use('/.well-known', express.static(path.join(STATIC_DIR, '.well-known')));
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => res.json({ limits: LIMITS, maxUploadMb: MAX_UPLOAD_MB, storageOk: STORAGE_OK }));

/* Accounts */
app.post('/api/signup', wrap(async (req, res) => {
  const name = str(req.body.name, 40), username = cleanUsername(req.body.username), password = String(req.body.password || '');
  if (!name) fail('Enter your name.');
  if (!validUsername(username)) fail('Usernames are 3 to 24 characters: letters, numbers, dots or underscores.');
  if (findByUsername(username)) fail('That username is taken. Try another one.');
  if (password.length < 6) fail('Use a password with at least 6 characters.');
  const id = uid();
  db.users[id] = { id, username, name, bio: '', city: '', phone: '', avatar: null, passwordHash: await bcrypt.hash(password, 10), createdAt: now() };
  res.json({ token: newSession(id), me: privateUser(db.users[id]) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const u = findByUsername(cleanUsername(req.body.username));
  const ok = u && u.passwordHash && await bcrypt.compare(String(req.body.password || ''), u.passwordHash);
  if (!ok) fail('Wrong username or password.', 401);
  res.json({ token: newSession(u.id), me: privateUser(u) });
}));

app.post('/api/logout', auth, (req, res) => { delete db.sessions[req.token]; save(); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ me: privateUser(req.user) }));

app.put('/api/me', auth, upload.single('avatar'), wrap(async (req, res) => {
  try {
    const u = req.user, b = req.body;
    const username = cleanUsername(b.username || u.username);
    if (!validUsername(username)) fail('Usernames are 3 to 24 characters: letters, numbers, dots or underscores.');
    const other = findByUsername(username);
    if (other && other.id !== u.id) fail('That username is taken. Try another one.');
    u.username = username;
    u.name = str(b.name, 40) || u.name;
    u.bio = str(b.bio, LIMITS.bio);
    u.city = str(b.city, 40);
    u.phone = str(b.phone, 20);
    if (req.file) { removeMedia(u.avatar); u.avatar = '/media/' + req.file.filename; }
    save();
    res.json({ me: privateUser(u) });
  } catch (e) { removeUploaded(req); throw e; }
}));

/* Feed */
app.get('/api/posts', (req, res) => {
  const tu = tokenUser(req), viewer = tu ? tu.user.id : null;
  const posts = [...db.posts].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(p => postView(p, viewer));
  res.json({ posts });
});

app.post('/api/posts', auth, upload.fields([{ name: 'video', maxCount: 1 }, { name: 'source', maxCount: 1 }]), wrap(async (req, res) => {
  try {
    const b = req.body, type = b.type;
    if (!['tea', 'gossip'].includes(type)) fail('Choose Tea or Gossip.');
    const title = str(b.title, LIMITS.title);
    if (!title) fail('Give your video a title.');
    const vid = (req.files.video || [])[0];
    if (!vid) fail('Add a video.');
    const d = Number(b.duration);
    if (!(d > 0)) fail('The video length could not be read. Try another video.');
    if (d > LIMITS[type] + 1) fail(`${type === 'tea' ? 'Tea' : 'Gossip'} videos can be up to ${fmtDur(LIMITS[type])}. This one is ${fmtDur(d)}.`);
    let source = null;
    if (type === 'gossip') {
      const s = (req.files.source || [])[0];
      if (!s) fail('Add the photo or short video your gossip is about.');
      const kind = s.mimetype.startsWith('image/') ? 'image' : 'video';
      if (kind === 'video') {
        const sd = Number(b.sourceDuration);
        if (!(sd > 0) || sd > LIMITS.source + 1) fail(`The clip you gossip about can be up to ${fmtDur(LIMITS.source)}.`);
      }
      source = { kind, url: '/media/' + s.filename };
    }
    const p = { id: uid(), userId: req.user.id, type, title, quote: '', note: type === 'gossip' ? str(b.note, LIMITS.note) : '',
      duration: Math.round(d), video: '/media/' + vid.filename, source, sample: false, hue: Math.floor(Math.random() * 360),
      r: Object.fromEntries(REACTIONS.map(k => [k, 0])), createdAt: now() };
    db.posts.push(p); save();
    const who = '@' + req.user.username;
    Object.entries(db.follows).forEach(([fid, list]) => { if (list.includes(req.user.id)) notify(fid, {
      title: `${who} just spilled new ${type === 'tea' ? 'tea' : 'gossip'}`, body: title, url: '/?action=channel&creator=' + encodeURIComponent(req.user.username) }); });
    res.json({ post: postView(p, req.user.id) });
  } catch (e) { removeUploaded(req); throw e; }
}));

app.delete('/api/posts/:id', auth, (req, res) => {
  const i = db.posts.findIndex(p => p.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'That post no longer exists.' });
  const p = db.posts[i];
  if (p.userId !== req.user.id) return res.status(403).json({ error: 'You can only delete your own posts.' });
  removeMedia(p.video); if (p.source) removeMedia(p.source.url);
  db.posts.splice(i, 1); delete db.reactions[p.id]; delete db.comments[p.id]; save();
  res.json({ ok: true });
});

/* Reactions: tap to toggle; thumbs up and down cancel each other */
app.post('/api/posts/:id/react', auth, (req, res) => {
  const p = db.posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'That post no longer exists.' });
  const k = req.body.k;
  if (!REACTIONS.includes(k)) return res.status(400).json({ error: 'Unknown reaction.' });
  const byUser = db.reactions[p.id] = db.reactions[p.id] || {};
  const mine = new Set(byUser[req.user.id] || []);
  const set = (key, on) => { if (mine.has(key) === on) return; on ? mine.add(key) : mine.delete(key); p.r[key] = Math.max(0, (p.r[key] || 0) + (on ? 1 : -1)); };
  const on = !mine.has(k);
  set(k, on);
  if (on && k === 'up') set('down', false);
  if (on && k === 'down') set('up', false);
  byUser[req.user.id] = [...mine]; save();
  res.json({ r: p.r, mine: [...mine] });
});

/* Comments */
app.get('/api/posts/:id/comments', (req, res) => {
  const tu = tokenUser(req), p = db.posts.find(x => x.id === req.params.id);
  const limit = p ? commentLimitFor(tu && tu.user.id, p) : LIMITS.comment;
  const list = (db.comments[req.params.id] || []).slice().sort((a, b) => b.at - a.at)
    .map(c => ({ id: c.id, text: c.text, at: c.at, author: publicUser(db.users[c.userId] || {}) }));
  res.json({ comments: list, limit, unlimited: limit > LIMITS.comment });
});
app.post('/api/posts/:id/comments', auth, (req, res) => {
  const p = db.posts.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'That post no longer exists.' });
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write something first.' });
  if (text.length > commentLimitFor(req.user.id, p)) return res.status(400).json({ error: 'Comments can be up to 5,000 characters. Follow this creator to write as much as you want.' });
  const c = { id: uid(), userId: req.user.id, text, at: now() };
  (db.comments[p.id] = db.comments[p.id] || []).push(c); save();
  if (p.userId !== req.user.id) notify(p.userId, { title: `@${req.user.username} commented on your video`, body: text.slice(0, 120), url: '/?action=profile' });
  res.json({ comment: { id: c.id, text, at: c.at, author: publicUser(req.user) }, count: db.comments[p.id].length });
});

/* Dashboard: personal info, stats, wallet */
function walletOf(u) {
  const mine = db.posts.filter(p => p.userId === u.id);
  const total = mine.reduce((a, p) => a + earned(p), 0);
  const history = db.withdrawals.filter(w => w.userId === u.id).sort((a, b) => b.at - a.at);
  const withdrawn = history.reduce((a, w) => a + w.amount, 0);
  return { mine, wallet: { earned: total, withdrawn, balance: Math.max(0, total - withdrawn), per100: PER_100_LIKES, minWithdraw: MIN_WITHDRAW, history } };
}
app.get('/api/dashboard', auth, (req, res) => {
  const u = req.user, { mine, wallet } = walletOf(u);
  const sum = k => mine.reduce((a, p) => a + (p.r[k] || 0), 0);
  res.json({
    me: privateUser(u), wallet,
    stats: { posts: mine.length, followers: followerCount(u.id), following: (db.follows[u.id] || []).length, up: sum('up'), down: sum('down'), laugh: sum('laugh'), sip: sum('sip'),
      comments: mine.reduce((a, p) => a + (db.comments[p.id] || []).length, 0) },
    posts: mine.sort((a, b) => b.createdAt - a.createdAt).map(p => postView(p, u.id, true)),
  });
});
app.post('/api/withdraw', auth, (req, res) => {
  const { wallet } = walletOf(req.user);
  if (wallet.balance < MIN_WITHDRAW) return res.status(400).json({ error: `You need at least $${MIN_WITHDRAW.toFixed(2)} to withdraw.` });
  const w = { id: uid(), userId: req.user.id, amount: Math.round(wallet.balance * 100) / 100, status: 'pending', at: now() };
  db.withdrawals.push(w); save();
  res.json({ withdrawal: w });
});

/* Creators, following and Channel */
function creatorView(u, viewerId) {
  return { ...publicUser(u), bio: u.bio || '', followers: followerCount(u.id), following: (db.follows[u.id] || []).length,
    posts: db.posts.filter(p => p.userId === u.id).length, isFollowing: isFollowing(viewerId, u.id), isMe: viewerId === u.id };
}
app.get('/api/users/:username', (req, res) => {
  const u = findByUsername(cleanUsername(req.params.username));
  if (!u) return res.status(404).json({ error: 'This creator no longer exists.' });
  const tu = tokenUser(req), viewer = tu ? tu.user.id : null;
  const posts = db.posts.filter(p => p.userId === u.id).sort((a, b) => b.createdAt - a.createdAt).map(p => postView(p, viewer));
  res.json({ creator: creatorView(u, viewer), posts });
});
app.post('/api/users/:username/follow', auth, (req, res) => {
  const u = findByUsername(cleanUsername(req.params.username));
  if (!u) return res.status(404).json({ error: 'This creator no longer exists.' });
  if (u.id === req.user.id) return res.status(400).json({ error: "You can't follow yourself." });
  const list = followingOf(req.user.id), i = list.indexOf(u.id);
  if (i >= 0) list.splice(i, 1); else list.push(u.id);
  save();
  if (i < 0) notify(u.id, { title: `@${req.user.username} started following you`, body: 'They will see every video you post in their Channel.', url: '/?action=profile' });
  res.json({ following: i < 0, followers: followerCount(u.id) });
});
app.get('/api/channel', auth, (req, res) => {
  const me = req.user, ids = followingOf(me.id), seenAt = me.channelSeenAt || 0;
  const creators = ids.map(id => db.users[id]).filter(Boolean).map(u => ({
    ...creatorView(u, me.id), unseen: db.posts.filter(p => p.userId === u.id && p.createdAt > seenAt).length }));
  const posts = db.posts.filter(p => ids.includes(p.userId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
    .map(p => ({ ...postView(p, me.id), isNew: p.createdAt > seenAt }));
  // Suggestions: creators with posts you don't follow yet, most followed first
  const suggestions = Object.values(db.users)
    .filter(u => u.id !== me.id && !ids.includes(u.id) && db.posts.some(p => p.userId === u.id))
    .map(u => creatorView(u, me.id)).sort((a, b) => b.followers - a.followers || b.posts - a.posts).slice(0, 8);
  me.channelSeenAt = now(); save();
  res.json({ creators, posts, suggestions });
});
app.get('/api/channel/unseen', auth, (req, res) => {
  const ids = db.follows[req.user.id] || [], seenAt = req.user.channelSeenAt || 0;
  res.json({ count: db.posts.filter(p => ids.includes(p.userId) && p.createdAt > seenAt).length, messages: unreadTotal(req.user.id) });
});

/* Direct messages */
const convoKey = (a, b) => [a, b].sort().join(':');
const lastRead = (me, other) => ((db.reads[me] || {})[other]) || 0;
function unreadWith(me, other) { return (db.messages[convoKey(me, other)] || []).filter(m => m.from === other && m.at > lastRead(me, other)).length; }
function unreadTotal(me) {
  return Object.keys(db.messages).filter(k => k.split(':').includes(me))
    .reduce((n, k) => { const other = k.split(':').find(x => x !== me) || me; return n + unreadWith(me, other); }, 0);
}
function canMessage(me, other) {
  // You can message someone you follow, or reply to anyone who messaged you first
  return isFollowing(me, other) || (db.messages[convoKey(me, other)] || []).some(m => m.from === other);
}
app.get('/api/messages', auth, (req, res) => {
  const me = req.user.id;
  const convos = Object.keys(db.messages).filter(k => k.split(':').includes(me)).map(k => {
    const other = k.split(':').find(x => x !== me) || me, list = db.messages[k], last = list[list.length - 1];
    const u = db.users[other];
    return u && last ? { user: publicUser(u), last: { text: last.text, at: last.at, mine: last.from === me }, unread: unreadWith(me, other) } : null;
  }).filter(Boolean).sort((a, b) => b.last.at - a.last.at);
  res.json({ conversations: convos, unread: unreadTotal(me) });
});
app.get('/api/messages/:username', auth, (req, res) => {
  const u = findByUsername(cleanUsername(req.params.username));
  if (!u) return res.status(404).json({ error: 'This person no longer exists.' });
  const me = req.user.id, list = db.messages[convoKey(me, u.id)] || [];
  (db.reads[me] = db.reads[me] || {})[u.id] = now(); save();
  res.json({ user: { ...publicUser(u), isFollowing: isFollowing(me, u.id) }, canSend: canMessage(me, u.id),
    messages: list.slice(-300).map(m => ({ id: m.id, text: m.text, at: m.at, mine: m.from === me })) });
});
app.post('/api/messages/:username', auth, (req, res) => {
  const u = findByUsername(cleanUsername(req.params.username));
  if (!u) return res.status(404).json({ error: 'This person no longer exists.' });
  if (u.id === req.user.id) return res.status(400).json({ error: "You can't message yourself." });
  if (!canMessage(req.user.id, u.id)) return res.status(403).json({ error: `Follow @${u.username} to send them a message.` });
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write a message first.' });
  if (text.length > MESSAGE_MAX) return res.status(400).json({ error: 'Messages can be up to 2,000 characters.' });
  const m = { id: uid(), from: req.user.id, to: u.id, text, at: now() };
  (db.messages[convoKey(req.user.id, u.id)] = db.messages[convoKey(req.user.id, u.id)] || []).push(m);
  (db.reads[req.user.id] = db.reads[req.user.id] || {})[u.id] = m.at; save();
  notify(u.id, { title: `Message from @${req.user.username}`, body: text.slice(0, 140), url: '/?action=messages&with=' + encodeURIComponent(req.user.username) });
  res.json({ message: { id: m.id, text, at: m.at, mine: true } });
});

/* Notifications */
app.get('/api/push/key', (req, res) => res.json({ key: db.vapid.publicKey }));
app.post('/api/push/subscribe', auth, (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: 'Notification setup failed. Try again.' });
  // One phone belongs to one account at a time
  Object.keys(db.push).forEach(id => { db.push[id] = db.push[id].filter(x => x.endpoint !== sub.endpoint); });
  (db.push[req.user.id] = db.push[req.user.id] || []).push({ endpoint: sub.endpoint, keys: sub.keys });
  save(); res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth, (req, res) => {
  const ep = req.body && req.body.endpoint;
  db.push[req.user.id] = (db.push[req.user.id] || []).filter(x => x.endpoint !== ep); save(); res.json({ ok: true });
});

/* Errors */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err instanceof UserError) return res.status(err.code).json({ error: err.message });
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `Files can be up to ${MAX_UPLOAD_MB} MB.` });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});

app.listen(PORT, () => console.log(`StoryT running on port ${PORT}. Data folder: ${DATA_DIR}`));
