# Zyntrava — Current Repair Package

## What was repaired
- Daily reward now creates a missing user wallet record before claiming.
- Daily reward remains server-authoritative and duplicate protected.
- Daily Spin now repairs a missing spin ledger entry if the wallet was already credited.
- Daily Spin returns a clear failure instead of falsely reporting a successful saved reward.
- Admin dashboard now shows a readable configuration/authorization error instead of silently failing.
- Existing Admin Panel remains at `/admin.html`.
- Existing Firebase client configuration was NOT changed.

## Important: Vercel Environment Variables
The frontend cannot safely write rewards itself. The `/api` backend requires these Vercel variables:

- FIREBASE_PROJECT_ID
- FIREBASE_CLIENT_EMAIL
- FIREBASE_PRIVATE_KEY
- FIREBASE_DATABASE_URL
- ADMIN_UIDS

Recommended:
- DAILY_REWARD_POINTS=10
- SPIN_REWARDS=2,5,10,15
- POINTS_PER_CURRENCY_UNIT=100

`FIREBASE_PRIVATE_KEY` must contain the service-account private key and its line breaks must be preserved/escaped correctly in Vercel.

## Admin Panel
After signing in with the Firebase account whose UID is included in `ADMIN_UIDS`, open:

`/admin.html`

The Admin Panel can:
- create/activate/pause/end earning tasks
- review task submissions
- approve/reject submissions and credit ZN
- review withdrawals
- send member notifications

## Deployment
1. Replace the repository files with this package.
2. Commit/push to `main`.
3. Wait for Vercel deployment to finish.
4. Confirm the Vercel Environment Variables above are present for the Production environment.
5. Redeploy after changing environment variables.
6. Sign in, open Dashboard, then test Daily Rewards and Daily Spin.
7. Open `/admin.html` with the authorized admin account.

## One critical check
`firebase-config.js` currently points the browser to the existing `onedollarapk-ce3cc` Firebase project. The Vercel `FIREBASE_PROJECT_ID` and `FIREBASE_DATABASE_URL` MUST point to the same Firebase project/database. If they point to a different project, rewards and dashboard data will appear not to save.
