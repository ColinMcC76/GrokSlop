const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { soundOffPayloads } = require('../utils/soundOffTranscript');

describe('equipment check sound-off transcript', () => {
    it('posts the generated text without pinging anyone', () => {
        const payloads = soundOffPayloads(
            'Check your equipment and sound off.\n@everyone <@&123> stay ready.'
        );
        assert.equal(payloads.length, 1);
        assert.equal(
            payloads[0].content,
            'Check your equipment and sound off.\n@everyone <@&123> stay ready.'
        );
        assert.deepEqual(payloads[0].allowedMentions, { parse: [] });
        assert.equal(payloads[0].allowedMentions.roles, undefined);
        assert.equal(payloads[0].allowedMentions.users, undefined);
    });

    it('rejects an empty transcript', () => {
        assert.throws(() => soundOffPayloads('   '), /empty/);
    });

    it('splits a long transcript and still suppresses mentions', () => {
        const payloads = soundOffPayloads(`${'word '.repeat(800)}@everyone`);
        assert.ok(payloads.length > 1);
        for (const payload of payloads) {
            assert.ok(payload.content.length <= 2000);
            assert.deepEqual(payload.allowedMentions, { parse: [] });
        }
        assert.match(payloads[payloads.length - 1].content, /@everyone/);
    });
});
