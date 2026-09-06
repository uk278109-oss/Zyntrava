# Zyntrava V4 — actual backend connection repair

IMPORTANT: Upload the CONTENTS of this folder to the ROOT of the GitHub repository. The repository root must contain `index.html`, `app.js`, `api/index.js`, `firebase-config.js`, etc. Do not leave them inside another `Zyntrava-main` folder.

Vercel Environment Variables (Production):
- FIREBASE_PROJECT_ID
- FIREBASE_CLIENT_EMAIL
- FIREBASE_PRIVATE_KEY
- FIREBASE_DATABASE_URL
- ADMIN_UIDS
- DAILY_REWARD_POINTS=10
- SPIN_REWARDS=2,5,10,15
- POINTS_PER_CURRENCY_UNIT=100
- REFERRAL_REWARD_ZN=50

After saving/changing variables, redeploy.

Diagnostic: while logged in, POST /api?action=health can confirm whether the server has its Firebase variables. The response intentionally shows only true/false, never secrets.

The browser Firebase config and server Firebase config MUST refer to the same Firebase project/database.
