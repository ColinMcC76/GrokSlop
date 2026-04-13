const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('grok')
        .setDescription('Check whether Grokslop is alive'),
    async execute(interaction) {
        await interaction.reply('Grokslop is awake and causing manageable problems.');
    }
};