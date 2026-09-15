const crypto = require('crypto');

// The first event in every complaint's chain points back to this fixed value.
const GENESIS_HASH = '0'.repeat(64);

/**
 * Computes a SHA-256 hash for one ledger event. Because the hash covers the
 * previous event's hash as well as this event's own fields, changing any
 * field on any past event changes that event's hash and therefore every
 * hash that comes after it -- that broken chain is what verifyChain()
 * detects.
 */
function computeHash({ prevHash, complaintId, eventIndex, action, actorId, timestamp }) {
    const payload = [prevHash, complaintId, eventIndex, action, actorId ?? 'system', timestamp].join('|');
    return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Recomputes every hash in an ordered list of events and checks it against
 * what's stored. Returns true only if the whole chain is internally
 * consistent from genesis onward.
 */
function verifyChain(events) {
    let expectedPrevHash = GENESIS_HASH;
    for (const ev of events) {
        if (ev.prev_hash !== expectedPrevHash) return false;
        const expectedHash = computeHash({
            prevHash: expectedPrevHash,
            complaintId: ev.complaint_id,
            eventIndex: ev.event_index,
            action: ev.action,
            actorId: ev.actor_id,
            timestamp: new Date(ev.created_at).toISOString(),
        });
        if (expectedHash !== ev.hash) return false;
        expectedPrevHash = ev.hash;
    }
    return true;
}

/**
 * Normalizes a location string so "MG Road, Pune" and "mg road,  pune " are
 * recognized as the same address for duplicate-complaint detection.
 */
function normalizeLocation(location) {
    return location.trim().toLowerCase().replace(/\s+/g, ' ');
}

module.exports = { GENESIS_HASH, computeHash, verifyChain, normalizeLocation };
