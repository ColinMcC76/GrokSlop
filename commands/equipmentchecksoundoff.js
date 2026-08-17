const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
    runEquipmentCheck,
    canRunEquipmentCheck,
    generateBody,
} = require('../services/equipmentCheck');
const { getConnectionData, playAudio } = require('../services/voiceManager');
const { generateSpeech } = require('../services/tts');
const { equipmentCheckTtsInstructions } = require('../ai/persona');
const { isRealtimeActive } = require('../services/realtimeVoiceBridge');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('equipmentchecksoundoff')
        .setDescription(
            'Equipment check in voice (TTS) plus channel post — ping EMA roles, ✅ reactions, equipped role'
        )
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
        const member = interaction.member;
        if (!canRunEquipmentCheck(member)) {
            await interaction.reply({
                content:
                    'You need **Equipment Maintenance Authority Executive**, **Chief**, or **Deputy** to run this command.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (isRealtimeActive(interaction.guild.id)) {
            await interaction.reply({
                content:
                    'Realtime voice is active. Use `/talkoff` before an equipment check sound-off.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (!getConnectionData(interaction.guild.id)) {
            await interaction.reply({
                content:
                    'I need to be in a voice channel first. Use `/joinvc`, then run `/equipmentchecksoundoff` again.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const prompt = interaction.options.getString('prompt');

        await interaction.deferReply({
            allowedMentions: { parse: ['roles'] },
        });

        try {
            const body = await generateBody(interaction.guild.id, prompt);

            const audioPath = await generateSpeech(body, {
                instructions: equipmentCheckTtsInstructions,
            });
            await playAudio(interaction.guild.id, audioPath);

            await runEquipmentCheck(interaction, prompt, { body });
        } catch (err) {
            const msg = err?.message || String(err);
            try {
                await interaction.editReply({
                    content: `Could not run equipment check sound-off: ${msg}`,
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
