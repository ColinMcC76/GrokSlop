const { Events } = require('discord.js');
const { leaveChannel } = require('../services/voiceManager');
const { stopRealtimeForGuild } = require('../services/realtimeVoiceBridge');

/**
 * When the bot is removed from voice (e.g. server "Disconnect" on the bot),
 * clear local state so we do not think we are still connected or rejoin.
 */
module.exports = {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState) {
        const clientId = newState.client.user?.id;
        if (!clientId || newState.id !== clientId) {
            return;
        }
        if (!oldState.channelId || newState.channelId) {
            return;
        }

        const guildId = newState.guild.id;
        try {
            await stopRealtimeForGuild(guildId);
        } catch (e) {
            console.error('[voiceStateUpdate] stopRealtimeForGuild:', e);
        }
        leaveChannel(guildId);
    },
};
