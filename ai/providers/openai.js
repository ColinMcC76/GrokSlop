const OpenAI = require('openai');
const config = require('../../config');

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function generate({ instructions, input, attachments = [], useWebSearch = false }) {
    const content = [
        {
            type: 'input_text',
            text: input
        }
    ];

    for (const attachment of attachments) {
        if (attachment.type === 'image') {
            content.push({
                type: 'input_image',
                image_url: attachment.url
            });
        }
    }

    const request = {
        model: config.model,
        instructions,
        input: [
            {
                role: 'user',
                content
            }
        ]
    };

    if (useWebSearch) {
        request.tools = [
            // Check your current OpenAI docs/SDK if this name changes in a future release.
            { type: 'web_search_preview' }
        ];

        request.tool_choice = 'auto';

        request.include = [
            'web_search_call.action.sources'
        ];
    }

    const response = await client.responses.create(request);

    return {
        text: response.output_text?.trim() || 'My brain hit a pothole.',
        raw: response
    };
}

module.exports = {
    generate
};