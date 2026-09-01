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
    const createdAt = Date.now();
    await db().ref('users/' + u.uid).update({
      referredBy: inviter.uid,
      referralCodeUsed: code,
      referralQualified: false,
      referralRewardIssued: false
    });
    await db().ref('referrals/' + inviter.uid + '/' + u.uid).set({
      uid: u.uid,
      memberId: own.memberId || '',
      status: 'registered',
      qualified: false,
      rewardIssued: false,
      createdAt
    });
    return send(res, 200, { ok: true, linked: true });
  },

  async 'referral-stats'(req, res) {
    const u = await auth(req);
    const own = (await db().ref('users/' + u.uid).once('value')).val() || {};
    const rows = (await db().ref('referrals/' + u.uid).once('value')).val() || {};
    const list = await Promise.all(Object.entries(rows).map(async ([uid, item]) => {
      const profile = (await db().ref('publicProfiles/' + uid).once('value')).val() || {};
      return {
        uid,
        memberId: item.memberId || profile.memberId || '',
        displayName: profile.displayName || 'Zyntrava Member',
        status: item.status || 'registered',
        qualified: item.qualified === true || item.status === 'qualified',
        rewardIssued: item.rewardIssued === true,
        createdAt: item.createdAt || 0,
        qualifiedAt: item.qualifiedAt || 0
      };
    }));
    const qualified = list.filter(x => x.qualified).length;
    const rewarded = list.filter(x => x.rewardIssued).length;
    return send(res, 200, {
      ok: true,
      referralCode: own.referralCode || '',
      total: list.length,
      qualified,
      rewarded,
      referrals: list.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))
    });
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
    await addNotification(u.uid, 'Task submitted', `Your submission for “${task.title}” is pending review.`, 'task');
    return send(res, 200, { ok: true, id });
  },

  async 'withdraw'(req, res) {
    const u = await auth(req);
    const { amount, method, account } = req.body || {};
    const value = Number(amount);
    const cleanMethod = String(method || '').trim();
    const cleanAccount = String(account || '').trim();

    if (!Number.isFinite(value) || value <= 0 || !cleanMethod || !cleanAccount) {
      throw Object.assign(new Error('Complete all withdrawal fields'), { status: 400 });
    }

    const minAmount = Number(process.env.MIN_WITHDRAWAL_AMOUNT || 1);
    const pointsPerUnit = Number(process.env.POINTS_PER_CURRENCY_UNIT || 100);
    if (!Number.isFinite(minAmount) || minAmount <= 0 || !Number.isFinite(pointsPerUnit) || pointsPerUnit <= 0) {
      throw Object.assign(new Error('Withdrawal configuration is unavailable'), { status: 503 });
    }
    if (value < minAmount) {
      throw Object.assign(new Error(`Minimum withdrawal amount is ${minAmount}.`), { status: 400 });
    }

    const lock = Math.ceil(value * pointsPerUnit);
    const existing = await db().ref('withdrawals').orderByChild('uid').equalTo(u.uid).once('value');
    const hasOpenRequest = Object.values(existing.val() || {}).some(x => x && ['pending','approved'].includes(x.status));
    if (hasOpenRequest) {
      throw Object.assign(new Error('You already have a withdrawal request under review. Wait until it is finalized.'), { status: 409 });
    }

    const userRef = db().ref('users/' + u.uid);
    let enough = false;
    const tx = await userRef.transaction(p => {
      if (!p) return;
      const available = Number(p.points || 0);
      if (available < lock) return;
      enough = true;
      p.points = available - lock;
      p.pointsLocked = Number(p.pointsLocked || 0) + lock;
      return p;
    });

    if (!tx.committed || !enough) {
      throw Object.assign(new Error(`Insufficient ZN balance. This request requires ${lock} ZN.`), { status: 409 });
    }

    const id = db().ref('withdrawals').push().key;
    const p = tx.snapshot.val() || {};
    await db().ref('withdrawals/' + id).set({
      id, uid: u.uid, memberId: p.memberId || '',
      country: p.countryCode || 'PK',
      amount: value, method: cleanMethod, account: cleanAccount,
      status: 'pending', pointsLocked: lock,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    await addLedger(u.uid, {
      type: 'withdrawal-request',
      amount: lock, direction: 'debit', status: 'pending',
      description: `Withdrawal request submitted: ${value} via ${cleanMethod}`,
      withdrawalId: id
    });
    await addNotification(u.uid, 'Withdrawal submitted', `${lock} ZN is locked while your request is reviewed.`, 'withdrawal');

    return send(res, 200, {
      ok: true, id, pointsLocked: lock,
      minimumAmount: minAmount, pointsPerUnit
    });
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
      recentTransactions: transactions.slice(0, 8),
      withdrawalConfig: {
        minimumAmount: Number(process.env.MIN_WITHDRAWAL_AMOUNT || 1),
        pointsPerUnit: Number(process.env.POINTS_PER_CURRENCY_UNIT || 100)
      }
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
    const [w, s, u, t] = await Promise.all([
      db().ref('withdrawals').once('value'),
      db().ref('submissions').once('value'),
      db().ref('users').once('value'),
      db().ref('tasks').once('value')
    ]);
    return send(res, 200, {
      ok: true,
      withdrawals: Object.values(w.val() || {}),
      submissions: Object.values(s.val() || {}),
      tasks: Object.values(t.val() || {}),
      userCount: Object.keys(u.val() || {}).length
    });
  },

  async 'admin-create-task'(req, res) {
    const u = await auth(req); requireAdmin(u); const b = req.body || {};
    if (!String(b.title || '').trim() || !Number(b.rewardPoints) || !String(b.instructions || '').trim()) throw Object.assign(new Error('Title, reward and instructions are required'), { status: 400 });
    const ref = db().ref('tasks').push();
    await ref.set({ id: ref.key, title: String(b.title).trim(), category: String(b.category || 'General'), instructions: String(b.instructions).trim(), rewardPoints: Number(b.rewardPoints), countries: Array.isArray(b.countries) ? b.countries : [], url: String(b.url || ''), status: 'active', createdBy: u.uid, createdAt: admin.database.ServerValue.TIMESTAMP });
    return send(res, 200, { ok: true, id: ref.key });
  },

  async 'admin-update-task'(req, res) {
    const a = await auth(req); requireAdmin(a);
    const { id, status } = req.body || {};
    if (!id || !['active', 'paused', 'ended'].includes(status)) {
      throw Object.assign(new Error('Invalid opportunity status'), { status: 400 });
    }
    const ref = db().ref('tasks/' + id);
    const s = await ref.once('value');
    if (!s.exists()) throw Object.assign(new Error('Opportunity not found'), { status: 404 });
    await ref.update({ status, updatedAt: Date.now(), updatedBy: a.uid });
    return send(res, 200, { ok: true, status });
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
      await addNotification(item.uid, 'Task approved', `+${reward} ZN added for “${item.title}”.`, 'reward');

      // A referral qualifies only after the new member completes their first approved opportunity.
      const memberRef = db().ref('users/' + item.uid);
      const qualification = await memberRef.transaction(p => {
        if (!p || !p.referredBy || p.referralQualified === true || p.referralRewardIssued === true) return;
        p.referralQualified = true;
        p.referralQualifiedAt = Date.now();
        p.referralRewardIssued = true;
        return p;
      });

      if (qualification.committed && qualification.snapshot.exists()) {
        const qualifiedMember = qualification.snapshot.val() || {};
        const inviterUid = qualifiedMember.referredBy;
        const referralReward = Number(process.env.REFERRAL_REWARD_ZN || 50);

        if (inviterUid && inviterUid !== item.uid && Number.isFinite(referralReward) && referralReward > 0) {
          await db().ref('users/' + inviterUid).transaction(p => {
            if (!p) return;
            p.points = (p.points || 0) + referralReward;
            p.earnedPoints = (p.earnedPoints || 0) + referralReward;
            p.referrals = (p.referrals || 0) + 1;
            return p;
          });

          await db().ref('referrals/' + inviterUid + '/' + item.uid).update({
            status: 'qualified',
            qualified: true,
            rewardIssued: true,
            qualifiedAt: Date.now(),
            rewardZN: referralReward
          });

          const inviter = (await db().ref('users/' + inviterUid).once('value')).val() || {};
          await db().ref('publicProfiles/' + inviterUid).update({
            displayName: inviter.displayName || 'Zyntrava Member',
            countryCode: inviter.countryCode || 'Global',
            earnedPoints: inviter.earnedPoints || 0
          });

          await addLedger(inviterUid, {
            type: 'referral',
            amount: referralReward,
            direction: 'credit',
            status: 'completed',
            description: 'Qualified referral reward',
            referredMemberId: qualifiedMember.memberId || ''
          });
          await addNotification(inviterUid, 'Referral qualified', `Your referral completed a verified opportunity. +${referralReward} ZN has been added.`, 'reward');
          await addNotification(item.uid, 'Referral qualification complete', 'Your account has completed the referral qualification requirement.', 'referral');
        }
      }
    } else await addNotification(item.uid, 'Task rejected', `Your submission for “${item.title}” was rejected.${note ? ' ' + note : ''}`, 'task');
    return send(res, 200, { ok: true });
  },

  async 'admin-withdraw-status'(req, res) {
    const a = await auth(req); requireAdmin(a);
    const { id, status, note } = req.body || {};
    if (!id || !['approved', 'rejected', 'paid'].includes(status)) {
      throw Object.assign(new Error('Invalid withdrawal status'), { status: 400 });
    }

    const ref = db().ref('withdrawals/' + id);
    const s = await ref.once('value');
    const w = s.val();
    if (!w) throw Object.assign(new Error('Withdrawal not found'), { status: 404 });
    if (['paid','rejected'].includes(w.status)) {
      throw Object.assign(new Error('Withdrawal is already finalized'), { status: 409 });
    }
    if (status === 'paid' && w.status !== 'approved') {
      throw Object.assign(new Error('Approve the withdrawal before marking it paid'), { status: 409 });
    }

    const locked = Number(w.pointsLocked || 0);

    if (status === 'approved') {
      if (w.status !== 'pending') throw Object.assign(new Error('Only pending withdrawals can be approved'), { status: 409 });
      await ref.update({ status: 'approved', reviewNote: String(note || ''), updatedAt: Date.now(), reviewedBy: a.uid, approvedAt: Date.now() });
      await addNotification(w.uid, 'Withdrawal approved', 'Your withdrawal was approved and is awaiting payment processing.', 'withdrawal');
      return send(res, 200, { ok: true });
    }

    if (status === 'rejected') {
      await db().ref('users/' + w.uid).transaction(p => {
        if (!p) return;
        p.points = Number(p.points || 0) + locked;
        p.pointsLocked = Math.max(0, Number(p.pointsLocked || 0) - locked);
        return p;
      });
      await addLedger(w.uid, {
        type: 'withdrawal-refund', amount: locked, direction: 'credit', status: 'completed',
        description: 'Withdrawal rejected — locked ZN returned to wallet', withdrawalId: id
      });
      await ref.update({
        status: 'rejected', reviewNote: String(note || ''), updatedAt: Date.now(),
        reviewedBy: a.uid, rejectedAt: Date.now(), refundedZN: locked
      });
      await addNotification(w.uid, 'Withdrawal rejected', `${locked} ZN was returned to your available wallet balance.`, 'withdrawal');
      return send(res, 200, { ok: true });
    }

    await db().ref('users/' + w.uid).transaction(p => {
      if (!p) return;
      p.pointsLocked = Math.max(0, Number(p.pointsLocked || 0) - locked);
      return p;
    });
    await addLedger(w.uid, {
      type: 'withdrawal-paid', amount: locked, direction: 'debit', status: 'completed',
      description: `Withdrawal paid: ${w.amount} via ${w.method}`, withdrawalId: id
    });
    await ref.update({
      status: 'paid', reviewNote: String(note || ''), updatedAt: Date.now(),
      reviewedBy: a.uid, paidAt: Date.now()
    });
    await addNotification(w.uid, 'Withdrawal paid', 'Your payout was marked as paid by the platform.', 'withdrawal');
    return send(res, 200, { ok: true });
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
