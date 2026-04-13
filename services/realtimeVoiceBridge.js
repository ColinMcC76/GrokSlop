const { EndBehaviorType, createAudioResource, StreamType } = require('@discordjs/voice');
const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
const { PassThrough } = require('node:stream');
const { RealtimeSession } = require('./realtimeSession');

function pcm48kStereoTo24kMono(buffer) {
    const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);

    const outputLength = Math.floor(input.length / 4);
    const output = new Int16Array(outputLength);

    let outIndex = 0;
    for (let i = 0; i + 1 < input.length; i += 4) {
        const left = input[i];
        const right = input[i + 1];
        output[outIndex++] = (left + right) >> 1;
    }

    return Buffer.from(output.buffer, 0, outIndex * 2);
}

const sessions = new Map();

function createOutputPipeline(player) {
    const inputPcm24kMono = new PassThrough();

    const upsampler = new prism.FFmpeg({
        args: [
            '-loglevel', '0',
            '-f', 's16le',
            '-ar', '24000',
            '-ac', '1',
            '-i', 'pipe:0',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            'pipe:1',
        ],
        shell: false,
        command: ffmpegPath,
    });

    upsampler.on('error', (err) => {
        console.error('[RT OUTPUT UPSAMPLER ERROR]', err);
    });

    const upsampled = inputPcm24kMono.pipe(upsampler);

    const resource = createAudioResource(upsampled, {
        inputType: StreamType.Raw,
    });

    player.play(resource);

    return inputPcm24kMono;
}

async function startRealtimeForGuild({
    guildId,
    connection,
    player,
    userId,
    textChannel,
    instructions,
}) {
    if (sessions.has(guildId)) {
        throw new Error('Realtime mode is already active for this guild.');
    }

    const rt = new RealtimeSession({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
        voice: process.env.OPENAI_REALTIME_VOICE || 'cedar',
        instructions,
    });

    await rt.connect();

    const outputStream = createOutputPipeline(player);

    let responseInProgress = false;
    let captureInProgress = false;

    rt.on('audioDelta', (delta) => {
        const buffer = Buffer.from(delta, 'base64');
        try {
            outputStream.write(buffer);
        } catch (err) {
            console.error('[RT] output stream write failed:', err);
        }
    });

    rt.on('audioDone', () => {
        console.log('[RT] output audio chunk done');
    });

    rt.on('transcript', async (text) => {
        console.log('[RT] transcript from user:', text);
        if (!textChannel || !text?.trim()) return;

        try {
            await textChannel.send(`\u{1F5E3}\uFE0F **You said:** ${text}`);
        } catch (err) {
            console.error('Transcript send failed:', err);
        }
    });

    rt.on('responseCreated', () => {
        responseInProgress = true;
        console.log('[RT] response started');
    });

    rt.on('responseDone', (event) => {
        responseInProgress = false;
        const status = event?.response?.status;
        console.log('[RT] response done', status ? `(status: ${status})` : '');
    });

    rt.on('error', (err) => {
        console.error('[REALTIME ERROR]', err);
    });

    const receiver = connection.receiver;

    const handleSpeakingStart = (speakingUserId) => {
        if (speakingUserId !== userId) return;

        if (responseInProgress) {
            console.log('[RT] user spoke during playback; cancelling response');
            rt.cancelResponse();
            rt.clearOutputAudioBuffer();
            responseInProgress = false;
        }

        if (captureInProgress) {
            console.log('[RT] ignoring speech because capture is already in progress');
            return;
        }

        captureInProgress = true;
        console.log('[RT] detected speaking start for target user:', speakingUserId);

        const opusStream = receiver.subscribe(speakingUserId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 1000,
            },
        });

        const decoder = new prism.opus.Decoder({
            rate: 48000,
            channels: 2,
            frameSize: 960,
        });

        let appendedBytes = 0;

        decoder.on('data', (chunk) => {
            const pcm24kMono = pcm48kStereoTo24kMono(chunk);
            appendedBytes += pcm24kMono.length;
            rt.appendAudio(pcm24kMono.toString('base64'));
        });

        decoder.on('end', () => {
            captureInProgress = false;

            const minBytesFor100ms = 4800;

            if (appendedBytes < minBytesFor100ms) {
                console.log('[RT] skipping tiny audio segment:', appendedBytes);
                rt.clearInputBuffer();
                return;
            }

            console.log('[RT] committed audio segment, total bytes:', appendedBytes);
            rt.commitAudio();
            if (!responseInProgress) {
                rt.createResponse();
            }
        });

        decoder.on('error', (err) => {
            captureInProgress = false;
            console.error('[RT DECODER ERROR]', err);
        });

        opusStream.on('error', (err) => {
            captureInProgress = false;
            console.error('[RT OPUS STREAM ERROR]', err);
        });

        opusStream.pipe(decoder);
    };

    receiver.speaking.on('start', handleSpeakingStart);

    sessions.set(guildId, {
        rt,
        outputStream,
        userId,
        textChannelId: textChannel?.id ?? null,
        handleSpeakingStart,
        receiver,
    });
}

function stopRealtimeForGuild(guildId) {
    const existing = sessions.get(guildId);
    if (!existing) return false;

    try {
        if (existing.receiver && existing.handleSpeakingStart) {
            existing.receiver.speaking.off('start', existing.handleSpeakingStart);
        }
    } catch {}

    try {
        existing.outputStream.end();
    } catch {}

    try {
        existing.rt.close();
    } catch {}

    sessions.delete(guildId);
    return true;
}

function isRealtimeActive(guildId) {
    return sessions.has(guildId);
}

module.exports = {
    startRealtimeForGuild,
    stopRealtimeForGuild,
    isRealtimeActive,
};
