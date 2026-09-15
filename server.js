require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const complaintsRoutes = require('./routes/complaints');
const analyticsRoutes = require('./routes/analytics');
const resolutionPhotosRoutes = require('./routes/resolutionPhotos');

const app = express();

app.use(cors());
// Raised from Express's 100kb default so photo uploads (sent as base64 JSON)
// fit. 15mb of base64 is roughly 10-11MB of actual image data.
app.use(express.json({ limit: '15mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/complaints', complaintsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/resolution-photos', resolutionPhotosRoutes);

app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`CivicChain API listening on http://localhost:${PORT}`);
});
