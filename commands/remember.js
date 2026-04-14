const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { upsertGuildMemory, upsertUserMemory } = require('../ai/memory');

const MAX_KEY = 80;
const MAX_VALUE = 900;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('remember')
        .setDescription('Store a note in Grokslop memory for this server')
        .addStringOption((o) =>
            o
                .setName('scope')
                .setDescription('Who this note is for')
                .setRequired(true)
                .addChoices(
                    { name: 'Whole server (guild)', value: 'guild' },
                    { name: 'Just me', value: 'me' }
                )
        )
        .addStringOption((o) =>
            o.setName('key').setDescription('Short label (e.g. pizza topping)').setRequired(true)
        )
        .addStringOption((o) =>
            o.setName('value').setDescription('What to remember').setRequired(true)
        ),
    async execute(interaction) {
        const scope = interaction.options.getString('scope', true);
        let key = interaction.options.getString('key', true).trim();
        let value = interaction.options.getString('value', true).trim();

        if (!key || !value) {
            await interaction.reply({
                content: 'Key and value cannot be empty.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (key.length > MAX_KEY) {
            key = key.slice(0, MAX_KEY);
        }
        if (value.length > MAX_VALUE) {
            value = value.slice(0, MAX_VALUE);
        }

        const guildId = interaction.guild.id;

        if (scope === 'guild') {
            upsertGuildMemory(guildId, key, value);
            await interaction.reply({
                content: `Saved for **this server**: **${key}**`,
                flags: MessageFlags.Ephemeral,
            });
        } else {
            upsertUserMemory(guildId, interaction.user.id, key, value);
            await interaction.reply({
                content: `Saved for **you**: **${key}**`,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
