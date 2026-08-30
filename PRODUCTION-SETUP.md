# ZYNTRAVA Rewards Production Setup

This version removes fake earning cards and moves reward-changing actions behind Vercel serverless APIs using Firebase Admin.

## 1. Install dependencies
Vercel reads `package.json` and installs `firebase-admin` automatically.

## 2. Add Vercel Environment Variables
Add these in Vercel → Project → Settings → Environment Variables:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `FIREBASE_DATABASE_URL`
- `ADMIN_UIDS` (comma-separated Firebase Auth UID values)
- `DAILY_REWARD_POINTS` (optional, default 10)
- `POINTS_PER_CURRENCY_UNIT` (optional, default 100)
- `SPIN_REWARDS` (optional, e.g. `2,5,10,15`)

Never place the Firebase Admin private key in browser JavaScript.

## 3. Firebase Realtime Database Rules
Review and publish `firebase.rules.json` before public testing.

## 4. First admin setup
1. Create your admin account normally.
2. Open Firebase Authentication and copy its UID.
3. Put that UID in Vercel `ADMIN_UIDS`.
4. Redeploy Vercel.
5. Sign in and open `/admin.html`.

## 5. Real earning flow
- Admin creates a verified task.
- User submits proof.
- Admin approves or rejects.
- Only approved submissions add points through the server API.
- Withdrawal points are locked server-side.
- Rejected withdrawals are refunded server-side.
- Daily rewards and promotional spins are duplicate-protected server-side.

## 6. Advertising
Normal Adsterra/Monetag/AdSense placements should remain platform monetization. Do not automatically award points for ordinary impressions/clicks. Only provider-approved incentivized/rewarded campaigns should appear in `rewardedCampaigns`.

## 7. Before accepting real-money withdrawals
Set real conversion rules, minimum withdrawal thresholds, payout funding controls, fraud monitoring, and applicable legal/tax requirements for the countries you serve.


## Vercel Hobby Function Limit Fix
This version uses one consolidated serverless function: `api/index.js`. Client requests use `/api?action=<action>` so the project stays under the Vercel Hobby serverless-function limit. Do not recreate the old individual API files or `api/admin/` function files.
