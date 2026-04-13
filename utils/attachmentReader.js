const config = require('../config');

async function readTextAttachment(attachment) {
    try {
        const response = await fetch(attachment.url);
        const text = await response.text();
        return text.slice(0, config.maxTextAttachmentChars);
    } catch (error) {
        console.error('Failed to read text attachment:', error);
        return null;
    }
}

function classifyAttachment(attachment) {
    const name = (attachment.name || '').toLowerCase();
    const contentType = (attachment.contentType || '').toLowerCase();

    const isText =
        name.endsWith('.txt') ||
        name.endsWith('.log') ||
        name.endsWith('.md') ||
        contentType.startsWith('text/');

    const isImage =
        contentType.startsWith('image/') ||
        /\.(png|jpg|jpeg|gif|webp)$/i.test(name);

    return { isText, isImage };
}

async function extractAttachments(message) {
    const results = [];

    for (const attachment of message.attachments.values()) {
        const { isText, isImage } = classifyAttachment(attachment);

        if (isText) {
            const text = await readTextAttachment(attachment);
            if (text) {
                results.push({
                    type: 'text',
                    name: attachment.name,
                    content: text
                });
            }
        } else if (isImage) {
            results.push({
                type: 'image',
                name: attachment.name,
                url: attachment.url
            });
        }
    }

    return results;
}

module.exports = {
    extractAttachments
};