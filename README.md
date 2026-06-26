# Scalper Engine — 24/7 Shared Live Bot

This repo contains:
- `server.js` — the engine that runs 24/7 on Render, scans Binance, opens/closes
  simulated trades, and writes the shared state to Firebase.
- `public/index.html` — the viewer page everyone visits. It reads live state
  from Firebase and never simulates anything locally, so every visitor on
  every device sees identical data.

## One-time setup checklist

### 1. Firebase (already done if you followed the chat steps)
- Realtime Database created, in **test mode**.
- Service account key JSON downloaded (keep it private, never commit it).
- Note your Database URL: `https://YOUR-PROJECT-default-rtdb.firebaseio.com`

### 2. Get your Firebase credentials for the server

Open the service account JSON file you downloaded earlier in a text editor.
It has a structure like this (your real values will be much longer):

```json
{
  "project_id": "scalper-engine",
  "client_email": "firebase-adminsdk-xxxxx@scalper-engine.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQ...long...==\n-----END PRIVATE KEY-----\n"
}
```

You'll set 4 environment variables on your host instead of pasting the whole
file in one go — this avoids the "value too long" error some hosts (like
Back4App) enforce (1023 character limit per variable, name + value combined):

- `FIREBASE_PROJECT_ID` = the `project_id` value (short, just paste directly)
- `FIREBASE_CLIENT_EMAIL` = the `client_email` value (short, just paste directly)
- `FIREBASE_PRIVATE_KEY_PART1` = the **first half** of the `private_key` value
- `FIREBASE_PRIVATE_KEY_PART2` = the **second half** of the `private_key` value

**How to split the private_key value:**
1. Copy everything between the quotes after `"private_key":` — including the
   `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` markers and
   all the `\n` characters exactly as written (don't convert them to real
   newlines — leave them as literal backslash-n).
2. This string is usually 1700-1900 characters. Cut it exactly in half by
   character count (any text editor's character count helps here, or just
   estimate the midpoint - it doesn't need to be precise, just roughly half
   so each piece is under ~1000 characters).
3. Paste the first half into `FIREBASE_PRIVATE_KEY_PART1`, second half into
   `FIREBASE_PRIVATE_KEY_PART2`.
4. **Optional but recommended:** run `node test-key-split.js` locally (after
   pasting your two parts into that file temporarily) to confirm the two
   halves reassemble into a valid-looking key before you deploy. Delete your
   real key from that file afterward - never commit it.

If you're on a host without the 1023-char limit (e.g. Render), you can skip
all of this and just set one variable instead:
- `FIREBASE_SERVICE_ACCOUNT` = the entire JSON file content, pasted as-is.

`server.js` automatically detects which method you used.

### 3. Push this repo to GitHub
```
git init
git add .
git commit -m "Shared 24/7 scalper engine"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 4. Deploy to Back4App Containers (no credit card required)
This repo includes a `Dockerfile`, which Back4App Containers requires.

1. Go to https://www.back4app.com → Sign Up (GitHub or Google, no card asked)
2. From the dashboard, choose **Containers** → **New App** → **Deploy from GitHub**
3. Install/authorize the Back4App GitHub App on your repo when prompted
4. Select your repo and branch (`main`)
5. When asked for the Dockerfile path, use: `Dockerfile` (repo root)
6. Add Environment Variables in the app's settings:
   - `FIREBASE_DB_URL` = `https://YOUR-PROJECT-default-rtdb.firebaseio.com`
   - `FIREBASE_PROJECT_ID` = your project id (short)
   - `FIREBASE_CLIENT_EMAIL` = your service account client email (short)
   - `FIREBASE_PRIVATE_KEY_PART1` = first half of your private key (see step 2 above)
   - `FIREBASE_PRIVATE_KEY_PART2` = second half of your private key
   - `PORT` = `3000` (matches the `EXPOSE 3000` in the Dockerfile)
7. Click **Deploy**. Watch the build/deploy logs until it shows as running.
8. Your live URL will be shown on the app's overview page (something like
   `https://your-app-xxxx.back4app.io`).

### 5. Keep it awake 24/7
Back4App Containers on the free tier may also spin down after inactivity
depending on current plan rules — check your app's settings page for any
"sleep after inactivity" toggle. If present, the same trick works:
1. Go to https://uptimerobot.com → sign up free
2. Add New Monitor → HTTP(s) → paste your Back4App URL + `/health`
   (e.g. `https://your-app-xxxx.back4app.io/health`)
3. Set check interval to 5 minutes
4. Save

That's it — your engine now runs continuously, and your Back4App URL
is the single link you share. Everyone who opens it sees the same live
balance, positions, and trade history, updating in real time.

## Notes
- The first visit after a cold start may take some time if a sleep/wake
  cycle applies to your plan — this is normal free-tier behavior, not a bug.
- The engine resumes automatically (still running) if the container restarts
  for any reason, since state is persisted to Firebase, not the
  local filesystem (container filesystems are ephemeral, same as Render's).
- Firebase test mode rules allow open read/write. Since there's no real
  money or personal user data here, this is acceptable for this project. If
  you want to lock it down further later, look up Firebase Realtime Database
  security rules.
