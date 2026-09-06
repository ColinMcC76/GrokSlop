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
const { isSubstantiveTranscript } = require('../utils/transcriptFilter');
const { responseUsedWaitTool } = require('./realtimeTools');
const persona = require('../ai/persona');
const { getActivePromptText } = require('../ai/guildPersonas');
const config = require('../config');

const DISCORD_MSG_MAX = 1900;
const PREFIX_ASSISTANT = '\u{1F916} **Shabbot:** ';
const PREFIX_USER = '\u{1F5E3}\uFE0F **You said:** ';

/** Min RMS (int16 mono) on first ~100ms of audio before we cancel assistant playback (VAD false positives / quiet noise). */
const INTERRUPT_CONFIRM_RMS = Number(process.env.RT_INTERRUPT_MIN_RMS) || 450;
/** Skip committing a finished segment that is this quiet (silence / room tone). */
const COMMIT_MIN_RMS = Number(process.env.RT_COMMIT_MIN_RMS) || 380;
/** 24kHz mono s16le bytes — ~100ms — used to measure speech energy before interrupting playback. */
const INTERRUPT_CONFIRM_BYTES = 4800;
/** Wait this long for STT before assuming the segment was silence. */
const TRANSCRIPT_WAIT_MS = Number(process.env.RT_TRANSCRIPT_WAIT_MS) || 2500;

function pcmMonoInt16Rms(buf) {
    if (!buf || buf.length < 2) return 0;
    const n = buf.length / 2;
    const v = new Int16Array(buf.buffer, buf.byteOffset, n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const s = v[i];
        sum += s * s;
    }
    return Math.sqrt(sum / n);
}

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
        model: config.realtimeModel,
        voice: config.realtimeVoice,
        reasoningEffort: config.realtimeReasoningEffort,
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
    let waitedOutLastResponse = false;
    /** @type {Map<string, boolean>} */
    const captureByUser = new Map();
    let outputPcmBytesThisResponse = 0;
    let loggedFirstPcmThisResponse = false;
    /** @type {{ resolved: boolean, timer: ReturnType<typeof setTimeout> }[]} */
    const pendingTurns = [];

    function clearPendingTurns() {
        for (const turn of pendingTurns) {
            turn.resolved = true;
            clearTimeout(turn.timer);
        }
        pendingTurns.length = 0;
    }

    function queuePendingTurn(sourceUserId) {
        const turn = { resolved: false, timer: null, sourceUserId };
        turn.timer = setTimeout(() => {
            if (turn.resolved || tearingDown) {
                return;
            }
            turn.resolved = true;
            console.log('[RT] skipping response; no transcript (silence/noise)');
        }, TRANSCRIPT_WAIT_MS);
        pendingTurns.push(turn);
    }

    function resolveNextPendingTurn(shouldRespond, reason) {
        while (pendingTurns[0]?.resolved) {
            pendingTurns.shift();
        }
        const turn = pendingTurns.shift();
        if (!turn) {
            return;
        }
        if (turn.resolved) {
            return;
        }
        turn.resolved = true;
        clearTimeout(turn.timer);
        if (shouldRespond && !responseInProgress && !tearingDown) {
            if (isGroupListen && turn.sourceUserId) {
                transcriptSourceQueue.push(turn.sourceUserId);
            }
            rt.createResponse();
            return;
        }
        if (!shouldRespond && reason) {
            console.log('[RT]', reason);
        }
    }

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

    rt.on('waitForUser', () => {
        if (tearingDown) return;
        waitedOutLastResponse = true;
        flushLocalPlaybackOnly();
        responseInProgress = false;
        console.log('[RT] background/silence wait — no spoken reply');
    });

    rt.on('inputTranscript', (text) => {
        if (tearingDown) return;
        const trimmed = text?.trim() ?? '';
        if (isSubstantiveTranscript(trimmed)) {
            resolveNextPendingTurn(true);
            return;
        }
        resolveNextPendingTurn(
            false,
            trimmed
                ? `skipping response; non-substantive transcript: ${trimmed.slice(0, 80)}`
                : 'skipping response; empty transcript'
        );
    });

    rt.on('assistantTranscript', async (text) => {
        if (waitedOutLastResponse) {
            return;
        }
        const trimmed = text?.trim() ?? '';
        if (!isSubstantiveTranscript(trimmed)) {
            if (trimmed) {
                console.log('[RT] assistant transcript skipped (non-substantive):', trimmed.slice(0, 80));
            }
            return;
        }
        console.log('[RT] assistant said:', trimmed.slice(0, 200) + (trimmed.length > 200 ? '…' : ''));
        if (!textChannel || tearingDown) return;
        try {
            await sendLongMessage(textChannel, trimmed, PREFIX_ASSISTANT);
        } catch (err) {
            console.error('Assistant transcript send failed:', err);
        }
    });

    rt.on('transcript', async (text) => {
        const trimmed = text?.trim() ?? '';
        if (!isSubstantiveTranscript(trimmed)) {
            if (trimmed) {
                console.log('[RT] user transcript skipped (non-substantive):', trimmed.slice(0, 80));
            }
            return;
        }
        console.log('[RT] transcript from user:', trimmed);
        if (!textChannel || tearingDown) return;

        try {
            const sourceUserId = transcriptSourceQueue.shift();
            const who =
                isGroupListen && sourceUserId
                    ? await speakerDisplayName(sourceUserId)
                    : null;
            const prefix = who
                ? `\u{1F5E3}\uFE0F **${who}:** `
                : PREFIX_USER;
            await sendLongMessage(textChannel, trimmed, prefix);
        } catch (err) {
            console.error('Transcript send failed:', err);
        }
    });

    rt.on('responseCreated', () => {
        if (tearingDown) return;
        responseInProgress = true;
        waitedOutLastResponse = false;
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
        const waited = waitedOutLastResponse || responseUsedWaitTool(event);
        console.log('[RT] response done', status ? `(status: ${status})` : '', waited ? '(wait_for_user)' : '');
        if (outputPcmBytesThisResponse === 0 && status === 'completed' && !waited) {
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

        if (captureByUser.get(speakingUserId)) {
            console.log('[RT] ignoring speech; capture already in progress for user:', speakingUserId);
            return;
        }

        const mustConfirmSpeech = responseInProgress;

        if (mustConfirmSpeech) {
            console.log(
                '[RT] possible speech during playback; confirming energy before interrupt (user:',
                speakingUserId + ')'
            );
        } else {
            console.log('[RT] detected speaking start for user:', speakingUserId);
        }

        captureByUser.set(speakingUserId, true);

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
        let energySumSq = 0;
        let energySamples = 0;
        let interruptConfirmed = !mustConfirmSpeech;
        let preInterruptBuffer = Buffer.alloc(0);

        function accumulateEnergy(buf) {
            if (!buf || buf.length < 2) return;
            const n = buf.length / 2;
            const v = new Int16Array(buf.buffer, buf.byteOffset, n);
            for (let i = 0; i < n; i++) {
                const s = v[i];
                energySumSq += s * s;
            }
            energySamples += n;
        }

        function segmentRms() {
            return energySamples ? Math.sqrt(energySumSq / energySamples) : 0;
        }

        function abortQuietSegment(reason) {
            captureByUser.delete(speakingUserId);
            try {
                opusStream.destroy();
            } catch {}
            try {
                decoder.destroy();
            } catch {}
            if (reason) {
                console.log('[RT]', reason);
            }
        }

        decoder.on('data', (chunk) => {
            const pcm24kMono = pcm48kStereoTo24kMono(chunk);

            if (!interruptConfirmed) {
                preInterruptBuffer = Buffer.concat([preInterruptBuffer, pcm24kMono]);
                if (preInterruptBuffer.length < INTERRUPT_CONFIRM_BYTES) {
                    return;
                }
                const head = preInterruptBuffer.subarray(0, INTERRUPT_CONFIRM_BYTES);
                const rms = pcmMonoInt16Rms(head);
                if (rms < INTERRUPT_CONFIRM_RMS) {
                    abortQuietSegment(
                        `playback interrupt ignored (low energy, rms=${rms.toFixed(0)} < ${INTERRUPT_CONFIRM_RMS})`
                    );
                    return;
                }
                interruptConfirmed = true;
                console.log(
                    '[RT] user speech confirmed during playback; stopping assistant audio (rms=' +
                        rms.toFixed(0) +
                        ')'
                );
                rt.cancelResponse();
                flushLocalPlaybackOnly();
                responseInProgress = false;

                appendedBytes = preInterruptBuffer.length;
                accumulateEnergy(preInterruptBuffer);
                rt.appendAudio(preInterruptBuffer.toString('base64'));
                preInterruptBuffer = Buffer.alloc(0);
                return;
            }

            appendedBytes += pcm24kMono.length;
            accumulateEnergy(pcm24kMono);
            rt.appendAudio(pcm24kMono.toString('base64'));
        });

        decoder.on('end', () => {
            captureByUser.delete(speakingUserId);

            if (!interruptConfirmed) {
                if (preInterruptBuffer.length > 0) {
                    const rms = pcmMonoInt16Rms(preInterruptBuffer);
                    if (rms < INTERRUPT_CONFIRM_RMS) {
                        console.log(
                            '[RT] playback interrupt ignored (segment ended before confirm, rms=' +
                                rms.toFixed(0) +
                                ')'
                        );
                        return;
                    }
                    interruptConfirmed = true;
                    rt.cancelResponse();
                    flushLocalPlaybackOnly();
                    responseInProgress = false;
                    appendedBytes = preInterruptBuffer.length;
                    accumulateEnergy(preInterruptBuffer);
                    rt.appendAudio(preInterruptBuffer.toString('base64'));
                } else {
                    return;
                }
            }

            const minBytesFor100ms = 4800;
            const rms = segmentRms();

            if (appendedBytes < minBytesFor100ms) {
                console.log('[RT] skipping tiny audio segment:', appendedBytes);
                rt.clearInputBuffer();
                return;
            }

            if (rms < COMMIT_MIN_RMS) {
                console.log(
                    `[RT] skipping quiet audio segment (rms=${rms.toFixed(0)} < ${COMMIT_MIN_RMS})`
                );
                rt.clearInputBuffer();
                return;
            }

            console.log('[RT] committed audio segment, total bytes:', appendedBytes, 'rms:', rms.toFixed(0));
            rt.commitAudio();
            if (!responseInProgress && !tearingDown) {
                queuePendingTurn(speakingUserId);
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
        mode: isGroupListen ? 'group' : 'solo',
        textChannelId: textChannel?.id ?? null,
        handleSpeakingStart,
        receiver,
        setTearingDown() {
            tearingDown = true;
            clearPendingTurns();
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

/**
 * Rebuild realtime instructions from the current guild persona (if any).
 * @param {string} guildId
 * @returns {boolean} true if a session was updated
 */
function refreshRealtimePersona(guildId) {
    const existing = sessions.get(guildId);
    if (!existing?.rt) {
        return false;
    }
    const custom = getActivePromptText(guildId);
    const instructions =
        existing.mode === 'group'
            ? persona.realtimeGroupWithPersona(custom)
            : persona.realtimeSoloWithPersona(custom);
    existing.rt.updateInstructions(instructions);
    return true;
}

module.exports = {
    startRealtimeForGuild,
    stopRealtimeForGuild,
    isRealtimeActive,
    refreshRealtimePersona,
};
