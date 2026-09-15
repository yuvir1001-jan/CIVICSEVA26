// Optional: creates one demo citizen, one demo officer, and one resolved
// complaint so you have something to look at immediately after setup.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, query } = require('./db');
const { GENESIS_HASH, computeHash, normalizeLocation } = require('./utils/blockchain');

async function upsertUser({ name, email, password, role }) {
    const existing = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return existing.rows[0];
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *`,
        [name, email, passwordHash, role]
    );
    return result.rows[0];
}

async function seed() {
    const citizen = await upsertUser({
        name: 'Rajesh Kumar',
        email: 'citizen@example.com',
        password: 'password123',
        role: 'citizen',
    });
    const officer = await upsertUser({
        name: 'Officer Priya Singh',
        email: 'officer@example.com',
        password: 'password123',
        role: 'officer',
    });

    const existingComplaint = await query('SELECT id FROM complaints WHERE complaint_code = $1', ['CC-001']);
    if (existingComplaint.rows.length === 0) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const filedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
            const resolvedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

            const complaintResult = await client.query(
                `INSERT INTO complaints (complaint_code, citizen_id, category, location, location_key, description, priority, status, created_at, updated_at)
                 VALUES ('CC-001', $1, 'Pothole / Road Damage', 'Delhi - Kashmere Gate', $4,
                         'Large pothole on main road causing vehicle damage', 'URGENT', 'RESOLVED', $2, $3)
                 RETURNING *`,
                [citizen.id, filedAt, resolvedAt, normalizeLocation('Delhi - Kashmere Gate')]
            );
            const complaint = complaintResult.rows[0];

            const filedHash = computeHash({
                prevHash: GENESIS_HASH,
                complaintId: complaint.id,
                eventIndex: 0,
                action: 'Complaint filed',
                actorId: citizen.id,
                timestamp: filedAt,
            });
            await client.query(
                `INSERT INTO complaint_events (complaint_id, event_index, action, actor_id, prev_hash, hash, created_at)
                 VALUES ($1, 0, 'Complaint filed', $2, $3, $4, $5)`,
                [complaint.id, citizen.id, GENESIS_HASH, filedHash, filedAt]
            );

            const resolvedHash = computeHash({
                prevHash: filedHash,
                complaintId: complaint.id,
                eventIndex: 1,
                action: 'Status changed to RESOLVED',
                actorId: officer.id,
                timestamp: resolvedAt,
            });
            await client.query(
                `INSERT INTO complaint_events (complaint_id, event_index, action, actor_id, prev_hash, hash, created_at)
                 VALUES ($1, 1, 'Status changed to RESOLVED', $2, $3, $4, $5)`,
                [complaint.id, officer.id, filedHash, resolvedHash, resolvedAt]
            );

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    console.log('✓ Seed complete.');
    console.log('  Citizen login: citizen@example.com / password123');
    console.log('  Officer login: officer@example.com / password123');
    await pool.end();
}

seed().catch((err) => {
    console.error('✗ Seed failed:', err.message);
    process.exit(1);
});
