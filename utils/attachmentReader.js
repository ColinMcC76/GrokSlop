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
    const entries = Array.from(message.attachments.values()).map((attachment) => {
        const { isText, isImage } = classifyAttachment(attachment);
        return { attachment, isText, isImage };
    });

    const textIndices = [];
    for (let i = 0; i < entries.length; i++) {
        if (entries[i].isText) {
            textIndices.push(i);
        }
    }

    const textContents = await Promise.all(
        textIndices.map((i) => readTextAttachment(entries[i].attachment))
    );

    const textByIndex = new Map(
        textIndices.map((i, j) => [i, textContents[j]])
    );

    const results = [];

    for (let i = 0; i < entries.length; i++) {
        const { attachment, isText, isImage } = entries[i];

        if (isText) {
            const text = textByIndex.get(i);
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
