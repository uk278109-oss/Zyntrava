# Zyntrava Final Complete Repair — Deploy

This ZIP is a complete project, not a patch.

## Deploy
1. Extract this ZIP.
2. Replace the files in the existing GitHub repository with the extracted project files.
3. Commit and push to the `main` branch.
4. Let Vercel deploy automatically.

## Do NOT change
- Firebase configuration
- Firebase Realtime Database data
- Vercel Environment Variables
- CPX App ID
- CPX Secure Hash
- Firebase Admin credentials

## Included repairs
- Daily reward balance recovery from backed-up dailyClaims records.
- Daily reward ledger recovery when an older claim was marked but its ledger write failed.
- Dashboard balance/activity synchronization.
- Daily Spin result explicitly displays ZN.
- Spin balance synchronization after a successful spin.
- CPX Research visible in the platform navigation and Earn Center.
- CPX survey API uses the authenticated stable user ID and user IP/user-agent.
- CPX country targeting is passed when available.
- CPX errors are surfaced instead of leaving a permanent loading state.

After deployment, test in this order:
1. Dashboard
2. Daily Rewards
3. Dashboard balance after claim
4. Daily Spin and verify the exact ZN result
5. Tasks → Paid Surveys / CPX Research
6. Wallet
7. Transactions
8. Withdraw
