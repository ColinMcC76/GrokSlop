const { ChannelType } = require('discord.js');
const config = require('../config');
const { joinChannel, leaveChannel, getConnectionData, playAudio } = require('../services/voiceManager');
const {
    enqueue,
    skip,
    stopAndClear,
    getQueueSnapshot,
    setYoutubeVolume,
    getYoutubeVolume,
    pausePlayback,
    resumePlayback,
    seekPlayback,
    seekBy,
    stopPlayback,
    previousTrack,
    moveQueueItem,
    removeUpcoming,
    SEEK_STEP_MS,
} = require('../services/youtubeQueue');
const {
    startRealtimeForGuild,
    stopRealtimeForGuild,
    isRealtimeActive,
    refreshRealtimePersona,
} = require('../services/realtimeVoiceBridge');
const {
    stopDiscordOutput,
    isLinked,
    isActive: isSpotifyActive,
    getConnectMode,
    getDiagnostics,
    ensureConnectDevice,
    stopGuild,
} = require('../services/spotifyConnect');
const {
    isConfigured: spotifyConfigured,
    getGuildSpotifyRow,
    defaultDeviceName,
} = require('../services/spotifyAuth');
const {
    beginSpotifyLink,
    finishSpotifyLink,
    findPendingStateForGuildUser,
    parseRedirectInput,
    formatSpotifyLinkMessage,
    getConnectInstructions,
} = require('../services/spotifyLink');
const { generateSpeech } = require('../services/tts');
const persona = require('../ai/persona');
const {
    addPersona,
    removePersona,
    listPersonas,
    setActivePersona,
    getActivePersonaName,
    getActivePromptText,
} = require('../ai/guildPersonas');
const {
    getGuildMemory,
    getUserMemory,
    upsertGuildMemory,
    upsertUserMemory,
    deleteGuildMemory,
    deleteUserMemory,
    getRecentMessages,
} = require('../ai/memory');
const { generateResponse } = require('../ai/router');
const { splitDiscordContent } = require('../utils/discordChunks');
const {
    getIntroSong,
    clearIntroSong,
    saveAndPlayIntro,
    playStoredIntro,
} = require('../services/introSong');
const {
    runEquipmentCheck,
    generateBody,
} = require('../services/equipmentCheck');
const {
    addSubscription,
    removeSubscription,
    listSubscriptions,
    setDiscordChannel,
    setSummaryChannel,
    resolveDiscordChannel,
    resolveSummaryChannel,
    inspectAndPost,
    postTranscriptToChannel,
} = require('../services/youtubeFeed');

const MAX_MEMORY_KEY = 80;
const MAX_MEMORY_VALUE = 900;
const MAX_QUEUE_LINES = 15;
const SUMMARY_DEFAULT = 30;
const SUMMARY_MIN = 5;
const SUMMARY_MAX = 50;
const SUMMARY_TRANSCRIPT_CHARS = 12_000;

function fail(message, statusCode = 400) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

function asString(value, max) {
    if (value == null) {
        return '';
    }
    const text = String(value).trim();
    return max ? text.slice(0, max) : text;
}

function voiceFailure(err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        return fail(
            'Timed out connecting to voice. Check bot Connect and Speak permissions and try again.'
        );
    }
    const raw = err?.message || String(err);
    if (/521|502|503|504|Unexpected server response/i.test(raw)) {
        return fail(
            'Discord voice gateway returned a temporary error. Try joining again in a few seconds.'
        );
    }
    return fail(raw);
}

function channelName(channel) {
    return channel?.name ? `#${channel.name}` : 'that channel';
}

function pollMinutes() {
    const ms = Number(config.youtubeFeedPollMs) || 5 * 60 * 1000;
    return Math.max(1, Math.round(ms / 60_000));
}

function feedChannelHint() {
    return `#${config.youtubeFeedChannelName || 'youtube-feed'}`;
}

function briefChannelHint() {
    return `#${config.youtubeFeedSummaryChannelName || 'political-spyte-club'}`;
}

function tryRefreshRealtime(guildId) {
    if (!isRealtimeActive(guildId)) {
        return;
    }
    try {
        refreshRealtimePersona(guildId);
    } catch (err) {
        console.error('[dashboard] persona refresh failed:', err?.message || err);
    }
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {string} id
 * @param {'text' | 'voice'} kind
 */
async function fetchChannel(guild, id, kind) {
    if (!id) {
        throw fail(kind === 'voice' ? 'Pick a voice channel.' : 'Pick a text channel.');
    }
    const channel =
        guild.channels.cache.get(id) ||
        (await guild.channels.fetch(id).catch(() => null));
    if (!channel) {
        throw fail('That channel is not available.');
    }
    if (kind === 'voice' && !channel.isVoiceBased()) {
        throw fail('Pick a voice channel.');
    }
    if (kind === 'text' && !channel.isTextBased()) {
        throw fail('Pick a text channel.');
    }
    return channel;
}

async function ensureVoice(ctx) {
    const selected = asString(ctx.body.voiceChannelId);
    if (selected) {
        const channel = await fetchChannel(ctx.guild, selected, 'voice');
        try {
            return await joinChannel(channel);
        } catch (err) {
            throw voiceFailure(err);
        }
    }
    const existing = getConnectionData(ctx.guild.id);
    if (!existing) {
        throw fail('Pick a voice channel.');
    }
    return existing;
}

async function requireMember(ctx) {
    const id = asString(ctx.body.memberId);
    if (!id) {
        throw fail('Pick a member.');
    }
    try {
        return await ctx.guild.members.fetch(id);
    } catch {
        throw fail('That member is not in this server.');
    }
}

function optionalTextChannel(ctx) {
    const id = asString(ctx.body.textChannelId);
    if (!id) {
        return Promise.resolve(null);
    }
    return fetchChannel(ctx.guild, id, 'text');
}

function formatQueue(guildId) {
    const snap = getQueueSnapshot(guildId);
    if (snap.total === 0) {
        return 'The YouTube queue is empty.';
    }
    const lines = [
        `Now: ${snap.current?.title || 'YouTube'}`,
        ...snap.upcoming.slice(0, MAX_QUEUE_LINES).map((item, index) => {
            return `${index + 2}. ${item.title || 'YouTube'}`;
        }),
    ];
    if (snap.upcoming.length > MAX_QUEUE_LINES) {
        lines.push(`…and ${snap.upcoming.length - MAX_QUEUE_LINES} more`);
    }
    return lines.join('\n');
}

function clipTitle(title, max = 80) {
    const text = String(title || '').replace(/\s+/g, ' ').trim() || '(untitled)';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatCheckReport(result) {
    const destLine = result.dest
        ? result.canSend
            ? `Post channel: ${channelName(result.dest)}`
            : `Post channel: ${channelName(result.dest)} (missing Send Messages)`
        : `No post channel — create ${feedChannelHint()} or set the post channel.`;

    const blocks = result.reports.map((report) => {
        if (!report.ok) {
            return `${report.title} (${report.channelId})\n• fetch failed: ${report.error}`;
        }
        const postedNote =
            report.posted > 0
                ? `posted ${report.posted} now`
                : report.unseenCount > 0
                  ? `${report.unseenCount} new, not posted`
                  : 'nothing new to post';
        const lines = (report.latest || []).map((video) => {
            const status = video.wasSeen ? 'already posted' : 'new';
            const when = video.publishedMs
                ? ` (${new Date(video.publishedMs).toISOString().slice(0, 10)})`
                : '';
            return `• ${status} — ${clipTitle(video.title)}${when}\n  ${video.url}`;
        });
        const body = lines.length > 0 ? lines.join('\n') : '• feed loaded but listed no videos';
        return `${report.title} (${report.channelId})\nvia ${report.via} — ${postedNote}\n${body}`;
    });

    const header = `Checked ${result.subscriptions} channel(s). ${destLine}`;
    return `${header}\n\n${blocks.join('\n\n')}`.slice(0, 4000);
}

async function refuseYoutubeBlockers(guildId) {
    if (isRealtimeActive(guildId)) {
        throw fail('Turn off realtime voice before playing YouTube audio.');
    }
    if (isSpotifyActive(guildId)) {
        throw fail(
            'Spotify Connect is using the voice speaker. Unlink Spotify or stop it before YouTube playback.'
        );
    }
}

const handlers = {
    async ping(ctx) {
        const ping = ctx.client.ws.ping;
        if (typeof ping !== 'number' || ping < 0) {
            return `pong — ${ctx.client.user.tag} is online. Gateway ping is not ready yet.`;
        }
        return `pong — ${ctx.client.user.tag} — ${ping}ms`;
    },

    async join(ctx) {
        const id = asString(ctx.body.voiceChannelId);
        const channel = await fetchChannel(ctx.guild, id, 'voice');
        try {
            await joinChannel(channel);
        } catch (err) {
            throw voiceFailure(err);
        }
        return `Joined ${channelName(channel)}.`;
    },

    async leave(ctx) {
        await stopRealtimeForGuild(ctx.guild.id);
        const left = leaveChannel(ctx.guild.id);
        if (!left) {
            throw fail('I am not in a voice channel.');
        }
        return 'Left the voice channel.';
    },

    async volume(ctx) {
        const percent = Number(ctx.body.percent);
        if (!Number.isFinite(percent) || percent < 0 || percent > 100 || percent % 5 !== 0) {
            throw fail('Volume must be in steps of 5 (0, 5, 10, … 100).');
        }
        const data = getConnectionData(ctx.guild.id);
        if (!data) {
            throw fail('The bot is not in a voice channel. Join one, then set volume.');
        }
        setYoutubeVolume(ctx.guild.id, data.player, percent);
        return `YouTube volume set to ${getYoutubeVolume(ctx.guild.id)}%.`;
    },

    async play(ctx) {
        const query = asString(ctx.body.query, 500);
        if (!query) {
            throw fail('Enter a YouTube link or search.');
        }
        await refuseYoutubeBlockers(ctx.guild.id);
        const connection = await ensureVoice(ctx);
        const textChannel = await optionalTextChannel(ctx);
        try {
            const { added, titles } = await enqueue(
                ctx.guild.id,
                connection.player,
                textChannel,
                query
            );
            const preview = titles.slice(0, 3).join(', ');
            const more = added > 3 ? ` (+${added - 3} more)` : '';
            return added === 1
                ? `Queued: ${titles[0]}`
                : `Queued ${added} tracks: ${preview}${more}`;
        } catch (err) {
            if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
                throw voiceFailure(err);
            }
            throw fail(`Could not queue that: ${err?.message || err}`);
        }
    },

    async skip(ctx) {
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('I am not in a voice channel.');
        }
        if (!skip(ctx.guild.id)) {
            throw fail('Nothing is playing or queued.');
        }
        return 'Skipped.';
    },

    async queue_pause(ctx) {
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('I am not in a voice channel.');
        }
        pausePlayback(ctx.guild.id);
        return 'Paused.';
    },

    async queue_play(ctx) {
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('I am not in a voice channel.');
        }
        resumePlayback(ctx.guild.id);
        return 'Playing.';
    },

    async queue_stop(ctx) {
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('I am not in a voice channel.');
        }
        stopPlayback(ctx.guild.id);
        return 'Stopped.';
    },

    async queue_previous(ctx) {
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('I am not in a voice channel.');
        }
        return previousTrack(ctx.guild.id);
    },

    async queue_back(ctx) {
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('I am not in a voice channel.');
        }
        seekBy(ctx.guild.id, -SEEK_STEP_MS);
        return 'Rewound 10 seconds.';
    },

    async queue_forward(ctx) {
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('I am not in a voice channel.');
        }
        seekBy(ctx.guild.id, SEEK_STEP_MS);
        return 'Jumped ahead 10 seconds.';
    },

    async queue_seek(ctx) {
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('I am not in a voice channel.');
        }
        const positionMs = Number(ctx.body.positionMs);
        if (!Number.isFinite(positionMs) || positionMs < 0) {
            throw fail('Pick a spot in the song.');
        }
        seekPlayback(ctx.guild.id, positionMs);
        return 'Moved to that spot in the song.';
    },

    async queue_remove(ctx) {
        const index = Number(ctx.body.index);
        removeUpcoming(ctx.guild.id, index);
        return 'Removed from the queue.';
    },

    async queue_reorder(ctx) {
        moveQueueItem(ctx.guild.id, ctx.body.fromIndex, ctx.body.toIndex);
        return 'Queue order updated.';
    },

    async stop(ctx) {
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('I am not in a voice channel.');
        }
        if (!stopAndClear(ctx.guild.id)) {
            throw fail('The music queue was already empty.');
        }
        return 'Stopped and cleared the queue.';
    },

    async nowplaying(ctx) {
        const snap = getQueueSnapshot(ctx.guild.id);
        if (!snap.current) {
            return 'Nothing in the YouTube queue.';
        }
        return `Now playing: ${snap.current.title || 'YouTube'}\n${snap.current.url || ''}`.trim();
    },

    queue(ctx) {
        return formatQueue(ctx.guild.id);
    },

    async talkon(ctx) {
        const member = await requireMember(ctx);
        if (isRealtimeActive(ctx.guild.id)) {
            throw fail('Realtime voice is already active in this server.');
        }
        if (isSpotifyActive(ctx.guild.id)) {
            throw fail('Stop Spotify Connect playback before realtime voice.');
        }
        stopDiscordOutput(ctx.guild.id);
        const connection = await ensureVoice(ctx);
        const textChannel = await optionalTextChannel(ctx);
        const voiceId = connection.connection.joinConfig.channelId;
        const voice = ctx.guild.channels.cache.get(voiceId);
        await startRealtimeForGuild({
            guildId: ctx.guild.id,
            guild: ctx.guild,
            connection: connection.connection,
            player: connection.player,
            allowedSpeakerIds: new Set([member.id]),
            textChannel,
            instructions: persona.realtimeSoloWithPersona(
                getActivePromptText(ctx.guild.id)
            ),
        });
        return `Realtime voice is on in ${channelName(voice)}. Listening to ${member.displayName}.`;
    },

    async talkgroup(ctx) {
        if (isRealtimeActive(ctx.guild.id)) {
            throw fail('Realtime voice is already active. Turn it off, then start group talk.');
        }
        if (isSpotifyActive(ctx.guild.id)) {
            throw fail('Stop Spotify Connect playback before realtime voice.');
        }
        stopDiscordOutput(ctx.guild.id);
        const connection = await ensureVoice(ctx);
        const textChannel = await optionalTextChannel(ctx);
        const voiceId = connection.connection.joinConfig.channelId;
        const voice = ctx.guild.channels.cache.get(voiceId);
        await startRealtimeForGuild({
            guildId: ctx.guild.id,
            guild: ctx.guild,
            connection: connection.connection,
            player: connection.player,
            allowedSpeakerIds: null,
            textChannel,
            instructions: persona.realtimeGroupWithPersona(
                getActivePromptText(ctx.guild.id)
            ),
        });
        return `Group mode in ${channelName(voice)} — listening to everyone in the channel.`;
    },

    async talkoff(ctx) {
        const stopped = await stopRealtimeForGuild(ctx.guild.id);
        if (!stopped) {
            throw fail('Realtime voice was not active.');
        }
        return 'Realtime voice is off.';
    },

    async say(ctx) {
        const text = asString(ctx.body.text, 500);
        if (!text) {
            throw fail('Enter what GrokSlop should say.');
        }
        if (isRealtimeActive(ctx.guild.id)) {
            throw fail('Realtime voice is on. Turn it off before Say.');
        }
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('Join a voice channel first.');
        }
        try {
            const audioPath = await generateSpeech(text);
            await playAudio(ctx.guild.id, audioPath);
        } catch (err) {
            console.error('[dashboard] say failed:', err);
            throw fail(err?.message || 'I tried to speak and immediately fumbled it.');
        }
        return `Said: ${text}`;
    },

    async equipmentcheck(ctx) {
        const channel = await fetchChannel(ctx.guild, asString(ctx.body.textChannelId), 'text');
        const prompt = asString(ctx.body.prompt, 500) || null;
        await runEquipmentCheck(null, prompt, { guild: ctx.guild, channel });
        return `Equipment check posted in ${channelName(channel)}.`;
    },

    async equipmentchecksoundoff(ctx) {
        if (isRealtimeActive(ctx.guild.id)) {
            throw fail('Realtime voice is on. Turn it off before an equipment check sound-off.');
        }
        if (!getConnectionData(ctx.guild.id)) {
            throw fail('Join a voice channel first, then run sound-off.');
        }
        const channel = await fetchChannel(ctx.guild, asString(ctx.body.textChannelId), 'text');
        const prompt = asString(ctx.body.prompt, 500) || null;
        const body = await generateBody(ctx.guild.id, prompt);
        const audioPath = await generateSpeech(body, {
            instructions: persona.equipmentCheckTtsInstructions,
        });
        await playAudio(ctx.guild.id, audioPath);
        await runEquipmentCheck(null, prompt, { guild: ctx.guild, channel, body });
        return `Sound-off played in voice and posted in ${channelName(channel)}.`;
    },

    async ytfeed_list(ctx) {
        const rows = listSubscriptions(ctx.guild.id);
        const dest = await resolveDiscordChannel(ctx.client, ctx.guild.id);
        const briefDest = await resolveSummaryChannel(ctx.guild);
        const destLine = dest
            ? `New videos go to ${channelName(dest)}.`
            : `No video channel yet — create ${feedChannelHint()} or set the post channel.`;
        const briefLine = briefDest
            ? `Daily briefs go to ${channelName(briefDest)}.`
            : `No brief channel yet — create ${briefChannelHint()} or set the brief channel.`;
        if (rows.length === 0) {
            return `Not watching any YouTube channels.\n${destLine}\n${briefLine}`;
        }
        const lines = rows.map((row) => {
            const title = row.yt_channel_title || row.yt_channel_id;
            return `• ${title} — ${row.yt_channel_id}`;
        });
        return `${destLine}\n${briefLine}\nPolling about every ${pollMinutes()} minutes.\n\n${lines.join('\n')}`.slice(
            0,
            4000
        );
    },

    async ytfeed_add(ctx) {
        const input = asString(ctx.body.channelInput, 400);
        if (!input) {
            throw fail('Enter a channel URL, @handle, RSS URL, or UC… id.');
        }
        const result = await addSubscription(ctx.guild.id, input, ctx.client.user.id);
        const dest = await resolveDiscordChannel(ctx.client, ctx.guild.id);
        const destNote = dest
            ? `New uploads will be posted in ${channelName(dest)} within ${pollMinutes()} minutes.`
            : `Create ${feedChannelHint()} or set the post channel so I know where to post.`;
        if (result.already) {
            return `Already watching ${result.channelTitle}. ${destNote}`;
        }
        return `Watching ${result.channelTitle}. Existing videos were skipped so only new uploads get posted.\n${destNote}`;
    },

    async ytfeed_remove(ctx) {
        const input = asString(ctx.body.channelInput, 400);
        if (!input) {
            throw fail('Enter the channel to stop watching.');
        }
        const result = await removeSubscription(ctx.guild.id, input);
        if (!result.removed) {
            throw fail('That channel is not on the watch list.');
        }
        return `Stopped watching ${result.channelTitle}.`;
    },

    async ytfeed_channel(ctx) {
        const channel = await fetchChannel(ctx.guild, asString(ctx.body.textChannelId), 'text');
        if (
            channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.GuildAnnouncement
        ) {
            throw fail('Pick a text channel to post new videos in.');
        }
        setDiscordChannel(ctx.guild.id, channel.id);
        return `New YouTube videos will be posted in ${channelName(channel)}.`;
    },

    async ytfeed_check(ctx) {
        if (listSubscriptions(ctx.guild.id).length === 0) {
            throw fail('Not watching any YouTube channels yet.');
        }
        const result = await inspectAndPost(ctx.client, ctx.guild.id, {
            channelInput: asString(ctx.body.channelInput, 400) || null,
            forceLatest: Boolean(ctx.body.force),
        });
        return formatCheckReport(result);
    },

    async ytfeed_transcript(ctx) {
        const channel = await fetchChannel(ctx.guild, asString(ctx.body.textChannelId), 'text');
        const video = asString(ctx.body.video, 200);
        if (!video) {
            throw fail('Enter a YouTube URL or video id.');
        }
        const status = await postTranscriptToChannel(channel, video);
        if (status === 'missing') {
            return `Posted a failure note in ${channelName(channel)}. No usable captions were found.`;
        }
        return `Posted the transcript in ${channelName(channel)} (${status}).`;
    },

    async ytfeed_briefchannel(ctx) {
        const channel = await fetchChannel(ctx.guild, asString(ctx.body.textChannelId), 'text');
        setSummaryChannel(ctx.guild.id, channel.id);
        return `Daily transcript briefs will be posted in ${channelName(channel)}.`;
    },

    async ytfeed_brief(ctx) {
        const briefDest = await resolveSummaryChannel(ctx.guild);
        if (!briefDest) {
            throw fail(
                `No brief channel found. Create ${briefChannelHint()} or set the brief channel.`
            );
        }
        const feedDest = await resolveDiscordChannel(ctx.client, ctx.guild.id);
        if (!feedDest || !feedDest.isTextBased()) {
            throw fail('Set a text channel for transcripts first.');
        }
        const video = asString(ctx.body.video, 200);
        if (!video) {
            throw fail('Enter a YouTube URL or video id.');
        }
        const status = await postTranscriptToChannel(feedDest, video);
        return `Transcript ${status} in ${channelName(feedDest)}. Daily brief sent to ${channelName(briefDest)}.`;
    },

    async spotify_status(ctx) {
        const guildId = ctx.guild.id;
        const linked = isLinked(guildId);
        if (linked && !isSpotifyActive(guildId)) {
            try {
                await ensureConnectDevice(guildId);
            } catch (err) {
                console.error('[dashboard] spotify ensureConnectDevice:', err?.message || err);
            }
        }
        const diag = getDiagnostics(guildId);
        const inVoice = Boolean(getConnectionData(guildId));
        const mode = getConnectMode(guildId);
        const lines = [
            linked
                ? `Linked — Connect device: ${diag.deviceName}.`
                : getGuildSpotifyRow(guildId)
                  ? 'Stale link — credentials missing. Unlink, then link again.'
                  : 'Not linked.',
            linked && isSpotifyActive(guildId)
                ? `Connect device running (mode: ${mode ?? 'unknown'}).`
                : linked
                  ? `Connect device not running.${diag.lastLog ? ` Last log: ${diag.lastLog}` : ''}`
                  : '',
            inVoice
                ? 'Bot is in a voice channel — playback on the Connect device is heard in Discord.'
                : 'Bot is not in voice — join a channel before playing.',
        ].filter(Boolean);
        if (linked) {
            lines.push('', getConnectInstructions(diag.deviceName || defaultDeviceName()));
        } else if (!spotifyConfigured()) {
            lines.push('', 'Spotify Connect is not set up. The host needs LIBRESPOT_PATH in .env.');
        } else {
            lines.push('', 'Use Link, sign in, then paste the final browser URL into Finish.');
        }
        return lines.join('\n');
    },

    async spotify_unlink(ctx) {
        await stopGuild(ctx.guild.id, true);
        return 'Spotify unlinked for this server.';
    },

    async spotify_link(ctx) {
        if (!spotifyConfigured()) {
            throw fail(
                'Spotify Connect is not set up on this bot. The host needs LIBRESPOT_PATH in .env.'
            );
        }
        if (isRealtimeActive(ctx.guild.id)) {
            throw fail('Turn off realtime voice before linking Spotify.');
        }
        const { authorizeUrl, deviceName } = await beginSpotifyLink(
            ctx.guild.id,
            ctx.client.user.id
        );
        return {
            message: `${formatSpotifyLinkMessage(deviceName, authorizeUrl)}\n\nPaste the final address-bar URL into Finish.`,
            openUrl: authorizeUrl,
        };
    },

    async spotify_finish(ctx) {
        const raw = asString(ctx.body.redirect, 2000);
        parseRedirectInput(raw);
        const state = findPendingStateForGuildUser(ctx.guild.id, ctx.client.user.id);
        if (!state) {
            throw fail('No pending login for this server. Use Link first, then paste the URL within 15 minutes.');
        }
        const result = await finishSpotifyLink(ctx.client, raw, state);
        return result.discordMessage;
    },

    persona_list(ctx) {
        const rows = listPersonas(ctx.guild.id);
        if (rows.length === 0) {
            return 'No personas saved yet.';
        }
        const active = getActivePersonaName(ctx.guild.id);
        return rows
            .map((row) => {
                const mark = active === row.name ? ' (active)' : '';
                return `• ${row.name}${mark} — ${row.preview.replace(/\n/g, ' ')}`;
            })
            .join('\n')
            .slice(0, 4000);
    },

    persona_show(ctx) {
        const name = getActivePersonaName(ctx.guild.id);
        const prompt = getActivePromptText(ctx.guild.id);
        if (!name || !prompt) {
            return 'No custom persona is active (default only).';
        }
        const body = prompt.length > 1500 ? `${prompt.slice(0, 1497)}...` : prompt;
        return `Active: ${name}\n\n${body}`;
    },

    persona_use(ctx) {
        const rawName = asString(ctx.body.name, 32);
        if (!rawName) {
            throw fail('Enter a persona name.');
        }
        const name = setActivePersona(ctx.guild.id, rawName);
        tryRefreshRealtime(ctx.guild.id);
        return `Active persona is now ${name} (text chat and realtime voice).`;
    },

    persona_reset(ctx) {
        setActivePersona(ctx.guild.id, null);
        tryRefreshRealtime(ctx.guild.id);
        return 'Active persona cleared. Default instructions only.';
    },

    persona_add(ctx) {
        const rawName = asString(ctx.body.name, 32);
        const prompt = asString(ctx.body.personaPrompt, 4000);
        if (!rawName || !prompt) {
            throw fail('Enter a persona name and prompt.');
        }
        const name = addPersona(ctx.guild.id, rawName, prompt);
        tryRefreshRealtime(ctx.guild.id);
        return `Saved persona ${name}. Use it to apply it.`;
    },

    persona_remove(ctx) {
        const rawName = asString(ctx.body.name, 32);
        if (!rawName) {
            throw fail('Enter a persona name.');
        }
        const removed = removePersona(ctx.guild.id, rawName);
        if (!removed) {
            throw fail('No persona with that name found.');
        }
        tryRefreshRealtime(ctx.guild.id);
        return 'Persona removed.';
    },

    async memory_recall(ctx) {
        const keyFilter = asString(ctx.body.key, MAX_MEMORY_KEY) || null;
        const memberId = asString(ctx.body.memberId);
        if (memberId) {
            await requireMember(ctx);
        }
        const rows = memberId
            ? getUserMemory(ctx.guild.id, memberId, 20)
            : getGuildMemory(ctx.guild.id, 20);
        const filtered = keyFilter ? rows.filter((row) => row.key === keyFilter) : rows;
        const lines = filtered.slice(0, 10).map((row) => {
            const value = row.value.length > 200 ? `${row.value.slice(0, 197)}...` : row.value;
            return `${row.key}: ${value}`;
        });
        const header = memberId ? 'Member memory' : 'Server memory';
        const body =
            lines.length > 0
                ? lines.join('\n')
                : keyFilter
                  ? `No entry for key ${keyFilter}.`
                  : 'Nothing stored yet.';
        return `${header}\n${body}`;
    },

    async memory_remember(ctx) {
        let key = asString(ctx.body.key, MAX_MEMORY_KEY);
        let value = asString(ctx.body.value, MAX_MEMORY_VALUE);
        if (!key || !value) {
            throw fail('Key and value cannot be empty.');
        }
        const memberId = asString(ctx.body.memberId);
        if (memberId) {
            await requireMember(ctx);
        }
        if (memberId) {
            upsertUserMemory(ctx.guild.id, memberId, key, value);
            return `Saved for that member: ${key}`;
        }
        upsertGuildMemory(ctx.guild.id, key, value);
        return `Saved for this server: ${key}`;
    },

    async memory_forget(ctx) {
        const key = asString(ctx.body.key, MAX_MEMORY_KEY);
        if (!key) {
            throw fail('Key cannot be empty.');
        }
        const memberId = asString(ctx.body.memberId);
        if (memberId) {
            await requireMember(ctx);
        }
        const removed = memberId
            ? deleteUserMemory(ctx.guild.id, memberId, key)
            : deleteGuildMemory(ctx.guild.id, key);
        return removed > 0 ? `Removed ${key}.` : `No entry found for ${key}.`;
    },

    async intro_set(ctx) {
        const query = asString(ctx.body.introQuery, 500);
        if (!query) {
            throw fail('Enter a YouTube link or search for the intro.');
        }
        const member = await requireMember(ctx);
        await ensureVoice(ctx);
        const textChannel = await optionalTextChannel(ctx);
        try {
            const { title } = await saveAndPlayIntro(member, textChannel, query);
            return `Intro locked in and playing for ${member.displayName}: ${title || query}`;
        } catch (err) {
            throw fail(`Could not set intro: ${err?.message || err}`);
        }
    },

    async intro_play(ctx) {
        const member = await requireMember(ctx);
        await ensureVoice(ctx);
        const textChannel = await optionalTextChannel(ctx);
        try {
            const { title } = await playStoredIntro(member, textChannel);
            return `Playing ${member.displayName}'s intro: ${title || 'YouTube'}`;
        } catch (err) {
            throw fail(`Could not play intro: ${err?.message || err}`);
        }
    },

    async intro_clear(ctx) {
        const member = await requireMember(ctx);
        const existing = getIntroSong(member.id);
        clearIntroSong(member.id);
        if (!existing) {
            return `${member.displayName} did not have an intro saved.`;
        }
        return `Cleared the intro for ${member.displayName}.`;
    },

    async summarize(ctx) {
        const channel = await fetchChannel(ctx.guild, asString(ctx.body.textChannelId), 'text');
        const rawLimit = Number(ctx.body.limit);
        const limit = Math.min(
            SUMMARY_MAX,
            Math.max(SUMMARY_MIN, Number.isFinite(rawLimit) ? rawLimit : SUMMARY_DEFAULT)
        );
        const rows = getRecentMessages(channel.id, limit);
        if (rows.length === 0) {
            throw fail('No saved messages in this channel yet.');
        }
        const lines = rows.map((row) => {
            const who = row.is_bot ? `${row.username} (bot)` : row.username;
            const text = (row.content || '').replace(/\s+/g, ' ').trim() || '(no text)';
            return `${who}: ${text}`;
        });
        let transcript = lines.join('\n');
        if (transcript.length > SUMMARY_TRANSCRIPT_CHARS) {
            transcript = transcript.slice(-SUMMARY_TRANSCRIPT_CHARS);
        }
        const baseInstructions = `You summarize a short excerpt of a Discord text channel.
Output a concise bullet list of the main topics and any clear decisions or action items.
Do not invent messages or facts that are not implied by the excerpt.
If the excerpt is mostly noise or off-topic, say so briefly.`;
        const instructions = persona.withCustomPersona(
            baseInstructions,
            getActivePromptText(ctx.guild.id)
        );
        let result;
        try {
            result = await generateResponse({
                instructions,
                input: `Recent messages in this channel (oldest first among this batch):\n\n${transcript}`,
                attachments: [],
                useWebSearch: false,
            });
        } catch (err) {
            console.error('[dashboard] summarize failed:', err);
            throw fail('Could not generate a summary right now.');
        }
        const text =
            typeof result === 'string' ? result : result.text || 'Summary unavailable.';
        const chunks = splitDiscordContent(text, 1900);
        if (chunks.length === 0) {
            throw fail('Summary was empty.');
        }
        await channel.send({ content: chunks[0], allowedMentions: { parse: [] } });
        for (let i = 1; i < chunks.length; i += 1) {
            const piece = chunks[i].startsWith('*(continued)*')
                ? chunks[i]
                : `*(continued)*\n${chunks[i]}`;
            await channel.send({ content: piece, allowedMentions: { parse: [] } });
        }
        return `Posted in ${channelName(channel)}.\n\n${text}`;
    },
};

/**
 * @param {import('discord.js').Client} client
 * @param {Record<string, unknown>} body
 */
async function runAction(client, body) {
    if (!client || typeof client.isReady !== 'function' || !client.isReady()) {
        throw fail('GrokSlop is not online yet.', 503);
    }
    const name = asString(body.action, 64);
    const handler = handlers[name];
    if (!handler) {
        throw fail(`Unknown action: ${name || '(none)'}`);
    }

    /** @type {{ client: import('discord.js').Client, guild: import('discord.js').Guild | null, body: Record<string, unknown> }} */
    const ctx = { client, guild: null, body };
    if (name !== 'ping') {
        const guildId = asString(body.guildId);
        if (!guildId) {
            throw fail('Pick a server.');
        }
        const guild =
            client.guilds.cache.get(guildId) ||
            (await client.guilds.fetch(guildId).catch(() => null));
        if (!guild) {
            throw fail('That server is not available.');
        }
        ctx.guild = guild;
    }

    console.log(`[dashboard] ${name}`);
    const result = await handler(ctx);
    if (typeof result === 'string') {
        return { ok: true, message: result };
    }
    return { ok: true, message: result.message, openUrl: result.openUrl };
}

module.exports = {
    runAction,
};
