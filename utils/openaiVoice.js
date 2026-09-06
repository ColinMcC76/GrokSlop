/** Built-in voices for gpt-4o-mini-tts / audio/speech. */
const TTS_VOICES = new Set([
    'alloy',
    'ash',
    'ballad',
    'coral',
    'echo',
    'fable',
    'nova',
    'onyx',
    'sage',
    'shimmer',
    'verse',
    'marin',
    'cedar',
]);

/**
 * Built-in voices for gpt-realtime-2 / 2.1.
 * Onyx, nova, and fable are TTS-only and are rejected by Realtime.
 * Docs: https://developers.openai.com/api/docs/guides/realtime-conversations
 */
const REALTIME_VOICES = new Set([
    'alloy',
    'ash',
    'ballad',
    'coral',
    'echo',
    'sage',
    'shimmer',
    'verse',
    'marin',
    'cedar',
]);

const REALTIME_FALLBACK = {
    onyx: 'ash',
    nova: 'marin',
    fable: 'verse',
};

function isCustomVoiceId(value) {
    return /^voice_[A-Za-z0-9]+$/i.test(String(value || '').trim());
}

/**
 * Speech API accepts a built-in name or `{ id: "voice_..." }`.
 * @param {string} value
 * @returns {string | { id: string }}
 */
function toSpeechVoice(value) {
    const raw = String(value || '').trim();
    if (isCustomVoiceId(raw)) {
        return { id: raw };
    }
    return raw || 'cedar';
}

/**
 * Realtime rejects TTS-only names like onyx. Custom IDs use `{ id }`.
 * @param {string} value
 * @returns {string | { id: string }}
 */
function toRealtimeVoice(value) {
    const raw = String(value || '').trim();
    if (isCustomVoiceId(raw)) {
        return { id: raw };
    }
    if (REALTIME_VOICES.has(raw)) {
        return raw;
    }
    const mapped = REALTIME_FALLBACK[raw] || 'cedar';
    if (raw) {
        console.warn(
            `[voice] realtime does not support "${raw}"; using "${mapped}" ` +
                `(valid: ${[...REALTIME_VOICES].join(', ')} or voice_…)`
        );
    }
    return mapped;
}

module.exports = {
    TTS_VOICES,
    REALTIME_VOICES,
    isCustomVoiceId,
    toSpeechVoice,
    toRealtimeVoice,
};
