const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getConnectionData } = require('../services/voiceManager');
const { isRealtimeActive } = require('../services/realtimeVoiceBridge');
const { isActive: isSpotifySpeakerActive } = require('../services/spotifyConnect');
const {
    listSoundbites,
    playSoundbite,
    stopSoundbite,
    getSoundbitePlayback,
} = require('../services/soundboard');
const { splitDiscordContent } = require('../utils/discordChunks');

const ephemeral = { flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };

function safeName(name) {
    return String(name || '')
        .replace(/\\/g, '\\\\')
        .replace(/([*_`~|>])/g, '\\$1')
        .replace(/@/g, '@\u200b');
}

function matchSoundbites(raw) {
    const query = String(raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const bites = listSoundbites();
    if (!query) {
        return { bite: null, matches: [] };
    }
    const exact = bites.find((bite) => bite.name.toLowerCase() === query);
    if (exact) {
        return { bite: exact, matches: [exact] };
    }
    const matches = bites.filter((bite) => bite.name.toLowerCase().includes(query));
    return { bite: null, matches };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('soundboard')
        .setDescription('Play soundbites added on the soundboard')
        .addSubcommand((sub) =>
            sub
                .setName('play')
                .setDescription('Play a soundbite in voice')
                .addStringOption((option) =>
                    option
                        .setName('sound')
                        .setDescription('Soundbite to play')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('list')
                .setDescription('List the soundbites on the soundboard')
        )
        .addSubcommand((sub) =>
            sub
                .setName('stop')
                .setDescription('Stop the soundbite that is playing')
        ),

    /**
     * @param {import('discord.js').AutocompleteInteraction} interaction
     */
    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'sound') {
            await interaction.respond([]);
            return;
        }

        const q = String(focused.value || '').toLowerCase();
        const choices = listSoundbites()
            .filter((bite) => !q || bite.name.toLowerCase().includes(q))
            .slice(0, 25)
            .map((bite) => ({
                name: bite.name.slice(0, 100),
                value: bite.id,
            }));
        await interaction.respond(choices);
    },

    /**
     * @param {import('discord.js').ChatInputCommandInteraction} interaction
     */
    async execute(interaction) {
        if (!interaction.guild) {
            await interaction.reply({
                content: 'Use this in a server.',
                ...ephemeral,
            });
            return;
        }

        const sub = interaction.options.getSubcommand();
        if (sub === 'list') {
            await listSounds(interaction);
            return;
        }
        if (sub === 'stop') {
            await stopSound(interaction);
            return;
        }
        await playSound(interaction);
    },
};

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function listSounds(interaction) {
    const bites = listSoundbites();
    if (bites.length === 0) {
        await interaction.reply({
            content:
                'No soundbites yet. Add them on the soundboard page, then play them with `/soundboard play`.',
            ...ephemeral,
        });
        return;
    }

    const playing = getSoundbitePlayback();
    const header = playing
        ? `**${bites.length}** soundbite${bites.length === 1 ? '' : 's'}. Now playing **${safeName(playing.name)}**.`
        : `**${bites.length}** soundbite${bites.length === 1 ? '' : 's'}. Play one with \`/soundboard play\`.`;
    const lines = bites.map((bite) => {
        const mark = playing?.id === bite.id ? ' *(playing)*' : '';
        return `• **${safeName(bite.name)}**${mark}`;
    });
    const chunks = splitDiscordContent([header, ...lines].join('\n'));
    await interaction.reply({ content: chunks[0], ...ephemeral });
    for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ content: chunk, ...ephemeral });
    }
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function stopSound(interaction) {
    try {
        const message = stopSoundbite();
        await interaction.reply({
            content: message,
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        await interaction.reply({
            content: err?.message || 'Could not stop playback.',
            ...ephemeral,
        });
    }
}

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function playSound(interaction) {
    if (isRealtimeActive(interaction.guild.id)) {
        await interaction.reply({
            content: 'Turn off realtime voice (/talkoff) before playing a soundbite.',
            ...ephemeral,
        });
        return;
    }
    if (isSpotifySpeakerActive(interaction.guild.id)) {
        await interaction.reply({
            content:
                'Spotify Connect is using the voice speaker. Unlink it or stop it first.',
            ...ephemeral,
        });
        return;
    }

    const selected = interaction.options.getString('sound', true);
    const looksLikeId =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            selected
        );
    const byId = looksLikeId
        ? listSoundbites().find((bite) => bite.id === selected)
        : null;
    if (looksLikeId && !byId) {
        await interaction.reply({
            content:
                'That soundbite is gone. Use `/soundboard list` to see the ones that are left.',
            ...ephemeral,
        });
        return;
    }
    const resolved = byId
        ? { bite: byId, matches: [byId] }
        : matchSoundbites(selected);
    if (!resolved.bite) {
        const preview = resolved.matches
            .slice(0, 8)
            .map((bite) => `**${safeName(bite.name)}**`)
            .join(', ');
        const extra =
            resolved.matches.length > 8
                ? ` (+${resolved.matches.length - 8} more)`
                : '';
        await interaction.reply({
            content: preview
                ? `No soundbite named “${safeName(selected)}”. Close matches: ${preview}${extra}.`
                : `No soundbite named “${safeName(selected)}”. Use \`/soundboard list\` to see them.`,
            ...ephemeral,
        });
        return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;
    if (!getConnectionData(interaction.guild.id) && !voiceChannel) {
        await interaction.reply({
            content:
                'Join a voice channel first (or use /joinvc), then run /soundboard play.',
            ...ephemeral,
        });
        return;
    }

    const existing = getConnectionData(interaction.guild.id);
    await interaction.deferReply();
    try {
        if (!existing && voiceChannel) {
            const stillInChannel =
                interaction.guild.voiceStates.cache.get(interaction.user.id)
                    ?.channelId === voiceChannel.id;
            if (!stillInChannel) {
                await interaction.editReply({
                    content: 'You left the voice channel before I could join.',
                    allowedMentions: { parse: [] },
                });
                return;
            }
        }

        const message = await playSoundbite(interaction.client, {
            guildId: interaction.guild.id,
            voiceChannelId: voiceChannel?.id,
            id: resolved.bite.id,
        });
        const botChannelId = existing?.connection?.joinConfig?.channelId;
        const elsewhere =
            existing &&
            voiceChannel &&
            botChannelId &&
            botChannelId !== voiceChannel.id;
        const where = elsewhere
            ? ` It played in **${safeName(
                  interaction.guild.channels.cache.get(botChannelId)?.name ||
                      'my current voice channel'
              )}**.`
            : '';
        await interaction.editReply({
            content: `${message}${where}`,
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        console.error('[soundboard] play failed:', err);
        const text = err?.message || 'Could not play that soundbite.';
        await interaction.editReply({
            content: text,
            allowedMentions: { parse: [] },
        });
    }
}
