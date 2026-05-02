const { generateResponse } = require('../ai/router');
const persona = require('../ai/persona');
const { getActivePromptText } = require('../ai/guildPersonas');

/** Role names pinged on each equipment check (exact match). Override: EQUIPMENT_CHECK_PING_ROLES=comma-separated */
const DEFAULT_PING_ROLE_NAMES = [
    'Equipment Maintenance Authority Engineers',
    'Equipment Maintenance Authority Executive',
    'Equipment Maintenance Authority Chief',
    'Equipment Maintenance Authority Deputy',
];

/** Role granted to reactors after the window. Override: EQUIPMENT_CHECK_EQUIPPED_ROLE=name */
const DEFAULT_EQUIPPED_ROLE_NAME = 'equipped';

const CHECK_DURATION_MS = 5 * 60 * 1000;
const COUNTDOWN_EDIT_MS = 10_000;
const REACTION_EMOJI = '✅';

/**
 * @typedef {{
 *   announcementPrefix: string,
 *   message: import('discord.js').Message,
 *   guild: import('discord.js').Guild,
 *   equippedRole: import('discord.js').Role,
 *   pingRoles: import('discord.js').Role[],
 *   closeUnix: number,
 *   endTimeMs: number,
 *   timeout: NodeJS.Timeout,
 *   interval: NodeJS.Timeout,
 * }} EquipmentSession
 */

/** @type {Map<string, EquipmentSession>} */
const activeByGuild = new Map();

function parsePingRoleNames() {
    const raw = process.env.EQUIPMENT_CHECK_PING_ROLES;
    if (raw && raw.trim()) {
        return raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return DEFAULT_PING_ROLE_NAMES;
}

function equippedRoleName() {
    return (
        process.env.EQUIPMENT_CHECK_EQUIPPED_ROLE?.trim() ||
        DEFAULT_EQUIPPED_ROLE_NAME
    );
}

/**
 * @param {import('discord.js').Guild} guild
 */
function resolvePingRoles(guild) {
    const names = parsePingRoleNames();
    const roles = [];
    const missing = [];
    for (const name of names) {
        const r = guild.roles.cache.find((x) => x.name === name);
        if (r) {
            roles.push(r);
        } else {
            missing.push(name);
        }
    }
    return { roles, missing };
}

/**
 * @param {import('discord.js').Guild} guild
 */
function resolveEquippedRole(guild) {
    const want = equippedRoleName();
    const r = guild.roles.cache.find(
        (x) => x.name.toLowerCase() === want.toLowerCase()
    );
    return r;
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').Role} equippedRole
 */
async function stripEquippedFromAll(guild, equippedRole) {
    const members = equippedRole.members;
    const list = [...members.values()];
    for (const m of list) {
        try {
            await m.roles.remove(
                equippedRole,
                'New equipment check — clear prior equipped'
            );
        } catch (e) {
            console.warn(
                '[equipmentcheck] could not remove equipped from',
                m.id,
                e?.message || e
            );
        }
    }
}

function buildInstructions() {
    return `${persona.textChat}

You are drafting a single Discord message for an **equipment check** announcement.

In-universe meaning: "equipment check" is light, in-group humor about winding down together (think: personal prep before chilling) — **not** industrial safety, OSHA, machinery logs, or corporate compliance. Never frame it as inspecting real workplace gear unless the user's optional angle is clearly absurdist and still obviously a joke among friends.

Output rules:
- Output **only** the body of the announcement (no subject line, no markdown code fences).
- Do **not** include @everyone, @here, or role mentions — the bot adds pings separately.
- Be engaging and in character with the persona above.
- If the user gave a specific angle, lean into it while keeping the tone appropriate for friends on Discord.`;
}

function buildUserInput(optionalPrompt) {
    if (optionalPrompt && optionalPrompt.trim()) {
        return `Write the equipment check announcement. Follow this angle or emphasis from the requester:\n\n${optionalPrompt.trim()}`;
    }
    return `Write a clear, friendly equipment check call-to-action: urge people to take a moment and confirm they've "checked their equipment" before things get going. Keep it to a few short paragraphs — upbeat, not corporate.`;
}

/**
 * @param {string} guildId
 * @param {string | null} optionalPrompt
 * @returns {Promise<string>}
 */
async function generateBody(guildId, optionalPrompt) {
    const custom = getActivePromptText(guildId);
    const instructions = persona.withCustomPersona(
        buildInstructions(),
        custom
    );
    const input = buildUserInput(optionalPrompt);
    const result = await generateResponse({
        instructions,
        input,
        attachments: [],
        useWebSearch: false,
    });
    const text =
        typeof result === 'string'
            ? result
            : (result && result.text) || 'Equipment check — sound off when ready.';
    return text.trim();
}

/**
 * @param {number} secondsLeft
 * @param {number} closeUnix
 */
function formatRunningFooter(secondsLeft, closeUnix) {
    const sec = Math.max(0, secondsLeft);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const mmss = `${m}:${String(s).padStart(2, '0')}`;
    return [
        `React with ${REACTION_EMOJI} to log your equipment check.`,
        `**Time left:** ${mmss}`,
        `**Closes:** <t:${closeUnix}:R> · <t:${closeUnix}:T>`,
    ].join('\n');
}

/**
 * @param {string} guildId
 */
async function finalizeCheck(guildId) {
    const rec = activeByGuild.get(guildId);
    if (!rec) {
        return;
    }

    clearInterval(rec.interval);
    clearTimeout(rec.timeout);
    activeByGuild.delete(guildId);

    const { guild, message, equippedRole, closeUnix, announcementPrefix, pingRoles } =
        rec;

    let reactorIds = new Set();
    try {
        const full = await message.channel.messages.fetch(message.id);
        const reaction = full.reactions.cache.get(REACTION_EMOJI);
        if (reaction) {
            const users = await reaction.users.fetch();
            for (const [id, u] of users) {
                if (u.bot) {
                    continue;
                }
                reactorIds.add(id);
            }
        }
    } catch (e) {
        console.error('[equipmentcheck] could not read reactions:', e);
    }

    const granted = [];
    const failed = [];
    for (const userId of reactorIds) {
        try {
            const member = await guild.members.fetch(userId);
            await member.roles.add(
                equippedRole,
                'Logged equipment check reaction'
            );
            granted.push(userId);
        } catch (e) {
            failed.push(userId);
            console.warn(
                '[equipmentcheck] could not grant equipped:',
                userId,
                e?.message || e
            );
        }
    }

    const closedFooter = [
        '—',
        `**Equipment check closed** (<t:${closeUnix}:F>).`,
        `${REACTION_EMOJI} Logged: **${granted.length}**`,
        failed.length
            ? `_Could not assign role to ${failed.length} member(s) (permissions / hierarchy)._`
            : '',
    ]
        .filter(Boolean)
        .join('\n');

    try {
        await message.edit({
            content: `${announcementPrefix}\n\n${closedFooter}`,
            allowedMentions: { roles: pingRoles.map((r) => r.id) },
        });
    } catch (e) {
        console.warn('[equipmentcheck] could not edit message on close:', e);
    }
}

/**
 * @param {EquipmentSession} rec
 */
function scheduleCountdownEdits(rec) {
    const tick = () => {
        if (!activeByGuild.has(rec.guild.id)) {
            return;
        }
        const leftSec = Math.max(
            0,
            Math.ceil((rec.endTimeMs - Date.now()) / 1000)
        );
        const footer = formatRunningFooter(leftSec, rec.closeUnix);
        rec.message
            .edit({
                content: `${rec.announcementPrefix}\n—\n${footer}`,
                allowedMentions: { roles: rec.pingRoles.map((r) => r.id) },
            })
            .catch((e) => {
                if (e?.code !== 50013) {
                    console.warn('[equipmentcheck] countdown edit failed:', e?.message || e);
                }
            });
    };

    rec.interval = setInterval(tick, COUNTDOWN_EDIT_MS);
    tick();
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string | null} optionalPrompt
 */
async function runEquipmentCheck(interaction, optionalPrompt) {
    const guild = interaction.guild;
    if (!guild) {
        throw new Error('This command only works in a server.');
    }

    if (activeByGuild.has(guild.id)) {
        throw new Error(
            'An equipment check is already running in this server. Wait for it to finish.'
        );
    }

    const { roles: pingRoles, missing } = resolvePingRoles(guild);
    if (missing.length) {
        throw new Error(
            `Missing role(s): ${missing.join(
                ', '
            )}. Create them or set EQUIPMENT_CHECK_PING_ROLES.`
        );
    }

    const equippedRole = resolveEquippedRole(guild);
    if (!equippedRole) {
        throw new Error(
            `Could not find role **${equippedRoleName()}**. Create it or set EQUIPMENT_CHECK_EQUIPPED_ROLE.`
        );
    }

    const me = guild.members.me;
    if (me && equippedRole.position >= me.roles.highest.position) {
        throw new Error(
            'Bot role is not above the **equipped** role — move the bot role higher in Server Settings → Roles.'
        );
    }

    await stripEquippedFromAll(guild, equippedRole);

    const body = await generateBody(guild.id, optionalPrompt);
    const mentionLine = pingRoles.map((r) => `<@&${r.id}>`).join(' ');

    const closeUnix = Math.floor((Date.now() + CHECK_DURATION_MS) / 1000);
    const endTimeMs = Date.now() + CHECK_DURATION_MS;
    const announcementPrefix = `${mentionLine}\n\n${body}`;
    const initialFooter = formatRunningFooter(
        Math.ceil(CHECK_DURATION_MS / 1000),
        closeUnix
    );
    const content = `${announcementPrefix}\n—\n${initialFooter}`;

    if (content.length > 2000) {
        throw new Error(
            'Generated message is too long for Discord (2000 chars). Try a shorter /equipmentcheck prompt.'
        );
    }

    const message = await interaction.editReply({
        content,
        allowedMentions: { roles: pingRoles.map((r) => r.id) },
    });

    const rec = {
        announcementPrefix,
        message,
        guild,
        equippedRole,
        pingRoles,
        closeUnix,
        endTimeMs,
        timeout: null,
        interval: null,
    };

    activeByGuild.set(guild.id, rec);

    try {
        await message.react(REACTION_EMOJI);
    } catch (e) {
        console.error('[equipmentcheck] could not add reaction:', e);
    }

    scheduleCountdownEdits(rec);

    rec.timeout = setTimeout(() => {
        finalizeCheck(guild.id).catch((err) =>
            console.error('[equipmentcheck] finalize failed:', err)
        );
    }, CHECK_DURATION_MS);
}

module.exports = {
    runEquipmentCheck,
    REACTION_EMOJI,
    CHECK_DURATION_MS,
};
