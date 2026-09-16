const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_ROLES = ['citizen', 'officer'];

function signToken(user) {
    return jwt.sign(
        { id: user.id, role: user.role, name: user.name, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function publicUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department || null,
    };
}

// ---- Register ----
router.post('/register', async (req, res) => {
    try {
        const { name, email, password, role, department } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'name, email and password are required' });
        }
        // Admin accounts aren't self-service -- insert one directly into the
        // users table if you need one for a demo.
        const finalRole = ALLOWED_ROLES.includes(role) ? role : 'citizen';

        const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'An account with that email already exists' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await query(
            `INSERT INTO users (name, email, password_hash, role, department)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [name, email, passwordHash, finalRole, department || null]
        );
        const user = result.rows[0];
        res.status(201).json({ token: signToken(user), user: publicUser(user) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not create account' });
    }
});

// ---- Login ----
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'email and password are required' });
        }
        const result = await query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        res.json({ token: signToken(user), user: publicUser(user) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not log in' });
    }
});

// ---- Current user ----
router.get('/me', requireAuth, async (req, res) => {
    try {
        const result = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user: publicUser(user) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load current user' });
    }
});

module.exports = router;
