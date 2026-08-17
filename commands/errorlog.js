const fs = require('node:fs');
const {
    SlashCommandBuilder,
    MessageFlags,
    PermissionFlagsBits,
    AttachmentBuilder,
} = require('discord.js');
const {
    readRecentLog,
    getLogFilePath,
    logFileExists,
    clearLogs,
    canViewErrorLog,
} = require('../utils/errorLog');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('errorlog')
        .setDescription('View or download GrokSlop error logs for troubleshooting')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) =>
            sub
                .setName('recent')
                .setDescription('Show the most recent log lines in Discord')
                .addIntegerOption((o) =>
                    o
                        .setName('lines')
                        .setDescription('How many lines to show (default 40, max 120)')
                        .setMinValue(10)
                        .setMaxValue(120)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('dump')
                .setDescription('Download the full error log file')
        )
        .addSubcommand((sub) =>
            sub
                .setName('clear')
                .setDescription('Clear saved error logs')
        ),
    async execute(interaction) {
        const member = interaction.member;
        const userId = interaction.user.id;

        if (!canViewErrorLog(member, userId)) {
            await interaction.reply({
                content:
                    'You need **Manage Server** (or be listed in `ERRORLOG_USER_IDS`) to use error logs.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const sub = interaction.options.getSubcommand();

        if (sub === 'recent') {
            const lines = interaction.options.getInteger('lines') ?? 40;
            const text = readRecentLog({ maxLines: lines, maxChars: 3800 });

            await interaction.reply({
                content:
                    `**Recent GrokSlop errors** (last ${lines} lines)\n` +
                    `Log file: \`data/logs/error.log\`\n\n` +
                    `\`\`\`\n${text.replace(/```/g, '`\u200b``')}\n\`\`\``,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (sub === 'dump') {
            if (!logFileExists()) {
                await interaction.reply({
                    content: 'No error log file yet — nothing has been recorded.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const logPath = getLogFilePath();
            const attachment = new AttachmentBuilder(logPath, {
                name: `grokslop-error-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
            });

            await interaction.reply({
                content:
                    '**Error log dump** — attach this file when troubleshooting.\n' +
                    'Includes errors, warnings, uncaught exceptions, and command failures.',
                files: [attachment],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (sub === 'clear') {
            clearLogs();
            await interaction.reply({
                content: 'Error log cleared. New errors will be recorded from here.',
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};
