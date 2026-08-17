const path = require('node:path');
const fs = require('node:fs');
const OpenAI = require('openai');
const { ttsInstructions } = require('../ai/persona');

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

async function generateSpeech(text, options = {}) {
    const outputDir = path.join(__dirname, '..', 'data', 'tts');

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, `speech-${Date.now()}.wav`);

    const speech = await client.audio.speech.create({
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        voice: process.env.OPENAI_TTS_VOICE || 'cedar',
        input: prepareTextForSpeech(text).slice(0, 4000),
        instructions: options.instructions ?? ttsInstructions,
        response_format: 'wav',
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    await fs.promises.writeFile(outputPath, buffer);

    return outputPath;
}

/**
 * Strip markdown so TTS reads naturally.
 * @param {string} text
 */
function prepareTextForSpeech(text) {
    return String(text)
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/__/g, '')
        .replace(/_/g, ' ')
        .replace(/`/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

module.exports = {
    generateSpeech,
    prepareTextForSpeech,
};