const admin = require('firebase-admin');

function init() {
  if (admin.apps.length) return;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey || !process.env.FIREBASE_DATABASE_URL) {
    throw new Error('Server Firebase environment variables are missing');
  }
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}
function db() { init(); return admin.database(); }
async function auth(req) {
  init();
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  return admin.auth().verifyIdToken(h.slice(7));
}
function requireAdmin(decoded) {
  const ids = (process.env.ADMIN_UIDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (decoded.admin === true || ids.includes(decoded.uid)) return true;
  throw Object.assign(new Error('Admin access required'), { status: 403 });
}
function send(res, status, data) { return res.status(status).json(data); }
function fail(res, e) { return send(res, e.status || 500, { ok: false, error: e.message || 'Server error' }); }
async function addNotification(uid, title, message, type = 'info') {
  const ref = db().ref('notifications/' + uid).push();
  await ref.set({ id: ref.key, title, message, type, read: false, createdAt: admin.database.ServerValue.TIMESTAMP });
}
async function addLedger(uid, data) {
  const ref = db().ref('transactions/' + uid).push();
  await ref.set({ id: ref.key, ...data, createdAt: admin.database.ServerValue.TIMESTAMP });
  return ref.key;
}
function todayKey() { return new Date().toISOString().slice(0, 10); }

const handlers = {
  async 'bootstrap-user'(req, res) {
    const u = await auth(req);
    const ref = db().ref('users/' + u.uid);
    const s = await ref.once('value');
    if (!s.exists()) {
      const member = 'ZY-' + u.uid.slice(0, 6).toUpperCase();
      const code = 'ZY' + u.uid.slice(0, 8).toUpperCase();
      const displayName = (u.email || 'Member').split('@')[0];
      await ref.set({ uid: u.uid, email: u.email || '', displayName, memberId: member, referralCode: code, countryCode: 'PK', points: 0, pointsLocked: 0, earnedPoints: 0, referrals: 0, plan: 'Free', createdAt: admin.database.ServerValue.TIMESTAMP });
      await db().ref('publicProfiles/' + u.uid).set({ uid: u.uid, displayName, countryCode: 'PK', earnedPoints: 0 });
    }
    return send(res, 200, { ok: true });
  },

  async 'claim-daily'(req, res) {
    const u = await auth(req), key = todayKey();
    const reward = Number(process.env.DAILY_REWARD_POINTS || 10);
    const ref = db().ref('users/' + u.uid); let claimed = false;
    const r = await ref.transaction(p => { if (!p || p.lastDailyClaim === key) return; claimed = true; p.points = (p.points || 0) + reward; p.earnedPoints = (p.earnedPoints || 0) + reward; p.lastDailyClaim = key; return p; });
    if (!r.committed || !claimed) return send(res, 409, { ok: false, error: 'Daily reward already claimed' });
    const profile = (await ref.once('value')).val() || {};
    await db().ref('publicProfiles/' + u.uid).update({ displayName: profile.displayName || 'Member', countryCode: profile.countryCode || 'Global', earnedPoints: profile.earnedPoints || 0 });
    await addLedger(u.uid, { type: 'daily', amount: reward, direction: 'credit', status: 'completed', description: 'Daily reward' });
    await addNotification(u.uid, 'Daily reward claimed', `+${reward} points added to your wallet.`, 'reward');
    return send(res, 200, { ok: true, reward });
  },

  async 'profile'(req, res) {
    const u = await auth(req), b = req.body || {};
    const displayName = String(b.displayName || 'Member').trim().slice(0, 50) || 'Member';
    const countryCode = String(b.countryCode || 'PK').trim().slice(0, 4).toUpperCase();
    await db().ref('users/' + u.uid).update({ displayName, countryCode });
    const p = (await db().ref('users/' + u.uid).once('value')).val() || {};
    await db().ref('publicProfiles/' + u.uid).update({ displayName, countryCode, earnedPoints: p.earnedPoints || 0 });
    return send(res, 200, { ok: true });
  },

  async 'register-referral'(req, res) {
    const u = await auth(req), code = String((req.body || {}).code || '').trim().toUpperCase();
    if (!code) return send(res, 200, { ok: true, linked: false });
    const own = (await db().ref('users/' + u.uid).once('value')).val() || {};
    if (own.referredBy) return send(res, 200, { ok: true, linked: false });
    const all = (await db().ref('users').once('value')).val() || {};
    const inviter = Object.values(all).find(x => String(x.referralCode || '').toUpperCase() === code);
    if (!inviter || inviter.uid === u.uid) throw Object.assign(new Error('Referral code is invalid'), { status: 400 });
    await db().ref('users/' + u.uid).update({ referredBy: inviter.uid, referralCodeUsed: code });
    await db().ref('referrals/' + inviter.uid + '/' + u.uid).set({ uid: u.uid, status: 'registered', createdAt: Date.now() });
    return send(res, 200, { ok: true, linked: true });
  },

  async 'spin'(req, res) {
    const u = await auth(req), key = todayKey();
    const rewards = (process.env.SPIN_REWARDS || '2,5,10,15').split(',').map(Number).filter(Number.isFinite);
    const reward = rewards[Math.floor(Math.random() * rewards.length)] || 5; let ok = false;
    const r = await db().ref('users/' + u.uid).transaction(p => { if (!p || p.lastSpin === key) return; ok = true; p.lastSpin = key; p.points = (p.points || 0) + reward; p.earnedPoints = (p.earnedPoints || 0) + reward; return p; });
    if (!r.committed || !ok) return send(res, 409, { ok: false, error: 'You already used today’s spin' });
    const profile = (await db().ref('users/' + u.uid).once('value')).val() || {};
    await db().ref('publicProfiles/' + u.uid).update({ displayName: profile.displayName || 'Member', countryCode: profile.countryCode || 'Global', earnedPoints: profile.earnedPoints || 0 });
    await addLedger(u.uid, { type: 'spin', amount: reward, direction: 'credit', status: 'completed', description: 'Daily promotional spin' });
    await addNotification(u.uid, 'Spin reward', `You received +${reward} points.`, 'reward');
    return send(res, 200, { ok: true, reward });
  },

  async 'task-submit'(req, res) {
    const u = await auth(req), { taskId, proof } = req.body || {};
    if (!taskId || !String(proof || '').trim()) throw Object.assign(new Error('Task and proof are required'), { status: 400 });
    const [ts, us] = await Promise.all([db().ref('tasks/' + taskId).once('value'), db().ref('users/' + u.uid).once('value')]);
    const task = ts.val(), profile = us.val() || {};
    if (!task || task.status !== 'active') throw Object.assign(new Error('Task is not available'), { status: 404 });
    if (Array.isArray(task.countries) && task.countries.length && !task.countries.includes(profile.countryCode)) throw Object.assign(new Error('Task is not available in your country'), { status: 403 });
    if ((await db().ref('taskSubmissions/' + u.uid + '/' + taskId).once('value')).exists()) throw Object.assign(new Error('You already submitted this task'), { status: 409 });
    const id = db().ref('submissions').push().key;
    const data = { id, taskId, uid: u.uid, memberId: profile.memberId || '', title: task.title, rewardPoints: Number(task.rewardPoints || 0), proof: String(proof).trim(), status: 'pending', createdAt: admin.database.ServerValue.TIMESTAMP };
    await db().ref().update({ ['submissions/' + id]: data, ['taskSubmissions/' + u.uid + '/' + taskId]: id });
    await addLedger(u.uid, { type: 'task', amount: Number(task.rewardPoints || 0), direction: 'credit', status: 'pending', description: `Pending verification: ${task.title}`, submissionId: id });
    await addNotification(u.uid, 'Task submitted', `Your submission for “${task.title}” is pending review.`, 'task');
    return send(res, 200, { ok: true, id });
  },

  async 'withdraw'(req, res) {
    const u = await auth(req), { amount, method, account } = req.body || {}; const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0 || !method || !String(account || '').trim()) throw Object.assign(new Error('Complete all withdrawal fields'), { status: 400 });
    const pointsPerUnit = Number(process.env.POINTS_PER_CURRENCY_UNIT || 100), lock = Math.ceil(value * pointsPerUnit), userRef = db().ref('users/' + u.uid); let enough = false;
    const tx = await userRef.transaction(p => { if (!p) return; if ((p.points || 0) < lock) return; enough = true; p.points -= lock; p.pointsLocked = (p.pointsLocked || 0) + lock; return p; });
    if (!tx.committed || !enough) throw Object.assign(new Error(`Not enough points. You need ${lock} points.`), { status: 409 });
    const id = db().ref('withdrawals').push().key, p = tx.snapshot.val() || {};
    await db().ref('withdrawals/' + id).set({ id, uid: u.uid, memberId: p.memberId || '', country: p.countryCode || 'PK', amount: value, method: String(method), account: String(account).trim(), status: 'pending', pointsLocked: lock, createdAt: admin.database.ServerValue.TIMESTAMP });
    await addLedger(u.uid, { type: 'withdrawal', amount: lock, direction: 'debit', status: 'pending', description: `Withdrawal request: ${value} via ${method}`, withdrawalId: id });
    await addNotification(u.uid, 'Withdrawal submitted', 'Your request is pending admin review.', 'withdrawal');
    return send(res, 200, { ok: true, id, pointsLocked: lock });
  },


  async 'account-summary'(req, res) {
    const u = await auth(req);
    const [us, ws, ts] = await Promise.all([
      db().ref('users/' + u.uid).once('value'),
      db().ref('withdrawals').orderByChild('uid').equalTo(u.uid).once('value'),
      db().ref('transactions/' + u.uid).once('value')
    ]);
    const profile = us.val() || {};
    const withdrawals = Object.values(ws.val() || {}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    const transactions = Object.values(ts.val() || {}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    const pendingWithdrawals = withdrawals.filter(x => x.status === 'pending' || x.status === 'approved');
    return send(res, 200, {
      ok: true,
      points: Number(profile.points || 0),
      pointsLocked: Number(profile.pointsLocked || 0),
      earnedPoints: Number(profile.earnedPoints || 0),
      memberId: profile.memberId || '',
      countryCode: profile.countryCode || 'PK',
      pendingWithdrawalCount: pendingWithdrawals.length,
      recentWithdrawals: withdrawals.slice(0, 10),
      recentTransactions: transactions.slice(0, 8)
    });
  },

  async 'withdrawal-history'(req, res) {
    const u = await auth(req);
    const s = await db().ref('withdrawals').orderByChild('uid').equalTo(u.uid).once('value');
    const items = Object.values(s.val() || {}).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    return send(res, 200, { ok: true, items });
  },

  async 'admin-dashboard'(req, res) {
    const a = await auth(req); requireAdmin(a);
    const [w, s, u] = await Promise.all([db().ref('withdrawals').once('value'), db().ref('submissions').once('value'), db().ref('users').once('value')]);
    return send(res, 200, { ok: true, withdrawals: Object.values(w.val() || {}), submissions: Object.values(s.val() || {}), userCount: Object.keys(u.val() || {}).length });
  },

  async 'admin-create-task'(req, res) {
    const u = await auth(req); requireAdmin(u); const b = req.body || {};
    if (!String(b.title || '').trim() || !Number(b.rewardPoints) || !String(b.instructions || '').trim()) throw Object.assign(new Error('Title, reward and instructions are required'), { status: 400 });
    const ref = db().ref('tasks').push();
    await ref.set({ id: ref.key, title: String(b.title).trim(), category: String(b.category || 'General'), instructions: String(b.instructions).trim(), rewardPoints: Number(b.rewardPoints), countries: Array.isArray(b.countries) ? b.countries : [], url: String(b.url || ''), status: 'active', createdBy: u.uid, createdAt: admin.database.ServerValue.TIMESTAMP });
    return send(res, 200, { ok: true, id: ref.key });
  },

  async 'admin-task-status'(req, res) {
    const a = await auth(req); requireAdmin(a); const { id, status, note } = req.body || {};
    if (!id || !['approved', 'rejected'].includes(status)) throw Object.assign(new Error('Invalid request'), { status: 400 });
    const ref = db().ref('submissions/' + id); let item = null;
    const r = await ref.transaction(x => { if (!x || x.status !== 'pending') return; x.status = status; x.reviewNote = String(note || ''); x.reviewedBy = a.uid; x.reviewedAt = Date.now(); item = x; return x; });
    if (!r.committed || !item) throw Object.assign(new Error('Submission was already reviewed'), { status: 409 });
    if (status === 'approved') {
      const reward = Number(item.rewardPoints || 0);
      await db().ref('users/' + item.uid).transaction(p => { if (!p) return; p.points = (p.points || 0) + reward; p.earnedPoints = (p.earnedPoints || 0) + reward; return p; });
      const profile = (await db().ref('users/' + item.uid).once('value')).val() || {};
      await db().ref('publicProfiles/' + item.uid).update({ displayName: profile.displayName || 'Member', countryCode: profile.countryCode || 'Global', earnedPoints: profile.earnedPoints || 0 });
      await addLedger(item.uid, { type: 'task', amount: reward, direction: 'credit', status: 'completed', description: `Approved: ${item.title}`, submissionId: id });
      await addNotification(item.uid, 'Task approved', `+${reward} points added for “${item.title}”.`, 'reward');
    } else await addNotification(item.uid, 'Task rejected', `Your submission for “${item.title}” was rejected.${note ? ' ' + note : ''}`, 'task');
    return send(res, 200, { ok: true });
  },

  async 'admin-withdraw-status'(req, res) {
    const a = await auth(req); requireAdmin(a); const { id, status, note } = req.body || {};
    if (!id || !['approved', 'rejected', 'paid'].includes(status)) throw Object.assign(new Error('Invalid status'), { status: 400 });
    const ref = db().ref('withdrawals/' + id), s = await ref.once('value'), w = s.val();
    if (!w) throw Object.assign(new Error('Withdrawal not found'), { status: 404 });
    if (w.status === 'paid' || w.status === 'rejected') throw Object.assign(new Error('Withdrawal already finalized'), { status: 409 });
    if (status === 'rejected') {
      await db().ref('users/' + w.uid).transaction(p => { if (!p) return; p.points = (p.points || 0) + Number(w.pointsLocked || 0); p.pointsLocked = Math.max(0, (p.pointsLocked || 0) - Number(w.pointsLocked || 0)); return p; });
      await addLedger(w.uid, { type: 'withdrawal-refund', amount: Number(w.pointsLocked || 0), direction: 'credit', status: 'completed', description: 'Rejected withdrawal refunded', withdrawalId: id });
      await addNotification(w.uid, 'Withdrawal rejected', 'Locked points were returned to your wallet.', 'withdrawal');
    }
    if (status === 'paid') {
      await db().ref('users/' + w.uid).transaction(p => { if (!p) return; p.pointsLocked = Math.max(0, (p.pointsLocked || 0) - Number(w.pointsLocked || 0)); return p; });
      await addLedger(w.uid, { type: 'withdrawal-paid', amount: Number(w.pointsLocked || 0), direction: 'debit', status: 'completed', description: `Withdrawal paid: ${w.amount} via ${w.method}`, withdrawalId: id });
      await addNotification(w.uid, 'Withdrawal paid', 'Your payout was marked as paid by the platform.', 'withdrawal');
    } else if (status === 'approved') {
      await addNotification(w.uid, 'Withdrawal approved', 'Your withdrawal was approved and is awaiting payout.', 'withdrawal');
    }
    await ref.update({ status, reviewNote: String(note || ''), updatedAt: Date.now(), reviewedBy: a.uid });
    return send(res, 200, { ok: true });
  },

  async 'admin-notification'(req, res) {
    const a = await auth(req); requireAdmin(a); const { uid, title, message, type = 'info' } = req.body || {};
    if (!uid || !title || !message) throw Object.assign(new Error('Recipient, title and message required'), { status: 400 });
    const ref = db().ref('notifications/' + uid).push();
    await ref.set({ id: ref.key, title, message, type, read: false, createdAt: Date.now(), from: a.uid });
    return send(res, 200, { ok: true, id: ref.key });
  }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  try {
    const action = String((req.query && req.query.action) || '').trim();
    const handler = handlers[action];
    if (!handler) return send(res, 404, { ok: false, error: 'Unknown API action' });
    return await handler(req, res);
  } catch (e) { return fail(res, e); }
};
