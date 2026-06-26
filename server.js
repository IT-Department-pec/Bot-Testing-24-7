const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// Use the environment port provided by Back4app or default to 3000
const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Binance API: No API Key required for this public endpoint
const BINANCE_API = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';

/**
 * Fetches the current price from Binance
 */
async function getPrice() {
    try {
        const response = await axios.get(BINANCE_API, { timeout: 3000 });
        return parseFloat(response.data.price);
    } catch (error) {
        // Log the error for debugging, but don't crash the server
        console.error(`[Price Feed Error]: ${error.message}`);
        return null; 
    }
}

// API endpoint for your frontend to fetch the current price
app.get('/api/price', async (req, res) => {
    const price = await getPrice();
    if (price !== null) {
        res.json({ success: true, price: price });
    } else {
        res.status(503).json({ success: false, message: "Price data currently unavailable." });
    }
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SYSTEM] Server is running on port ${PORT}`);
});