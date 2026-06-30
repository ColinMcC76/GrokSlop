const { Events } = require('discord.js');
const { leaveChannel, getConnectionData } = require('../services/voiceManager');
const { stopRealtimeForGuild } = require('../services/realtimeVoiceBridge');
const { tryPlayIntroOnJoin } = require('../services/introSong');

/**
 * When the bot is removed from voice (e.g. server "Disconnect" on the bot),
 * clear local state so we do not think we are still connected or rejoin.
 */
module.exports = {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState) {
        const clientId = newState.client.user?.id;
        if (!clientId) {
            return;
        }

        if (newState.id === clientId) {
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
            return;
        }

        if (newState.member?.user.bot) {
            return;
        }

        const joinedChannel =
            Boolean(newState.channelId) &&
            oldState.channelId !== newState.channelId;
        if (!joinedChannel || !newState.channelId) {
            return;
        }

        const guildId = newState.guild.id;
        const connectionData = getConnectionData(guildId);
        if (!connectionData) {
            return;
        }

        if (
            connectionData.connection.joinConfig.channelId !==
            newState.channelId
        ) {
            return;
        }

        try {
            await tryPlayIntroOnJoin(
                guildId,
                newState.member,
                connectionData.player
            );
        } catch (e) {
            console.error('[voiceStateUpdate] intro on join:', e);
        }
    },
};
