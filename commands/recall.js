const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getGuildMemory, getUserMemory } = require('../ai/memory');

const LIST_CAP = 10;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('recall')
        .setDescription('Show recent notes from Grokslop memory')
        .addStringOption((o) =>
            o
                .setName('scope')
                .setDescription('Whose memory to read')
                .setRequired(true)
                .addChoices(
                    { name: 'Whole server (guild)', value: 'guild' },
                    { name: 'Just me', value: 'me' }
                )
        )
        .addStringOption((o) =>
            o.setName('key').setDescription('Filter by exact key (optional)').setRequired(false)
        ),
    async execute(interaction) {
        const scope = interaction.options.getString('scope', true);
        const keyFilter = interaction.options.getString('key')?.trim() || null;

        const guildId = interaction.guild.id;
        const rows =
            scope === 'guild'
                ? getGuildMemory(guildId, LIST_CAP * 2)
                : getUserMemory(guildId, interaction.user.id, LIST_CAP * 2);

        const filtered = keyFilter
            ? rows.filter((r) => r.key === keyFilter)
            : rows;

        const lines = filtered.slice(0, LIST_CAP).map((r) => {
            const v =
                r.value.length > 200 ? `${r.value.slice(0, 197)}...` : r.value;
            return `**${r.key}:** ${v}`;
        });

        const header =
            scope === 'guild' ? '**Server memory**' : '**Your memory**';
        const body =
            lines.length > 0
                ? lines.join('\n')
                : keyFilter
                  ? `No entry for key **${keyFilter}**.`
                  : '_Nothing stored yet._';

        await interaction.reply({
            content: `${header}\n${body}`,
            flags: MessageFlags.Ephemeral,
        });
    },
};
