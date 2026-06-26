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

### 2. Get your Firebase **Web App** config (different from the service account key)
This is required for `public/index.html` to read from Firebase.
1. Firebase Console → Project Settings (gear icon) → General tab
2. Scroll to "Your apps" → click the `</>` (Web) icon to register a web app
3. Skip Firebase Hosting setup if prompted
4. Copy the `firebaseConfig` object shown — it has `apiKey`, `authDomain`, etc.
5. Open `public/index.html`, find this block near the top of the final
   `<script>` section, and replace the placeholders:

```js
const firebaseConfig = {
  apiKey: "__FIREBASE_API_KEY__",
  authDomain: "__FIREBASE_AUTH_DOMAIN__",
  databaseURL: "__FIREBASE_DB_URL__",
  projectId: "__FIREBASE_PROJECT_ID__"
};
```

These are **public, safe-to-expose** values — they're meant to be embedded in
client-side code. They are NOT the same as the private service account key.

### 3. Push this repo to GitHub
```
git init
git add .
git commit -m "Shared 24/7 scalper engine"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 4. Deploy to Render
1. Go to https://dashboard.render.com → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Add Environment Variables (Render dashboard → Environment tab):
   - `FIREBASE_DB_URL` = `https://YOUR-PROJECT-default-rtdb.firebaseio.com`
   - `FIREBASE_SERVICE_ACCOUNT` = the **entire contents** of your downloaded
     service account JSON file, pasted as one value (Render handles multi-line
     values fine — just paste the whole JSON object).
5. Click **Create Web Service**. Wait for the build + deploy to finish.
6. Your live URL will be something like `https://your-app.onrender.com`

### 5. Keep it awake 24/7 (free tier sleeps after 15 min idle)
1. Go to https://uptimerobot.com → sign up free
2. Add New Monitor → HTTP(s) → paste your Render URL + `/health`
   (e.g. `https://your-app.onrender.com/health`)
3. Set check interval to 5 minutes
4. Save

That's it — your engine now runs continuously, and `your-app.onrender.com`
is the single link you share. Everyone who opens it sees the same live
balance, positions, and trade history, updating in real time.

## Notes
- The first visit after a cold start may take ~30-60s if UptimeRobot's ping
  was somehow missed — this is normal Render free-tier behavior, not a bug.
- The engine resumes automatically (still running) if Render restarts the
  service for any reason, since state is persisted to Firebase, not the
  local filesystem.
- Firebase test mode rules allow open read/write. Since there's no real
  money or personal user data here, this is acceptable for this project. If
  you want to lock it down further later, look up Firebase Realtime Database
  security rules.
