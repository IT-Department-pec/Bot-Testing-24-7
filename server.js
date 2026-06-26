const express = require('express');
const path = require('path');
const axios = require('axios'); // Switched to axios for better reliability
const admin = require('firebase-admin');

// --- FIREBASE SETUP ---
function loadServiceAccountFromEnv() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  return {
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: (process.env.FIREBASE_PRIVATE_KEY_PART1 + 
                  (process.env.FIREBASE_PRIVATE_KEY_PART2 || '') + 
                  (process.env.FIREBASE_PRIVATE_KEY_PART3 || '')).replace(/\\n/g, '\n')
  };
}

const serviceAccount = loadServiceAccountFromEnv();
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- HEALTH CHECK (Crucial for Back4App/Docker) ---
app.get('/health', (req, res) => res.status(200).send('OK'));

// --- SERVER BINDING ---
const PORT = process.env.PORT || 3000;

// IMPORTANT: Binding to '0.0.0.0' is required for Docker containers
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SYSTEM] Scalper engine listening on port ${PORT}`);
});

// --- CORE LOGIC (Rest of your original code follows here) ---
// Note: Replace all instances of `fetch(url)` with `axios.get(url).then(res => res.data)`
// Example:
async function updateLivePricesFromPublicFuturesAPI() {
  try {
    const { data } = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: 3000 });
    // ... rest of your logic
  } catch (err) {
    console.error("Price fetch error:", err.message);
  }
}
