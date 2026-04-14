const {
    joinVoiceChannel,
    createAudioPlayer,
    NoSubscriberBehavior,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    getVoiceConnection,
} = require('@discordjs/voice');
const fs = require('node:fs');
const { removeGuild: removeYoutubeQueue } = require('./youtubeQueue');

const connections = new Map();

/** Voice handshake can exceed Discord's 3s interaction window; allow generous timeout. */
const VOICE_READY_MS = 45_000;

async function joinChannel(voiceChannel) {
    const guildId = voiceChannel.guild.id;

    const existing = connections.get(guildId);
    if (existing) {
        const { connection, player } = existing;
        if (connection.joinConfig.channelId !== voiceChannel.id) {
            connection.rejoin({
                channelId: voiceChannel.id,
                selfDeaf: false,
                selfMute: false,
            });
        }
        await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_MS);
        return { connection, player };
    }

    let connection = getVoiceConnection(guildId);
    if (connection) {
        if (connection.joinConfig.channelId !== voiceChannel.id) {
            connection.rejoin({
                channelId: voiceChannel.id,
                selfDeaf: false,
                selfMute: false,
            });
        }
        const player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
            },
        });
        connection.subscribe(player);
        await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_MS);
        connections.set(guildId, { connection, player });
        return { connection, player };
    }

    connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
    });

    const player = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Pause,
        },
    });

    connection.subscribe(player);

    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_MS);

    connections.set(guildId, { connection, player });
    return { connection, player };
}

function leaveChannel(guildId) {
    const data = connections.get(guildId);
    if (!data) return false;

    removeYoutubeQueue(guildId);
    try {
        data.connection.destroy();
    } catch {
        /* may already be torn down (e.g. server-side disconnect) */
    }
    connections.delete(guildId);
    return true;
}

function getConnectionData(guildId) {
    return connections.get(guildId);
}

async function playAudio(guildId, filePath) {
    const data = connections.get(guildId);
    if (!data) {
        throw new Error('Bot is not connected to a voice channel.');
    }

    if (!fs.existsSync(filePath)) {
        throw new Error(`Audio file not found: ${filePath}`);
    }

    const resource = createAudioResource(filePath, {
        metadata: { title: filePath }
    });

    data.player.play(resource);

    await entersState(data.player, AudioPlayerStatus.Playing, 10_000);
    await entersState(data.player, AudioPlayerStatus.Idle, 60_000);
}

module.exports = {
    joinChannel,
    leaveChannel,
    getConnectionData,
    playAudio,
};