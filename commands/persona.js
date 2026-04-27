const {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
} = require('discord.js');
const {
    addPersona,
    removePersona,
    listPersonas,
    setActivePersona,
    getActivePersonaName,
    getActivePromptText,
    MAX_PROMPT_LEN,
} = require('../ai/guildPersonas');
const { refreshRealtimePersona, isRealtimeActive } = require('../services/realtimeVoiceBridge');

function tryRefreshRealtime(guildId) {
    if (!isRealtimeActive(guildId)) {
        return;
    }
    try {
        refreshRealtimePersona(guildId);
    } catch (e) {
        console.error('[persona] refresh realtime failed:', e);
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('persona')
        .setDescription(
            'Manage server AI personas (text + realtime voice tone until reset)'
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) =>
            sub
                .setName('add')
                .setDescription('Create or overwrite a named persona prompt')
                .addStringOption((o) =>
                    o
                        .setName('name')
                        .setDescription('Short id (letters, numbers, dashes)')
                        .setRequired(true)
                        .setMaxLength(32)
                )
                .addStringOption((o) =>
                    o
                        .setName('prompt')
                        .setDescription(
                            'Instructions appended to the base persona for this server'
                        )
                        .setRequired(true)
                        .setMaxLength(MAX_PROMPT_LEN)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('remove')
                .setDescription('Delete a saved persona')
                .addStringOption((o) =>
                    o
                        .setName('name')
                        .setDescription('Persona name')
                        .setRequired(true)
                        .setMaxLength(32)
                )
        )
        .addSubcommand((sub) =>
            sub.setName('list').setDescription('List saved personas for this server')
        )
        .addSubcommand((sub) =>
            sub
                .setName('use')
                .setDescription('Activate a persona for text + new/realtime sessions')
                .addStringOption((o) =>
                    o
                        .setName('name')
                        .setDescription('Persona name')
                        .setRequired(true)
                        .setMaxLength(32)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('reset')
                .setDescription('Clear active persona (default Shabbot only)')
        )
        .addSubcommand((sub) =>
            sub.setName('show').setDescription('Show the active persona for this server')
        ),
    async execute(interaction) {
        const guildId = interaction.guild.id;
        const sub = interaction.options.getSubcommand();

        try {
            if (sub === 'add') {
                const nameRaw = interaction.options.getString('name', true);
                const promptRaw = interaction.options.getString('prompt', true);
                const name = addPersona(guildId, nameRaw, promptRaw);
                tryRefreshRealtime(guildId);
                await interaction.reply({
                    content: `Saved persona **${name}**. Use \`/persona use name:${name}\` to apply it.`,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (sub === 'remove') {
                const nameRaw = interaction.options.getString('name', true);
                const removed = removePersona(guildId, nameRaw);
                if (!removed) {
                    await interaction.reply({
                        content: 'No persona with that name found.',
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }
                tryRefreshRealtime(guildId);
                await interaction.reply({
                    content: 'Persona removed.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (sub === 'list') {
                const rows = listPersonas(guildId);
                if (rows.length === 0) {
                    await interaction.reply({
                        content: 'No personas saved yet. Use `/persona add`.',
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }
                const active = getActivePersonaName(guildId);
                const lines = rows.map((r) => {
                    const mark = active === r.name ? ' *(active)*' : '';
                    return `• **${r.name}**${mark} — ${r.preview.replace(/\n/g, ' ')}`;
                });
                await interaction.reply({
                    content: lines.join('\n').slice(0, 1900),
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (sub === 'use') {
                const nameRaw = interaction.options.getString('name', true);
                const name = setActivePersona(guildId, nameRaw);
                tryRefreshRealtime(guildId);
                await interaction.reply({
                    content: `Active persona is now **${name}** (text chat and realtime voice).`,
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (sub === 'reset') {
                setActivePersona(guildId, null);
                tryRefreshRealtime(guildId);
                await interaction.reply({
                    content:
                        'Active persona cleared. Shabbot uses the default instructions only.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            if (sub === 'show') {
                const name = getActivePersonaName(guildId);
                const prompt = getActivePromptText(guildId);
                if (!name || !prompt) {
                    await interaction.reply({
                        content: 'No custom persona is active (default Shabbot only).',
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }
                const body =
                    prompt.length > 1500 ? `${prompt.slice(0, 1497)}...` : prompt;
                await interaction.reply({
                    content: `**Active:** ${name}\n\n${body}`,
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (err) {
            await interaction.reply({
                content: err.message || String(err),
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
