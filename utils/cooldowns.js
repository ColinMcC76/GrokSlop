const config = require('../config');

const cooldowns = new Map();

function isCoolingDown(key) {
    const now = Date.now();
    const expires = cooldowns.get(key);

    if (!expires) return false;
    if (now > expires) {
        cooldowns.delete(key);
        return false;
    }

    return true;
}

function startCooldown(key, ms = config.cooldownMs) {
    cooldowns.set(key, Date.now() + ms);
}

module.exports = {
    isCoolingDown,
    startCooldown
};