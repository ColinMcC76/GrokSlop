const {
    EndBehaviorType,
    createAudioResource,
    StreamType,
    AudioPlayerStatus,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { Transform } = require('node:stream');
const { RealtimeSession } = require('./realtimeSession');
const { ensurePlaying } = require('./youtubeQueue');

const DISCORD_MSG_MAX = 1900;
const PREFIX_ASSISTANT = '\u{1F916} **Grokslop:** ';
const PREFIX_USER = '\u{1F5E3}\uFE0F **You said:** ';

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

/**
 * Realtime sends s16le PCM mono @ 24kHz. @discordjs/voice Raw → Opus expects 48kHz stereo s16le.
 */
function pcm24kMonoTo48kStereo(pcm24kMono) {
    const nIn = pcm24kMono.length / 2;
    if (nIn === 0) return Buffer.alloc(0);

    const input = new Int16Array(pcm24kMono.buffer, pcm24kMono.byteOffset, nIn);
    const stereoSamples = nIn * 2 * 2;
    const out = new Int16Array(stereoSamples);
    let w = 0;
    for (let i = 0; i < nIn; i++) {
        const s = input[i];
        out[w++] = s;
        out[w++] = s;
        out[w++] = s;
        out[w++] = s;
    }
    return Buffer.from(out.buffer, 0, w * 2);
}

const sessions = new Map();

function createOutputPipeline(player) {
    const upsampler = new Transform({
        transform(chunk, _enc, cb) {
            try {
                cb(null, pcm24kMonoTo48kStereo(chunk));
            } catch (e) {
                cb(e);
            }
        },
    });

    upsampler.on('error', (err) => {
        if (err && err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
            return;
        }
        console.error('[RT PCM upsampler]', err);
    });

    const resource = createAudioResource(upsampler, {
        inputType: StreamType.Raw,
    });

    player.play(resource);

    return upsampler;
}

function waitForWritableRoom(stream) {
    return new Promise((resolve) => {
        if (stream.destroyed || stream.writableEnded) {
            resolve();
            return;
        }
        const finish = () => {
            stream.off('drain', onDrain);
            stream.off('close', onClose);
            stream.off('error', onError);
            resolve();
        };
        const onDrain = () => finish();
        const onClose = () => finish();
        const onError = () => finish();
        stream.once('drain', onDrain);
        stream.once('close', onClose);
        stream.once('error', onError);
    });
}

function queuePcmWrite(stream, buf, chainRef) {
    chainRef.current = chainRef.current.then(async () => {
        if (stream.destroyed) return;
        try {
            const ok = stream.write(buf);
            if (!ok && !stream.destroyed) {
                await waitForWritableRoom(stream);
            }
        } catch (e) {
            if (!stream.destroyed) {
                console.error('[RT] PCM write failed:', e);
            }
        }
    });
}

function splitForDiscord(text, prefix, maxLen = DISCORD_MSG_MAX) {
    const budget = maxLen - prefix.length;
    if (text.length <= budget) {
        return [`${prefix}${text}`];
    }
    const cont = '\u{1F916} *(cont.)* ';
    const parts = [];
    let i = 0;
    let partNum = 0;
    while (i < text.length) {
        const header = partNum === 0 ? prefix : cont;
        const sliceBudget = maxLen - header.length;
        let end = Math.min(i + sliceBudget, text.length);
        if (end < text.length) {
            const cut = text.lastIndexOf(' ', end);
            if (cut > i + Math.min(80, sliceBudget * 0.5)) {
                end = cut + 1;
            }
        }
        const slice = text.slice(i, end).trim();
        if (slice) {
            parts.push(header + slice);
        }
        i = end;
        partNum += 1;
    }
    return parts;
}

async function sendLongMessage(channel, text, prefix) {
    if (!channel || !text?.trim()) return;
    const chunks = splitForDiscord(text.trim(), prefix);
    for (const chunk of chunks) {
        await channel.send(chunk);
    }
}

async function startRealtimeForGuild({
    guildId,
    guild,
    connection,
    player,
    allowedSpeakerIds,
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

    let outputStream = createOutputPipeline(player);
    const pcmWriteChain = { current: Promise.resolve() };
    let tearingDown = false;

    const onPlayerError = (err) => {
        if (tearingDown) return;
        const code = err?.error?.code ?? err?.code;
        if (code === 'ERR_STREAM_PREMATURE_CLOSE') {
            return;
        }
        console.error('[RT AudioPlayer]', err?.message || err);
    };
    player.on('error', onPlayerError);

    function flushLocalPlaybackOnly() {
        pcmWriteChain.current = Promise.resolve();
        try {
            player.stop(true);
        } catch {}
        try {
            outputStream.destroy();
        } catch {}
        outputStream = createOutputPipeline(player);
    }

    function flushLocalPlayback() {
        flushLocalPlaybackOnly();
    }

    let responseInProgress = false;
    /** @type {Map<string, boolean>} */
    const captureByUser = new Map();
    let outputPcmBytesThisResponse = 0;
    let loggedFirstPcmThisResponse = false;

    rt.on('audioDelta', (delta) => {
        if (tearingDown) return;
        const buffer = Buffer.from(delta, 'base64');
        outputPcmBytesThisResponse += buffer.length;
        if (!loggedFirstPcmThisResponse) {
            loggedFirstPcmThisResponse = true;
            console.log('[RT] streaming assistant audio to Discord (PCM chunks incoming)');
        }
        if (process.env.RT_DEBUG === '1') {
            console.log('[RT] audio delta bytes (24k mono):', buffer.length, 'total:', outputPcmBytesThisResponse);
        }
        queuePcmWrite(outputStream, buffer, pcmWriteChain);
    });

    rt.on('audioDone', () => {
        console.log('[RT] output audio chunk done');
    });

    rt.on('assistantTranscript', async (text) => {
        console.log('[RT] assistant said:', text.slice(0, 200) + (text.length > 200 ? '…' : ''));
        if (!textChannel || !text?.trim() || tearingDown) return;
        try {
            await sendLongMessage(textChannel, text, PREFIX_ASSISTANT);
        } catch (err) {
            console.error('Assistant transcript send failed:', err);
        }
    });

    rt.on('transcript', async (text) => {
        console.log('[RT] transcript from user:', text);
        if (!textChannel || !text?.trim() || tearingDown) return;

        try {
            const sourceUserId = transcriptSourceQueue.shift();
            const who =
                isGroupListen && sourceUserId
                    ? await speakerDisplayName(sourceUserId)
                    : null;
            const prefix = who
                ? `\u{1F5E3}\uFE0F **${who}:** `
                : PREFIX_USER;
            await sendLongMessage(textChannel, text, prefix);
        } catch (err) {
            console.error('Transcript send failed:', err);
        }
    });

    rt.on('responseCreated', () => {
        if (tearingDown) return;
        responseInProgress = true;
        outputPcmBytesThisResponse = 0;
        loggedFirstPcmThisResponse = false;
        pcmWriteChain.current = Promise.resolve();
        try {
            player.stop(true);
        } catch {}
        try {
            outputStream.destroy();
        } catch {}
        outputStream = createOutputPipeline(player);
        console.log('[RT] response started (fresh Discord audio pipeline)');
    });

    rt.on('responseDone', (event) => {
        responseInProgress = false;
        const status = event?.response?.status;
        console.log('[RT] response done', status ? `(status: ${status})` : '');
        if (outputPcmBytesThisResponse === 0 && status === 'completed') {
            console.warn(
                '[RT] completed response had 0 bytes of streamed audio. ' +
                    'Set RT_DEBUG=1 and check session.updated output_modalities / response.created. ' +
                    'If still empty, verify OPENAI_REALTIME_MODEL supports speech output.'
            );
        }
        outputPcmBytesThisResponse = 0;
    });

    rt.on('error', (err) => {
        console.error('[REALTIME ERROR]', err);
    });

    const receiver = connection.receiver;
    const botUserId = guild?.client?.user?.id ?? null;

    const isGroupListen = allowedSpeakerIds == null;
    /** FIFO: one entry per committed audio segment, consumed when input transcript arrives */
    const transcriptSourceQueue = [];

    const speakerNameCache = new Map();
    async function speakerDisplayName(userId) {
        if (!guild || !userId) return 'Someone';
        if (speakerNameCache.has(userId)) {
            return speakerNameCache.get(userId);
        }
        try {
            const m = await guild.members.fetch(userId);
            const n = m.displayName || m.user?.username || 'Someone';
            speakerNameCache.set(userId, n);
            return n;
        } catch {
            speakerNameCache.set(userId, 'Someone');
            return 'Someone';
        }
    }

    function shouldCaptureUser(speakingUserId) {
        if (tearingDown) return false;
        if (!speakingUserId) return false;
        if (botUserId && speakingUserId === botUserId) {
            return false;
        }
        if (isGroupListen) {
            return true;
        }
        return allowedSpeakerIds.has(speakingUserId);
    }

    const handleSpeakingStart = (speakingUserId) => {
        if (!shouldCaptureUser(speakingUserId)) return;

        if (responseInProgress) {
            console.log('[RT] user spoke during playback; stopping assistant audio');
            rt.cancelResponse();
            flushLocalPlaybackOnly();
            responseInProgress = false;
        }

        if (captureByUser.get(speakingUserId)) {
            console.log('[RT] ignoring speech; capture already in progress for user:', speakingUserId);
            return;
        }

        captureByUser.set(speakingUserId, true);
        console.log('[RT] detected speaking start for user:', speakingUserId);

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
            captureByUser.delete(speakingUserId);

            const minBytesFor100ms = 4800;

            if (appendedBytes < minBytesFor100ms) {
                console.log('[RT] skipping tiny audio segment:', appendedBytes);
                rt.clearInputBuffer();
                return;
            }

            console.log('[RT] committed audio segment, total bytes:', appendedBytes);
            if (isGroupListen) {
                transcriptSourceQueue.push(speakingUserId);
            }
            rt.commitAudio();
            if (!responseInProgress && !tearingDown) {
                rt.createResponse();
            }
        });

        decoder.on('error', (err) => {
            captureByUser.delete(speakingUserId);
            console.error('[RT DECODER ERROR]', err);
        });

        opusStream.on('error', (err) => {
            captureByUser.delete(speakingUserId);
            console.error('[RT OPUS STREAM ERROR]', err);
        });

        opusStream.pipe(decoder);
    };

    receiver.speaking.on('start', handleSpeakingStart);

    sessions.set(guildId, {
        rt,
        player,
        onPlayerError,
        get outputStream() {
            return outputStream;
        },
        allowedSpeakerIds: isGroupListen ? null : allowedSpeakerIds,
        textChannelId: textChannel?.id ?? null,
        handleSpeakingStart,
        receiver,
        setTearingDown() {
            tearingDown = true;
        },
    });
}

async function stopRealtimeForGuild(guildId) {
    const existing = sessions.get(guildId);
    if (!existing) return false;

    existing.setTearingDown?.();

    try {
        if (existing.receiver && existing.handleSpeakingStart) {
            existing.receiver.speaking.off('start', existing.handleSpeakingStart);
        }
    } catch {}

    try {
        if (existing.player && existing.onPlayerError) {
            existing.player.off('error', existing.onPlayerError);
        }
    } catch {}

    try {
        existing.rt.close();
    } catch {}

    try {
        existing.player?.stop(true);
    } catch {}

    try {
        existing.outputStream?.destroy();
    } catch {}

    try {
        await new Promise((r) => setTimeout(r, 50));
        if (existing.player && existing.player.state.status !== AudioPlayerStatus.Idle) {
            existing.player.stop(true);
        }
    } catch {}

    sessions.delete(guildId);
    ensurePlaying(guildId);
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
