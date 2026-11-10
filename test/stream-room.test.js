const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    addItems,
    play,
    pause,
    seek,
    getStreamView,
    reportEnded,
    skip,
} = require('../services/streamRoom');

function item(videoId, durationMs) {
    return {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: videoId,
        durationMs,
    };
}

describe('shared stream clock', () => {
    it('advances only while playing, and pause and seek stick', () => {
        const guildId = 'clock';
        const start = 1_000_000;
        addItems(guildId, [item('abcdefghijk', 60_000)], start);

        const early = getStreamView(guildId, start + 2_000);
        assert.equal(early.status, 'playing');
        assert.equal(early.current.videoId, 'abcdefghijk');
        assert.equal(early.positionMs, 2_000);

        pause(guildId, start + 2_000);
        const held = getStreamView(guildId, start + 5_000);
        assert.equal(held.status, 'paused');
        assert.equal(held.positionMs, 2_000);

        seek(guildId, 20_000, start + 5_000);
        const moved = getStreamView(guildId, start + 9_000);
        assert.equal(moved.status, 'paused');
        assert.equal(moved.positionMs, 20_000);

        play(guildId, start + 9_000);
        const later = getStreamView(guildId, start + 12_000);
        assert.equal(later.status, 'playing');
        assert.equal(later.positionMs, 23_000);
    });

    it('advances the queue once when the video ends', () => {
        const guildId = 'end-once';
        const start = 2_000_000;
        addItems(
            guildId,
            [item('aaaaaaaaaaa', 1_000), item('bbbbbbbbbbb', 5_000)],
            start
        );

        const atEnd = getStreamView(guildId, start + 1_000);
        assert.equal(atEnd.current.videoId, 'bbbbbbbbbbb');
        assert.equal(atEnd.positionMs, 0);
        assert.equal(atEnd.status, 'playing');

        const still = getStreamView(guildId, start + 1_400);
        assert.equal(still.current.videoId, 'bbbbbbbbbbb');
        assert.equal(still.positionMs, 400);

        reportEnded(guildId, 'aaaaaaaaaaa', start + 1_400);
        const afterReport = getStreamView(guildId, start + 1_400);
        assert.equal(afterReport.current.videoId, 'bbbbbbbbbbb');
    });

    it('does not skip again when the same video reports ended twice', () => {
        const guildId = 'ended-twice';
        const start = 3_000_000;
        addItems(
            guildId,
            [item('ccccccccccc', null), item('ddddddddddd', null)],
            start
        );

        reportEnded(guildId, 'ccccccccccc', start + 500);
        reportEnded(guildId, 'ccccccccccc', start + 600);
        const view = getStreamView(guildId, start + 600);
        assert.equal(view.current.videoId, 'ddddddddddd');
        assert.equal(view.total, 1);
    });

    it('skip moves one video ahead', () => {
        const guildId = 'skip-one';
        const start = 4_000_000;
        addItems(
            guildId,
            [item('eeeeeeeeeee', 30_000), item('fffffffffff', 30_000)],
            start
        );
        skip(guildId, start + 1_000);
        const view = getStreamView(guildId, start + 1_000);
        assert.equal(view.current.videoId, 'fffffffffff');
        assert.equal(view.positionMs, 0);
    });
});
