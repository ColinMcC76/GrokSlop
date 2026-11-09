const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
    canRunEquipmentCheck,
    generateBody,
    connectedVoiceChannel,
    postSoundOffTranscript,
} = require('../services/equipmentCheck');
const { soundOffPayloads } = require('../utils/soundOffTranscript');
const { getConnectionData, playAudio } = require('../services/voiceManager');
const { generateSpeech } = require('../services/tts');
const { equipmentCheckTtsInstructions } = require('../ai/persona');
const { isRealtimeActive } = require('../services/realtimeVoiceBridge');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('equipmentchecksoundoff')
        .setDescription(
            'Speak an equipment check in voice and post the transcript in that voice channel'
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
            allowedMentions: { parse: [] },
        });

        let transcriptPosted = false;
        try {
            const voiceChannel = await connectedVoiceChannel(interaction.guild);
            if (!voiceChannel?.isVoiceBased?.() || typeof voiceChannel.send !== 'function') {
                await interaction.editReply({
                    content: 'I need to be in a voice channel with text chat before sounding off.',
                    allowedMentions: { parse: [] },
                });
                return;
            }

            const body = await generateBody(interaction.guild.id, prompt);
            const payloads = soundOffPayloads(body);

            const audioPath = await generateSpeech(body, {
                instructions: equipmentCheckTtsInstructions,
            });

            if (interaction.channelId === voiceChannel.id) {
                await interaction.editReply(payloads[0]);
                for (const payload of payloads.slice(1)) {
                    await voiceChannel.send(payload);
                }
            } else {
                await postSoundOffTranscript(voiceChannel, body);
                await interaction.editReply({
                    content: `Sounded off in **${voiceChannel.name}**. The transcript is in that voice channel.`,
                    allowedMentions: { parse: [] },
                });
            }
            transcriptPosted = true;

            await playAudio(interaction.guild.id, audioPath);
        } catch (err) {
            const msg = err?.message || String(err);
            const content = transcriptPosted
                ? `The transcript was posted, but voice playback failed: ${msg}`
                : `Could not run equipment check sound-off: ${msg}`;
            try {
                if (transcriptPosted) {
                    await interaction.followUp({
                        content,
                        allowedMentions: { parse: [] },
                        flags: MessageFlags.Ephemeral,
                    });
                } else {
                    await interaction.editReply({
                        content,
                        allowedMentions: { parse: [] },
                    });
                }
            } catch {
                await interaction.followUp({
                    content: msg,
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
    },
};
