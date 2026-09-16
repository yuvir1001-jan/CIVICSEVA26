const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function maskCommenter(row) {
    return {
        id: row.id,
        comment_text: row.comment_text,
        created_at: row.created_at,
        author_role: row.role,
        author_name: row.role === 'citizen' ? 'Anonymous Citizen' : row.name,
    };
}

// Upvote or downvote a resolution photo. One vote per user; voting again
// changes your existing vote rather than adding a second one.
router.post('/:id/vote', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { vote } = req.body;
        if (![1, -1].includes(vote)) {
            return res.status(400).json({ error: 'vote must be 1 (up) or -1 (down)' });
        }
        await query(
            `INSERT INTO resolution_votes (resolution_photo_id, user_id, vote)
             VALUES ($1, $2, $3)
             ON CONFLICT (resolution_photo_id, user_id) DO UPDATE SET vote = EXCLUDED.vote`,
            [id, req.user.id, vote]
        );
        const tally = await query(
            `SELECT
                COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0)::int AS upvotes,
                COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0)::int AS downvotes
             FROM resolution_votes WHERE resolution_photo_id = $1`,
            [id]
        );
        res.json(tally.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to record vote' });
    }
});

router.post('/:id/comments', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { comment } = req.body;
        if (!comment || !comment.trim()) {
            return res.status(400).json({ error: 'comment text is required' });
        }
        const result = await query(
            `INSERT INTO resolution_comments (resolution_photo_id, user_id, comment_text)
             VALUES ($1, $2, $3) RETURNING id, comment_text, created_at`,
            [id, req.user.id, comment.trim()]
        );
        res.status(201).json({
            comment: maskCommenter({ ...result.rows[0], role: req.user.role, name: req.user.name }),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

module.exports = router;
