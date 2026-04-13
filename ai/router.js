const openaiProvider = require('./providers/openai');

async function generateResponse(payload, provider = 'openai') {
    switch (provider) {
        case 'openai':
            return openaiProvider.generate(payload);
        default:
            throw new Error(`Unknown AI provider: ${provider}`);
    }
}

module.exports = {
    generateResponse
};