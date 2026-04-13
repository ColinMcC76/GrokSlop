const {
    joinVoiceChannel,
    createAudioPlayer,
    NoSubscriberBehavior,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
} = require('@discordjs/voice');
const fs = require('node:fs');
const { removeGuild: removeYoutubeQueue } = require('./youtubeQueue');

const connections = new Map();

async function joinChannel(voiceChannel) {
    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
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

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    connections.set(voiceChannel.guild.id, { connection, player });
    return { connection, player };
}

function leaveChannel(guildId) {
    const data = connections.get(guildId);
    if (!data) return false;

    removeYoutubeQueue(guildId);
    data.connection.destroy();
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