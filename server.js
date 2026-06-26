const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// Reliable Binance API endpoint
const PRICE_API_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';

async function getPrice() {
    try {
        const response = await axios.get(PRICE_API_URL, { timeout: 5000 });
        return parseFloat(response.data.price);
    } catch (error) {
        console.error(`[Price Fetch Error]: ${error.message}`);
        return null; // Return null so the logic can handle the retry gracefully
    }
}

// Endpoint for your frontend to call
app.get('/api/price', async (req, res) => {
    const price = await getPrice();
    if (price) {
        res.json({ success: true, price });
    } else {
        res.status(503).json({ success: false, message: "Price feed currently unavailable" });
    }
});

app.listen(PORT, () => {
    console.log(`[SYSTEM] Server running on port ${PORT}`);
});
