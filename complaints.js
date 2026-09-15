const express = require('express');
const { query, pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { GENESIS_HASH, computeHash, verifyChain, normalizeLocation } = require('../utils/blockchain');
const { parseImageDataUrl } = require('../utils/images');

const router = express.Router();

const ALLOWED_STATUSES = ['FILED', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'];
const ALLOWED_PRIORITIES = ['URGENT', 'MEDIUM', 'LOW'];
const OPEN_STATUSES = ['FILED', 'IN_PROGRESS'];

async function nextComplaintCode(client) {
    const result = await client.query('SELECT COUNT(*)::int AS count FROM complaints');
    return `CC-${String(result.rows[0].count + 1).padStart(3, '0')}`;
}

// A citizen's own name should never leak to the public. Officers get the
// real name (they need it to do their job); everyone else sees this.
function maskCommenter(row) {
    return {
        id: row.id,
        comment_text: row.comment_text,
        created_at: row.created_at,
        author_role: row.role,
        author_name: row.role === 'citizen' ? 'Anonymous Citizen' : row.name,
    };
}

// ---- File a new complaint ----
router.post('/', requireAuth, requireRole('citizen'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { category, location, description, priority, images } = req.body;
        if (!location || !description || !category) {
            return res.status(400).json({ error: 'category, location and description are required' });
        }
        const finalPriority = ALLOWED_PRIORITIES.includes(priority) ? priority : 'MEDIUM';
        const locationKey = normalizeLocation(location);

        // Same open problem at the same address gets one shared complaint ID
        // -- point the citizen at it instead of creating a duplicate.
        const existing = await client.query(
            `SELECT c.*,
                    (SELECT COUNT(*)::int FROM complaint_agrees a WHERE a.complaint_id = c.id) AS agree_count
             FROM complaints c
             WHERE c.location_key = $1 AND c.status = ANY($2::complaint_status[])
             ORDER BY c.created_at DESC LIMIT 1`,
            [locationKey, OPEN_STATUSES]
        );
        if (existing.rows.length > 0) {
            const row = existing.rows[0];
            return res.status(200).json({
                duplicate: true,
                complaint: {
                    id: row.id,
                    complaint_code: row.complaint_code,
                    category: row.category,
                    location: row.location,
                    description: row.description,
                    status: row.status,
                    priority: row.priority,
                    created_at: row.created_at,
                    agree_count: row.agree_count,
                },
            });
        }

        let parsedImages;
        try {
            parsedImages = (images || []).map(parseImageDataUrl);
        } catch (imgErr) {
            return res.status(400).json({ error: imgErr.message });
        }

        await client.query('BEGIN');

        const code = await nextComplaintCode(client);
        const complaintResult = await client.query(
            `INSERT INTO complaints (complaint_code, citizen_id, category, location, location_key, description, priority)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [code, req.user.id, category, location, locationKey, description, finalPriority]
        );
        const complaint = complaintResult.rows[0];

        for (const { mimeType, data } of parsedImages) {
            await client.query(
                `INSERT INTO complaint_images (complaint_id, image_data, mime_type, uploaded_at)
                 VALUES ($1, $2, $3, now())`,
                [complaint.id, data, mimeType]
            );
        }

        const timestamp = new Date().toISOString();
        const action = `Complaint filed (priority: ${finalPriority})`;
        const hash = computeHash({
            prevHash: GENESIS_HASH,
            complaintId: complaint.id,
            eventIndex: 0,
            action,
            actorId: req.user.id,
            timestamp,
        });
        await client.query(
            `INSERT INTO complaint_events (complaint_id, event_index, action, actor_id, prev_hash, hash, created_at)
             VALUES ($1, 0, $2, $3, $4, $5, $6)`,
            [complaint.id, action, req.user.id, GENESIS_HASH, hash, timestamp]
        );

        await client.query('COMMIT');
        res.status(201).json({ duplicate: false, complaint });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Failed to file complaint' });
    } finally {
        client.release();
    }
});

// ---- Add my agreement to an existing complaint ----
router.post('/:id/agree', requireAuth, requireRole('citizen'), async (req, res) => {
    try {
        const { id } = req.params;
        await query(
            `INSERT INTO complaint_agrees (complaint_id, user_id) VALUES ($1, $2)
             ON CONFLICT (complaint_id, user_id) DO NOTHING`,
            [id, req.user.id]
        );
        const countResult = await query('SELECT COUNT(*)::int AS count FROM complaint_agrees WHERE complaint_id = $1', [id]);
        res.json({ agree_count: countResult.rows[0].count });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to record agreement' });
    }
});

// ---- Comment on a complaint (citizen or officer) ----
router.post('/:id/comments', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { comment } = req.body;
        if (!comment || !comment.trim()) {
            return res.status(400).json({ error: 'comment text is required' });
        }
        const result = await query(
            `INSERT INTO complaint_comments (complaint_id, user_id, comment_text)
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

// ---- Citizen: my own complaints ----
router.get('/mine', requireAuth, requireRole('citizen'), async (req, res) => {
    const result = await query(
        `SELECT c.*,
                (SELECT COUNT(*)::int FROM complaint_agrees a WHERE a.complaint_id = c.id) AS agree_count,
                (SELECT COUNT(*)::int FROM complaint_comments cm WHERE cm.complaint_id = c.id) AS comment_count,
                (SELECT json_build_object('data', image_data, 'mime_type', mime_type) FROM complaint_images ci WHERE ci.complaint_id = c.id ORDER BY id ASC LIMIT 1) AS thumbnail
         FROM complaints c
         WHERE c.citizen_id = $1
         ORDER BY c.created_at DESC`,
        [req.user.id]
    );
    res.json({ complaints: result.rows });
});

// ---- Public: browsable community feed (no images in the list -- keeps it light) ----
router.get('/public', async (req, res) => {
    try {
        const result = await query(
            `SELECT c.id, c.complaint_code, c.category, c.location, c.description, c.status, c.priority, c.created_at,
                    (SELECT COUNT(*)::int FROM complaint_agrees a WHERE a.complaint_id = c.id) AS agree_count,
                    (SELECT COUNT(*)::int FROM complaint_comments cm WHERE cm.complaint_id = c.id) AS comment_count,
                    (SELECT json_build_object('data', image_data, 'mime_type', mime_type) FROM complaint_images ci WHERE ci.complaint_id = c.id ORDER BY id ASC LIMIT 1) AS thumbnail
             FROM complaints c
             ORDER BY c.created_at DESC
             LIMIT 100`
        );
        res.json({ complaints: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load community feed' });
    }
});

// ---- Public: full detail for one complaint (images, comments, resolution photos) ----
router.get('/:id/detail', async (req, res) => {
    try {
        const { id } = req.params;
        const complaintResult = await query('SELECT * FROM complaints WHERE id = $1', [id]);
        if (complaintResult.rows.length === 0) {
            return res.status(404).json({ error: 'Complaint not found' });
        }
        const complaint = complaintResult.rows[0];

        const [images, agreeCount, commentsRaw, resolutionPhotosRaw] = await Promise.all([
            query('SELECT id, image_data, mime_type, uploaded_at FROM complaint_images WHERE complaint_id = $1 ORDER BY id ASC', [id]),
            query('SELECT COUNT(*)::int AS count FROM complaint_agrees WHERE complaint_id = $1', [id]),
            query(
                `SELECT cm.id, cm.comment_text, cm.created_at, u.role, u.name
                 FROM complaint_comments cm JOIN users u ON u.id = cm.user_id
                 WHERE cm.complaint_id = $1 ORDER BY cm.created_at ASC`,
                [id]
            ),
            query('SELECT id, image_data, mime_type, uploaded_at FROM resolution_photos WHERE complaint_id = $1 ORDER BY id ASC', [id]),
        ]);

        const resolutionPhotos = await Promise.all(
            resolutionPhotosRaw.rows.map(async (photo) => {
                const [votes, comments] = await Promise.all([
                    query(
                        `SELECT
                            COALESCE(SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END), 0)::int AS upvotes,
                            COALESCE(SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END), 0)::int AS downvotes
                         FROM resolution_votes WHERE resolution_photo_id = $1`,
                        [photo.id]
                    ),
                    query(
                        `SELECT rc.id, rc.comment_text, rc.created_at, u.role, u.name
                         FROM resolution_comments rc JOIN users u ON u.id = rc.user_id
                         WHERE rc.resolution_photo_id = $1 ORDER BY rc.created_at ASC`,
                        [photo.id]
                    ),
                ]);
                return {
                    ...photo,
                    upvotes: votes.rows[0].upvotes,
                    downvotes: votes.rows[0].downvotes,
                    comments: comments.rows.map(maskCommenter),
                };
            })
        );

        // Never send citizen_id, and never resolve it to a name here --
        // this is the public endpoint.
        delete complaint.citizen_id;

        res.json({
            complaint,
            images: images.rows,
            agree_count: agreeCount.rows[0].count,
            comments: commentsRaw.rows.map(maskCommenter),
            resolution_photos: resolutionPhotos,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load complaint detail' });
    }
});

// ---- Officer/Admin: every complaint (marks newly-listed ones as "seen") ----
router.get('/', requireAuth, requireRole('officer', 'admin'), async (req, res) => {
    try {
        const { status } = req.query;
        const result = status
            ? await query(
                  `SELECT c.*, u.name AS citizen_name,
                          (SELECT COUNT(*)::int FROM complaint_agrees a WHERE a.complaint_id = c.id) AS agree_count,
                          (SELECT json_build_object('data', image_data, 'mime_type', mime_type) FROM complaint_images ci WHERE ci.complaint_id = c.id ORDER BY id ASC LIMIT 1) AS thumbnail
                   FROM complaints c JOIN users u ON u.id = c.citizen_id
                   WHERE c.status = $1 ORDER BY c.created_at DESC`,
                  [status]
              )
            : await query(
                  `SELECT c.*, u.name AS citizen_name,
                          (SELECT COUNT(*)::int FROM complaint_agrees a WHERE a.complaint_id = c.id) AS agree_count,
                          (SELECT json_build_object('data', image_data, 'mime_type', mime_type) FROM complaint_images ci WHERE ci.complaint_id = c.id ORDER BY id ASC LIMIT 1) AS thumbnail
                   FROM complaints c JOIN users u ON u.id = c.citizen_id
                   ORDER BY c.created_at DESC`
              );

        const unseenIds = result.rows.filter((c) => !c.seen_at).map((c) => c.id);
        if (unseenIds.length > 0) {
            const updated = await query(
                `UPDATE complaints SET seen_at = now() WHERE id = ANY($1::int[]) RETURNING id, seen_at`,
                [unseenIds]
            );
            const seenMap = new Map(updated.rows.map((r) => [r.id, r.seen_at]));
            result.rows.forEach((c) => {
                if (seenMap.has(c.id)) c.seen_at = seenMap.get(c.id);
            });
        }

        res.json({ complaints: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load complaints' });
    }
});

// ---- Officer/Admin: change status (optionally attaching a resolution photo) ----
router.patch('/:id/status', requireAuth, requireRole('officer', 'admin'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { status, resolutionPhoto } = req.body;
        if (!ALLOWED_STATUSES.includes(status)) {
            return res.status(400).json({ error: `status must be one of ${ALLOWED_STATUSES.join(', ')}` });
        }

        let parsedPhoto = null;
        if (resolutionPhoto) {
            try {
                parsedPhoto = parseImageDataUrl(resolutionPhoto);
            } catch (imgErr) {
                return res.status(400).json({ error: imgErr.message });
            }
        }

        await client.query('BEGIN');

        const complaintResult = await client.query('SELECT * FROM complaints WHERE id = $1 FOR UPDATE', [id]);
        if (complaintResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Complaint not found' });
        }

        const lastEventResult = await client.query(
            'SELECT * FROM complaint_events WHERE complaint_id = $1 ORDER BY event_index DESC LIMIT 1',
            [id]
        );
        const lastEvent = lastEventResult.rows[0];
        const nextIndex = lastEvent.event_index + 1;
        const timestamp = new Date().toISOString();
        const action = `Status changed to ${status}`;
        const hash = computeHash({
            prevHash: lastEvent.hash,
            complaintId: id,
            eventIndex: nextIndex,
            action,
            actorId: req.user.id,
            timestamp,
        });

        await client.query(
            `INSERT INTO complaint_events (complaint_id, event_index, action, actor_id, prev_hash, hash, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, nextIndex, action, req.user.id, lastEvent.hash, hash, timestamp]
        );

        if (parsedPhoto) {
            await client.query(
                `INSERT INTO resolution_photos (complaint_id, officer_id, image_data, mime_type, uploaded_at)
                 VALUES ($1, $2, $3, $4, now())`,
                [id, req.user.id, parsedPhoto.data, parsedPhoto.mimeType]
            );
        }

        const updated = await client.query(
            'UPDATE complaints SET status = $1, updated_at = now(), seen_at = COALESCE(seen_at, now()) WHERE id = $2 RETURNING *',
            [status, id]
        );

        await client.query('COMMIT');
        res.json({ complaint: updated.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Failed to update status' });
    } finally {
        client.release();
    }
});

// ---- Public: look up a complaint by its code and verify ledger integrity ----
// Citizen identity is never included here -- this is the public page.
router.get('/verify/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const complaintResult = await query('SELECT * FROM complaints WHERE complaint_code = $1', [code.trim().toUpperCase()]);
        if (complaintResult.rows.length === 0) {
            return res.status(404).json({ error: 'No complaint found with this ID' });
        }
        const complaint = complaintResult.rows[0];
        delete complaint.citizen_id;

        const eventsResult = await query(
            `SELECT e.event_index, e.action, e.prev_hash, e.hash, e.created_at,
                    CASE WHEN u.role = 'citizen' THEN 'Anonymous Citizen' ELSE u.name END AS actor_name
             FROM complaint_events e
             LEFT JOIN users u ON u.id = e.actor_id
             WHERE e.complaint_id = $1 ORDER BY e.event_index ASC`,
            [complaint.id]
        );

        // verifyChain needs the raw actor_id/prev_hash/hash it was built
        // against -- re-fetch those un-masked fields just for the check.
        const rawEvents = await query(
            'SELECT * FROM complaint_events WHERE complaint_id = $1 ORDER BY event_index ASC',
            [complaint.id]
        );

        res.json({
            complaint,
            events: eventsResult.rows,
            verified: verifyChain(rawEvents.rows),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

module.exports = router;
