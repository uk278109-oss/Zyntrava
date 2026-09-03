# Zyntrava Consolidated Fix

This release locks the current project structure and applies the core compatibility fixes in one batch.

## Fixed
- Single Vercel API router URLs: `/api?action=...`
- Frontend bootstrap/profile/reward/withdraw calls
- Admin API action names
- Firebase user field consistency (`displayName`, `countryCode`, `memberId`)
- Referral query registration hook
- Global protected-page logout control
- Admin logout control
- Node engine pinned to `20.x`

## Keep
- `api/index.js` is the only serverless function.
- Do not recreate old `api/admin/*` or separate API files.
- Keep existing Firebase config and set server environment variables in Vercel.

## Test order
1. Sign up
2. Login after refresh
3. Dashboard
4. Daily reward
5. Spin
6. Profile save
7. Logout and protected-page redirect
8. Admin access with an authorized UID
