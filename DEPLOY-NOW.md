# Zyntrava — Full Production Build

This is the complete project build. Upload/replace the project files as a whole; do not manually patch individual files.

## Keep existing Vercel Environment Variables
- FIREBASE_PROJECT_ID
- FIREBASE_CLIENT_EMAIL
- FIREBASE_PRIVATE_KEY
- FIREBASE_DATABASE_URL
- ADMIN_UIDS
- CPX_SECURE_HASH
- DAILY_REWARD_POINTS (optional; defaults to 10)
- POINTS_PER_CURRENCY_UNIT (optional; defaults to 100)
- MIN_WITHDRAWAL_AMOUNT (optional; defaults to 1)
- REFERRAL_REWARD_ZN (optional; defaults to 50)
- PROFILE_COMPLETION_REWARD_ZN (optional; defaults to 25)
- SPIN_REWARDS (optional; defaults to 2,5,10,15)

Do not put Firebase Admin credentials into frontend files.

## What this build fixes
- Auth/bootstrap race that could make Dashboard request account data before users/{uid} existed.
- Server-authoritative balance refresh on Dashboard, Wallet and Daily Rewards.
- Recovery of missing daily reward ledger entries when older successful daily claims have corresponding reward notifications.
- Deterministic daily and spin transaction IDs to prevent duplicate ledger entries.
- Daily claim button/status now reflects the current UTC claim state.
- Dashboard activity no longer remains stuck on the loading placeholder after an API failure.
- CPX API request follows the current official API format, handles the current response fields, and provides an official CPX iframe fallback if the custom API list is temporarily unavailable.
- CPX survey links use the provider's href_new field when available.
- CPX errors are surfaced instead of silently showing the generic loading state.
- Spin balance immediately syncs to the account UI.
- Duplicate withdrawal-history function and other stale merged frontend fragments removed.

## Important
This build does not invent missing earnings. Only verified ledger records or explicit daily-reward notifications are used for recovery.
