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
const {
    attachIfLinkedInVoice,
    stopDiscordOutput,
} = require('./spotifyConnect');

const connections = new Map();

/** @type {WeakSet<import('@discordjs/voice').VoiceConnection>} */
const wiredConnections = new WeakSet();

/** @type {WeakSet<import('@discordjs/voice').AudioPlayer>} */
const wiredPlayers = new WeakSet();

/** Voice handshake can exceed Discord's 3s interaction window; allow generous timeout. */
const VOICE_READY_MS = 45_000;

/**
 * @param {string} guildId
 * @param {import('@discordjs/voice').VoiceConnection} connection
 * @param {import('@discordjs/voice').AudioPlayer} player
 */
function wireVoiceSession(guildId, connection, player) {
    if (!wiredConnections.has(connection)) {
        wiredConnections.add(connection);

        connection.on('error', (error) => {
            console.error(
                `[voice:${guildId}] VoiceConnection error:`,
                error?.message || error
            );
        });

        connection.on('stateChange', async (_oldState, newState) => {
            if (newState.status === VoiceConnectionStatus.Destroyed) {
                const data = connections.get(guildId);
                if (data?.connection === connection) {
                    connections.delete(guildId);
                    removeYoutubeQueue(guildId);
                    stopDiscordOutput(guildId).catch(() => {});
                }
                return;
            }

            if (newState.status !== VoiceConnectionStatus.Disconnected) {
                return;
            }

            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
            } catch {
                const data = connections.get(guildId);
                if (data?.connection === connection) {
                    console.warn(
                        `[voice:${guildId}] voice disconnected; cleaning up session`
                    );
                    leaveChannel(guildId);
                }
            }
        });
    }

    if (player && !wiredPlayers.has(player)) {
        wiredPlayers.add(player);
        player.on('error', (err) => {
            const code = err?.error?.code ?? err?.code;
            if (
                code === 'ERR_STREAM_PREMATURE_CLOSE' ||
                code === 'EPIPE' ||
                code === 'ECONNRESET'
            ) {
                return;
            }
            console.error(
                `[voice:${guildId}] AudioPlayer error:`,
                err?.message || err
            );
        });
    }
}

async function joinChannel(voiceChannel) {
    const guildId = voiceChannel.guild.id;

    const existing = connections.get(guildId);
    if (existing) {
        const { connection, player } = existing;
        wireVoiceSession(guildId, connection, player);
        if (connection.joinConfig.channelId !== voiceChannel.id) {
            connection.rejoin({
                channelId: voiceChannel.id,
                selfDeaf: false,
                selfMute: false,
            });
        }
        await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_MS);
        await attachIfLinkedInVoice(guildId, player);
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
        wireVoiceSession(guildId, connection, player);
        await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_MS);
        connections.set(guildId, { connection, player });
        await attachIfLinkedInVoice(guildId, player);
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
    wireVoiceSession(guildId, connection, player);

    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_MS);

    connections.set(guildId, { connection, player });
    await attachIfLinkedInVoice(guildId, player);
    return { connection, player };
}

function leaveChannel(guildId) {
    const data = connections.get(guildId);
    if (!data) return false;

    removeYoutubeQueue(guildId);
    stopDiscordOutput(guildId);
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