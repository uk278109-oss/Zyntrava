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

// Recover only missing balance that is already backed by verified ledger entries.
// This is intentionally upward-only: it never reduces a user's existing balance.
async function reconcileUserFromLedger(uid) {
  const [userSnap, txSnap, notifSnap] = await Promise.all([
    db().ref('users/' + uid).once('value'),
    db().ref('transactions/' + uid).once('value'),
    db().ref('notifications/' + uid).once('value')
  ]);
  const user = userSnap.val();
  if (!user) return { changed: false, points: 0, earnedPoints: 0 };

  const txs = Object.values(txSnap.val() || {});
  let ledgerCredits = 0;
  let ledgerDebits = 0;
  let ledgerDailyCredits = 0;
  for (const tx of txs) {
    const amount = Number(tx?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (tx.direction !== 'debit' && tx.status !== 'reversed') {
      ledgerCredits += amount;
      if (tx.type === 'daily') ledgerDailyCredits += amount;
    } else if (tx.direction === 'debit') {
      ledgerDebits += amount;
    }
  }

  // Older builds could update users/{uid} and then fail before the ledger write.
  // Daily reward notifications are created by the same successful claim flow,
  // so they are valid evidence for recovering a missing daily ledger entry.
  let notificationDailyCredits = 0;
  for (const n of Object.values(notifSnap.val() || {})) {
    if (String(n?.title || '').trim().toLowerCase() !== 'daily reward claimed') continue;
    const m = String(n?.message || '').match(/\+(\d+(?:\.\d+)?)\s*ZN/i);
    if (m) notificationDailyCredits += Number(m[1]);
  }
  const missingDailyCredits = Math.max(0, notificationDailyCredits - ledgerDailyCredits);

  const currentPoints = Number(user.points || 0);
  const currentEarned = Number(user.earnedPoints || 0);
  const ledgerNet = Math.max(0, Math.round(ledgerCredits - ledgerDebits));
  const expectedPoints = Math.max(currentPoints, ledgerNet + Math.round(missingDailyCredits));
  const expectedEarned = Math.max(currentEarned, Math.round(ledgerCredits + missingDailyCredits));

  const updates = {};
  if (expectedPoints > currentPoints) updates.points = expectedPoints;
  if (expectedEarned > currentEarned) updates.earnedPoints = expectedEarned;
  if (!Object.keys(updates).length) return { changed: false, points: currentPoints, earnedPoints: currentEarned };

  const r = await db().ref('users/' + uid).transaction(profile => {
    if (!profile) return;
    profile.points = Math.max(Number(profile.points || 0), expectedPoints);
    profile.earnedPoints = Math.max(Number(profile.earnedPoints || 0), expectedEarned);
    return profile;
  });
  const final = r.snapshot?.val?.() || (await db().ref('users/' + uid).once('value')).val() || {};
  await db().ref('publicProfiles/' + uid).update({
    displayName: final.displayName || 'Member',
    countryCode: final.countryCode || 'Global',
    earnedPoints: Number(final.earnedPoints || 0)
  });
  return { changed: true, points: Number(final.points || 0), earnedPoints: Number(final.earnedPoints || 0) };
}

function todayKey() { return new Date().toISOString().slice(0, 10); }

function cpxHash(transId, secret) {
  return require('crypto').createHash('md5').update(`${transId}-${secret}`).digest('hex');
}
function cpxParam(req, name) {
  return String((req.query && req.query[name]) ?? (req.body && req.body[name]) ?? '').trim();
}
async function handleCpxPostback(req, res) {
  const status = Number(cpxParam(req, 'status'));
  const transId = cpxParam(req, 'trans_id');
  const userId = cpxParam(req, 'user_id');
  const amountZN = Number(cpxParam(req, 'amount_local'));
  const amountUsd = Number(cpxParam(req, 'amount_usd'));
  const hash = cpxParam(req, 'secure_hash');
  const expectedSecret = String(process.env.CPX_SECURE_HASH || '').trim();

  if (!expectedSecret) throw Object.assign(new Error('CPX_SECURE_HASH is not configured'), { status: 503 });
  if (!transId || !userId || ![1, 2].includes(status) || !Number.isFinite(amountZN) || amountZN <= 0) {
    throw Object.assign(new Error('Invalid CPX postback parameters'), { status: 400 });
  }
  if (!hash || hash.toLowerCase() !== cpxHash(transId, expectedSecret)) {
    throw Object.assign(new Error('Invalid CPX postback signature'), { status: 403 });
  }

  const cpxKey = require('crypto').createHash('sha256').update(transId).digest('hex');
  const txRef = db().ref('cpxTransactions/' + cpxKey);
  const existing = (await txRef.once('value')).val();
  const safeUserId = userId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeUserId) throw Object.assign(new Error('Invalid CPX user id'), { status: 400 });

  // Completed -> credit exactly once. A later status=2 reverses the same transaction.
  if (status === 1) {
    if (existing?.status === 'completed' || existing?.status === 'reversed') {
      return send(res, 200, { ok: true, duplicate: true });
    }
    const userRef = db().ref('users/' + safeUserId);
    const reward = Math.round(amountZN);
    let credited = false;
    const r = await userRef.transaction(profile => {
      if (!profile) return;
      if (profile.cpxProcessed && profile.cpxProcessed[cpxKey]) return;
      profile.points = Number(profile.points || 0) + reward;
      profile.earnedPoints = Number(profile.earnedPoints || 0) + reward;
      profile.cpxProcessed = profile.cpxProcessed || {};
      profile.cpxProcessed[cpxKey] = true;
      credited = true;
      return profile;
    });
    if (!r.committed || !credited) return send(res, 200, { ok: true, duplicate: true });

    const profile = r.snapshot.val() || {};
    await txRef.set({
      transId, uid: safeUserId, status: 'completed', amountZN: reward,
      amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
      type: cpxParam(req, 'type') || 'Complete',
      offerId: cpxParam(req, 'offer_id') || cpxParam(req, 'OfferID') || '',
      ipClick: cpxParam(req, 'ip_click'), createdAt: admin.database.ServerValue.TIMESTAMP
    });
    await db().ref('publicProfiles/' + safeUserId).update({
      displayName: profile.displayName || 'Member',
      countryCode: profile.countryCode || 'Global',
      earnedPoints: Number(profile.earnedPoints || 0)
    });
    await addLedger(safeUserId, {
      type: 'cpx-survey', amount: reward, direction: 'credit', status: 'completed',
      description: `CPX Research survey reward`, provider: 'cpx', providerTransactionId: transId,
      amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0
    });
    await addNotification(safeUserId, 'CPX survey reward', `+${reward} ZN was added for your completed survey.`, 'reward');
    return send(res, 200, { ok: true, creditedZN: reward });
  }

  if (existing?.status === 'reversed') return send(res, 200, { ok: true, duplicate: true });
  if (existing?.status !== 'completed') {
    await txRef.set({
      transId, uid: safeUserId, status: 'reversal_without_credit', amountZN: Math.round(amountZN),
      amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
      type: cpxParam(req, 'type') || 'Cancelled', createdAt: admin.database.ServerValue.TIMESTAMP
    });
    return send(res, 200, { ok: true, reversed: false });
  }

  const reversal = Math.round(Number(existing.amountZN || amountZN));
  const userRef = db().ref('users/' + safeUserId);
  let applied = false;
  let debtAdded = 0;
  const r = await userRef.transaction(profile => {
    if (!profile) return;
    const available = Number(profile.points || 0);
    const deduct = Math.min(Math.max(available, 0), reversal);
    profile.points = available - deduct;
    if (deduct < reversal) {
      debtAdded = reversal - deduct;
      profile.cpxReversalDebtZN = Number(profile.cpxReversalDebtZN || 0) + debtAdded;
    }
    profile.cpxProcessed = profile.cpxProcessed || {};
    delete profile.cpxProcessed[cpxKey];
    applied = true;
    return profile;
  });
  if (!r.committed || !applied) throw new Error('Could not apply CPX reversal');
  const profile = r.snapshot.val() || {};
  await txRef.update({ status: 'reversed', reversedAt: admin.database.ServerValue.TIMESTAMP, reversalZN: reversal, debtZN: debtAdded });
  await db().ref('publicProfiles/' + safeUserId).update({ earnedPoints: Number(profile.earnedPoints || 0) });
  await addLedger(safeUserId, {
    type: 'cpx-reversal', amount: reversal, direction: 'debit', status: 'completed',
    description: debtAdded ? `CPX survey reversal (${debtAdded} ZN recorded as reversal debt)` : 'CPX survey reversal',
    provider: 'cpx', providerTransactionId: transId
  });
  await addNotification(safeUserId, 'CPX reward reversed', debtAdded ? `${reversal} ZN was reversed. ${debtAdded} ZN could not be deducted from the current balance and was recorded as reversal debt.` : `${reversal} ZN was reversed by CPX Research.`, 'warning');
  return send(res, 200, { ok: true, reversedZN: reversal, debtZN: debtAdded });
}

async function handleCpxSurveys(req, res) {
  const u = await auth(req);
  const secret = String(process.env.CPX_SECURE_HASH || '').trim();
  if (!secret) throw Object.assign(new Error('CPX_SECURE_HASH is not configured in Vercel Environment Variables'), { status: 503 });

  const crypto = require('crypto');
  const secureHash = crypto.createHash('md5').update(`${u.uid}-${secret}`).digest('hex');
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  const cloudflareIp = String(req.headers['cf-connecting-ip'] || '').trim();
  const socketIp = String(req.socket?.remoteAddress || '').trim();
  let ip = forwarded || realIp || cloudflareIp || socketIp;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const userAgent = String(req.headers['user-agent'] || '').trim();
  if (!ip) throw Object.assign(new Error('CPX could not determine your IP address.'), { status: 502 });

  const params = new URLSearchParams({
    app_id: '35839', ext_user_id: String(u.uid), email: String(u.email || ''),
    subid_1: '', subid_2: '', output_method: 'api', ip_user: ip,
    user_agent: userAgent, limit: '12', secure_hash: secureHash
  });
  const url = `https://live-api.cpx-research.com/api/get-surveys.php?${params.toString()}`;
  let response;
  try { response = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } }); }
  catch (e) { throw Object.assign(new Error('CPX connection failed. Please try again in a moment.'), { status: 502 }); }
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); }
  catch (_) { throw Object.assign(new Error(`CPX returned a non-JSON response (HTTP ${response.status}).`), { status: 502 }); }
  if (!response.ok || String(data.status || '').toLowerCase() !== 'success') {
    const detail = data.message || data.error || data.status_message || data.error_message || '';
    throw Object.assign(new Error(String(detail || `CPX returned HTTP ${response.status || 502}`)), { status: 502 });
  }
  const surveys = Array.isArray(data.surveys) ? data.surveys : [];
  return send(res, 200, {
    ok: true,
    count: Number(data.count_returned_surveys || surveys.length || 0),
    surveys: surveys.map(s => ({
      id: s.id, loi: s.loi, payout: s.payout,
      payout_publisher_usd: s.payout_publisher_usd,
      conversion_rate: s.conversion_rate,
      quality_score: s.quality_score ?? s.score,
      top: s.top, type: s.type,
      href: s.href_new || s.href || ''
    })).filter(s => s.href)
  });
}

const handlers = {
async 'cpx-surveys'(req, res) { return await handleCpxSurveys(req, res); },
  async 'cpx-frame'(req, res) {
    const u = await auth(req);
    const secret = String(process.env.CPX_SECURE_HASH || '').trim();
    if (!secret) throw Object.assign(new Error('CPX_SECURE_HASH is not configured'), { status: 503 });
    const crypto = require('crypto');
    const secureHash = crypto.createHash('md5').update(`${u.uid}-${secret}`).digest('hex');
    const params = new URLSearchParams({
      app_id: '35839',
      ext_user_id: u.uid,
      secure_hash: secureHash,
      username: u.email ? u.email.split('@')[0] : 'Member',
      email: u.email || '',
      subid_1: '',
      subid_2: ''
    });
    return send(res, 200, { ok: true, url: `https://offers.cpx-research.com/index.php?${params.toString()}` });
  },
  async 'bootstrap-user'(req, res) {
    const u = await auth(req);
    const ref = db().ref('users/' + u.uid);
    const s = await ref.once('value');
    const existing = s.val() || {};
    if (!s.exists()) {
      const member = 'ZY-' + u.uid.slice(0, 6).toUpperCase();
      const code = 'ZY' + u.uid.slice(0, 8).toUpperCase();
      const displayName = (u.email || 'Member').split('@')[0];
      await ref.set({ uid: u.uid, email: u.email || '', displayName, memberId: member, referralCode: code, countryCode: 'PK', points: 0, pointsLocked: 0, earnedPoints: 0, referrals: 0, plan: 'Free', createdAt: admin.database.ServerValue.TIMESTAMP });
      await db().ref('publicProfiles/' + u.uid).set({ uid: u.uid, displayName, countryCode: 'PK', earnedPoints: 0 });
    } else {
      const patch = {};
      if (!existing.uid) patch.uid = u.uid;
      if (!existing.email && u.email) patch.email = u.email;
      if (existing.pointsLocked == null) patch.pointsLocked = 0;
      if (existing.points == null) patch.points = 0;
      if (existing.earnedPoints == null) patch.earnedPoints = 0;
      if (!existing.memberId) patch.memberId = 'ZY-' + u.uid.slice(0, 6).toUpperCase();
      if (!existing.referralCode) patch.referralCode = 'ZY' + u.uid.slice(0, 8).toUpperCase();
      if (!existing.countryCode) patch.countryCode = 'PK';
      if (Object.keys(patch).length) await ref.update(patch);
      const merged = { ...existing, ...patch };
      await db().ref('publicProfiles/' + u.uid).update({ uid: u.uid, displayName: merged.displayName || 'Member', countryCode: merged.countryCode || 'PK', earnedPoints: Number(merged.earnedPoints || 0), memberId: merged.memberId || '' });
    }
    await reconcileUserFromLedger(u.uid);
    return send(res, 200, { ok: true });
  },

  async 'claim-daily'(req, res) {
    const u = await auth(req), key = todayKey();
    const reward = Number(process.env.DAILY_REWARD_POINTS || 10);
    if (!Number.isFinite(reward) || reward <= 0) throw Object.assign(new Error('Daily reward configuration is invalid'), { status: 503 });
    const ref = db().ref('users/' + u.uid);
    let claimed = false;
    const r = await ref.transaction(p => {
      if (!p || p.lastDailyClaim === key) return;
      claimed = true;
      p.points = Number(p.points || 0) + reward;
      p.earnedPoints = Number(p.earnedPoints || 0) + reward;
      p.lastDailyClaim = key;
      return p;
    });
    const current = r.snapshot?.val?.() || (await ref.once('value')).val() || {};
    if (!r.committed || !claimed) {
      return send(res, 200, { ok: true, alreadyClaimed: true, reward: 0, points: Number(current.points || 0), earnedPoints: Number(current.earnedPoints || 0), pointsLocked: Number(current.pointsLocked || 0), lastDailyClaim: current.lastDailyClaim || null });
    }
    await db().ref('dailyClaims/' + u.uid + '/' + key).set({ uid: u.uid, date: key, rewardZN: reward, createdAt: admin.database.ServerValue.TIMESTAMP });
    const ledgerRef = db().ref('transactions/' + u.uid + '/daily_' + key);
    await ledgerRef.set({ id: ledgerRef.key, type: 'daily', amount: reward, direction: 'credit', status: 'completed', description: 'Daily reward', rewardDate: key, createdAt: admin.database.ServerValue.TIMESTAMP });
    await db().ref('publicProfiles/' + u.uid).update({ displayName: current.displayName || 'Member', countryCode: current.countryCode || 'Global', earnedPoints: Number(current.earnedPoints || 0) });
    await addNotification(u.uid, 'Daily reward claimed', `+${reward} ZN added to your wallet.`, 'reward');
    return send(res, 200, { ok: true, reward, points: Number(current.points || 0), earnedPoints: Number(current.earnedPoints || 0), pointsLocked: Number(current.pointsLocked || 0), lastDailyClaim: current.lastDailyClaim || null });
  },

  async 'profile'(req, res) {
    const u = await auth(req), b = req.body || {};
    const displayName = String(b.displayName || 'Member').trim().slice(0, 50) || 'Member';
    const countryCode = String(b.countryCode || 'PK').trim().slice(0, 4).toUpperCase();
    const bio = String(b.bio || '').trim().slice(0, 160);
    const avatarData = String(b.avatarData || '').trim();
    if (avatarData && (!avatarData.startsWith('data:image/') || avatarData.length > 380000)) {
      throw Object.assign(new Error('Profile image must be a compressed image under 250 KB.'), { status: 400 });
    }

    const ref = db().ref('users/' + u.uid);
    let completionReward = 0;
    const reward = Number(process.env.PROFILE_COMPLETION_REWARD_ZN || 25);

    const tx = await ref.transaction(p => {
      if (!p) return;
      const wasComplete = p.profileCompleted === true;
      p.displayName = displayName;
      p.countryCode = countryCode;
      p.bio = bio;
      if (avatarData) p.avatarData = avatarData;
      const nowComplete = Boolean(displayName && countryCode && bio && (p.avatarData || u.picture));
      if (!wasComplete && nowComplete) {
        p.profileCompleted = true;
        p.profileCompletedAt = Date.now();
        if (Number.isFinite(reward) && reward > 0) {
          p.points = Number(p.points || 0) + reward;
          p.earnedPoints = Number(p.earnedPoints || 0) + reward;
          p.profileRewardIssued = true;
          completionReward = reward;
        }
      }
      return p;
    });

    const p = tx.snapshot.val() || {};
    await db().ref('publicProfiles/' + u.uid).update({
      displayName, countryCode, bio,
      avatarData: p.avatarData || u.picture || '',
      earnedPoints: p.earnedPoints || 0,
      memberId: p.memberId || ''
    });

    if (completionReward > 0) {
      await addLedger(u.uid, {
        type: 'profile-completion', amount: completionReward,
        direction: 'credit', status: 'completed',
        description: 'Profile completion reward'
      });
      await addNotification(u.uid, 'Profile completed', `Your profile completion reward of +${completionReward} ZN was added.`, 'reward');
    }
    return send(res, 200, { ok: true, completionReward, profile: p });
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
    const rewards = (process.env.SPIN_REWARDS || '2,5,10,15').split(',').map(Number).filter(x => Number.isFinite(x) && x > 0);
    if (!rewards.length) throw Object.assign(new Error('Spin reward configuration is invalid'), { status: 503 });
    const reward = rewards[Math.floor(Math.random() * rewards.length)];
    const ref = db().ref('users/' + u.uid); let ok = false;
    const r = await ref.transaction(p => { if (!p || p.lastSpin === key) return; ok = true; p.lastSpin = key; p.points = Number(p.points || 0) + reward; p.earnedPoints = Number(p.earnedPoints || 0) + reward; return p; });
    const profile = r.snapshot?.val?.() || (await ref.once('value')).val() || {};
    if (!r.committed || !ok) return send(res, 409, { ok: false, error: 'You already used today’s spin', points: Number(profile.points || 0), earnedPoints: Number(profile.earnedPoints || 0), pointsLocked: Number(profile.pointsLocked || 0) });
    const ledgerRef = db().ref('transactions/' + u.uid + '/spin_' + key);
    await ledgerRef.set({ id: ledgerRef.key, type: 'spin', amount: reward, direction: 'credit', status: 'completed', description: 'Daily promotional spin', rewardDate: key, createdAt: admin.database.ServerValue.TIMESTAMP });
    await db().ref('publicProfiles/' + u.uid).update({ displayName: profile.displayName || 'Member', countryCode: profile.countryCode || 'Global', earnedPoints: Number(profile.earnedPoints || 0) });
    await addNotification(u.uid, 'Spin reward', `You received +${reward} ZN.`, 'reward');
    return send(res, 200, { ok: true, reward, points: Number(profile.points || 0), earnedPoints: Number(profile.earnedPoints || 0), pointsLocked: Number(profile.pointsLocked || 0), lastSpin: profile.lastSpin || null });
  },

  async 'opportunities'(req, res) {
    const u = await auth(req);
    const [ts, us, ss] = await Promise.all([
      db().ref('tasks').once('value'),
      db().ref('users/' + u.uid).once('value'),
      db().ref('taskSubmissions/' + u.uid).once('value')
    ]);
    const profile = us.val() || {};
    const submitted = ss.val() || {};
    const country = profile.countryCode || 'PK';
    const items = Object.entries(ts.val() || {})
      .map(([id, x]) => ({ id, ...x }))
      .filter(x => x.status === 'active')
      .filter(x => !Array.isArray(x.countries) || !x.countries.length || x.countries.includes(country) || x.countries.includes('GLOBAL'))
      .map(x => ({
        id: x.id,
        title: String(x.title || 'Verified Opportunity'),
        category: String(x.category || 'Opportunity'),
        instructions: String(x.instructions || 'Complete the requirements and submit valid proof.'),
        rewardZN: Number(x.rewardPoints || x.rewardZN || 0),
        url: String(x.url || ''),
        submitted: Boolean(submitted[x.id])
      }));
    return send(res, 200, { ok: true, opportunities: items });
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
    await reconcileUserFromLedger(u.uid);
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
      lastDailyClaim: profile.lastDailyClaim || null,
      lastSpin: profile.lastSpin || null,
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
  try {
    const action = String((req.query && req.query.action) || '').trim();
    if (action === 'cpx-postback') return await handleCpxPostback(req, res);
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const handler = handlers[action];
    if (!handler) return send(res, 404, { ok: false, error: 'Unknown API action' });
    return await handler(req, res);
  } catch (e) { return fail(res, e); }
};
