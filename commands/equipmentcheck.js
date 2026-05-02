const {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
} = require('discord.js');
const { runEquipmentCheck } = require('../services/equipmentCheck');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('equipmentcheck')
        .setDescription(
            'Post an equipment check — ping EMA roles, collect ✅ reactions, grant equipped'
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption((option) =>
            option
                .setName('prompt')
                .setDescription(
                    'Optional angle (e.g. pre-lunch check, mandatory lock-in, 4:20 timing)'
                )
                .setRequired(false)
                .setMaxLength(500)
        ),
    async execute(interaction) {
        const prompt = interaction.options.getString('prompt');

        await interaction.deferReply({
            allowedMentions: { parse: ['roles'] },
        });

        try {
            await runEquipmentCheck(interaction, prompt);
        } catch (err) {
            const msg = err?.message || String(err);
            try {
                await interaction.editReply({
                    content: `Could not start equipment check: ${msg}`,
                });
            } catch {
                await interaction.followUp({
                    content: msg,
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
    },
};
