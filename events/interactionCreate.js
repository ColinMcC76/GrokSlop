const { Events, MessageFlags } = require('discord.js');

const { logError } = require('../utils/errorLog');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (!interaction.isChatInputCommand()) return;

        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.execute(interaction);
        } catch (error) {
            logError('command', error, {
                command: interaction.commandName,
                guildId: interaction.guildId,
                userId: interaction.user?.id,
                channelId: interaction.channelId,
            });

            const payload = {
                content: 'There was an error while executing this command.',
                flags: MessageFlags.Ephemeral
            };

            try {
                if (interaction.deferred) {
                    await interaction.editReply(payload);
                } else if (interaction.replied) {
                    await interaction.followUp(payload);
                } else {
                    await interaction.reply(payload);
                }
            } catch (replyErr) {
                console.error('[interactionCreate] failed to send error response:', replyErr.message || replyErr);
            }
        }
    }
};
