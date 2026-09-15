const express = require('express');
const { query } = require('../db');

const router = express.Router();

// Public city-wide analytics -- matches the "Choose Your Access Portal ->
// Analytics" card, which doesn't require login.
router.get('/', async (req, res) => {
    try {
        const totalResult = await query('SELECT COUNT(*)::int AS count FROM complaints');
        const total = totalResult.rows[0].count;

        const resolvedResult = await query(
            "SELECT COUNT(*)::int AS count FROM complaints WHERE status = 'RESOLVED'"
        );
        const resolved = resolvedResult.rows[0].count;

        const avgResult = await query(
            `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (now() - created_at)) / 86400), 0) AS avg_days
             FROM complaints`
        );
        const avgResponseDays = Math.round(Number(avgResult.rows[0].avg_days));

        const categoryResult = await query(
            'SELECT category, COUNT(*)::int AS count FROM complaints GROUP BY category ORDER BY count DESC'
        );

        res.json({
            total,
            resolved,
            resolutionRate: total > 0 ? Math.round((resolved / total) * 100) : 0,
            avgResponseDays,
            categories: categoryResult.rows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to compute analytics' });
    }
});

module.exports = router;
