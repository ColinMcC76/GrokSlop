const { EndBehaviorType, createAudioResource, StreamType } = require('@discordjs/voice');
const prism = require('prism-media');
const { Transform } = require('node:stream');
const { once } = require('node:events');
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

/**
 * Realtime sends s16le PCM mono @ 24kHz. @discordjs/voice Raw → Opus expects 48kHz stereo s16le.
 * Upsample with sample doubling (zero-order hold), then duplicate channels — no ffmpeg subprocess.
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
        console.error('[RT PCM upsampler]', err);
    });

    const resource = createAudioResource(upsampler, {
        inputType: StreamType.Raw,
    });

    player.play(resource);

    return upsampler;
}

/**
 * Writable backpressure: without awaiting drain, chunks can be dropped and VC stays silent
 * even when transcripts arrive.
 */
function queuePcmWrite(stream, buf, chainRef) {
    chainRef.current = chainRef.current.then(async () => {
        if (stream.destroyed) return;
        try {
            const ok = stream.write(buf);
            if (!ok && !stream.destroyed) {
                await Promise.race([
                    once(stream, 'drain'),
                    once(stream, 'close'),
                    once(stream, 'error'),
                ]);
            }
        } catch (e) {
            if (!stream.destroyed) {
                console.error('[RT] PCM write failed:', e);
            }
        }
    });
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

    let outputStream = createOutputPipeline(player);
    const pcmWriteChain = { current: Promise.resolve() };

    function flushLocalPlayback() {
        pcmWriteChain.current = Promise.resolve();
        try {
            player.stop(true);
        } catch {}
        try {
            outputStream.destroy();
        } catch {}
        outputStream = createOutputPipeline(player);
    }

    let responseInProgress = false;
    let captureInProgress = false;
    let outputPcmBytesThisResponse = 0;
    let loggedFirstPcmThisResponse = false;

    rt.on('audioDelta', (delta) => {
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
        if (!textChannel || !text?.trim()) return;
        try {
            const clip = text.length > 1800 ? `${text.slice(0, 1800)}…` : text;
            await textChannel.send(`\u{1F916} **Grokslop:** ${clip}`);
        } catch (err) {
            console.error('Assistant transcript send failed:', err);
        }
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
        outputPcmBytesThisResponse = 0;
        loggedFirstPcmThisResponse = false;
        console.log('[RT] response started');
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

    const handleSpeakingStart = (speakingUserId) => {
        if (speakingUserId !== userId) return;

        if (responseInProgress) {
            console.log('[RT] user spoke during playback; cancelling response');
            rt.cancelResponse();
            // output_audio_buffer.clear is WebRTC-only; not valid on the Realtime WebSocket API.
            flushLocalPlayback();
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
        get outputStream() {
            return outputStream;
        },
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
        existing.outputStream.destroy();
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
