const config = require('../config');

/** @typedef {'pdf' | 'docx' | 'xlsx' | 'xls' | 'csv'} DocumentFormat */

const INSTALL_HINT =
    'Run `npm install` in the bot folder (needs pdf-parse, mammoth, xlsx).';

/**
 * @param {string} packageName
 */
function requireDocumentModule(packageName) {
    try {
        return require(packageName);
    } catch (err) {
        if (err?.code === 'MODULE_NOT_FOUND') {
            throw new Error(INSTALL_HINT);
        }
        throw err;
    }
}

function getPdfParse() {
    const mod = requireDocumentModule('pdf-parse');
    return typeof mod === 'function' ? mod : mod.default;
}

function getMammoth() {
    return requireDocumentModule('mammoth');
}

function getXlsx() {
    return requireDocumentModule('xlsx');
}

/**
 * @param {import('discord.js').Attachment} attachment
 */
function classifyAttachment(attachment) {
    const name = (attachment.name || '').toLowerCase();
    const contentType = (attachment.contentType || '').toLowerCase();

    const isText =
        name.endsWith('.txt') ||
        name.endsWith('.log') ||
        name.endsWith('.md') ||
        name.endsWith('.json') ||
        name.endsWith('.csv') ||
        name.endsWith('.xml') ||
        name.endsWith('.yaml') ||
        name.endsWith('.yml') ||
        contentType.startsWith('text/');

    const isImage =
        contentType.startsWith('image/') ||
        /\.(png|jpg|jpeg|gif|webp)$/i.test(name);

    /** @type {DocumentFormat | null} */
    let documentFormat = null;
    if (
        name.endsWith('.pdf') ||
        contentType === 'application/pdf'
    ) {
        documentFormat = 'pdf';
    } else if (
        name.endsWith('.docx') ||
        contentType.includes('wordprocessingml')
    ) {
        documentFormat = 'docx';
    } else if (
        name.endsWith('.xlsx') ||
        contentType.includes('spreadsheetml.sheet')
    ) {
        documentFormat = 'xlsx';
    } else if (
        name.endsWith('.xls') ||
        contentType === 'application/vnd.ms-excel'
    ) {
        documentFormat = 'xls';
    }

    const isLegacyDoc =
        name.endsWith('.doc') && !name.endsWith('.docx');

    return {
        isText: isText && !documentFormat && !isLegacyDoc,
        isImage,
        documentFormat,
        isLegacyDoc,
    };
}

/**
 * @param {string} text
 * @param {number} max
 */
function truncateText(text, max) {
    if (!text) {
        return { text: '', truncated: false };
    }
    const trimmed = text.trim();
    if (trimmed.length <= max) {
        return { text: trimmed, truncated: false };
    }
    return {
        text: `${trimmed.slice(0, max)}\n\n[…truncated for length]`,
        truncated: true,
    };
}

/**
 * @param {import('discord.js').Attachment} attachment
 */
async function fetchAttachmentBuffer(attachment) {
    const size = attachment.size ?? 0;
    if (size > config.maxAttachmentBytes) {
        throw new Error(
            `file is too large (${Math.round(size / 1024 / 1024)}MB; max ${Math.round(config.maxAttachmentBytes / 1024 / 1024)}MB)`
        );
    }

    const response = await fetch(attachment.url);
    if (!response.ok) {
        throw new Error(`download failed (HTTP ${response.status})`);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > config.maxAttachmentBytes) {
        throw new Error('file exceeds size limit after download');
    }
    return buf;
}

/**
 * @param {import('discord.js').Attachment} attachment
 */
async function readTextAttachment(attachment) {
    try {
        const response = await fetch(attachment.url);
        const text = await response.text();
        return truncateText(text, config.maxTextAttachmentChars);
    } catch (error) {
        console.error('Failed to read text attachment:', error);
        return null;
    }
}

/**
 * @param {Buffer} buf
 */
async function extractPdfText(buf) {
    const pdfParse = getPdfParse();
    const data = await pdfParse(buf);
    return data.text || '';
}

/**
 * @param {Buffer} buf
 */
async function extractDocxText(buf) {
    const mammoth = getMammoth();
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value || '';
}

/**
 * @param {Buffer} buf
 */
function extractSpreadsheetText(buf) {
    const XLSX = getXlsx();
    const workbook = XLSX.read(buf, {
        type: 'buffer',
        cellDates: true,
        raw: false,
    });
    const maxRows = config.maxSpreadsheetRowsPerSheet;
    const parts = [];

    for (const sheetName of workbook.SheetNames.slice(0, 8)) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) {
            continue;
        }

        const ref = sheet['!ref'];
        if (!ref) {
            parts.push(`--- Sheet: ${sheetName} ---\n(empty)`);
            continue;
        }

        const range = XLSX.utils.decode_range(ref);
        const rowCount = range.e.r - range.s.r + 1;
        let csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });

        if (rowCount > maxRows) {
            const lines = csv.split('\n');
            csv = lines.slice(0, maxRows + 1).join('\n');
            csv += `\n[…${rowCount - maxRows} more rows not shown]`;
        }

        parts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
    }

    if (workbook.SheetNames.length > 8) {
        parts.push(
            `[…${workbook.SheetNames.length - 8} additional sheets not shown]`
        );
    }

    return parts.join('\n\n');
}

/**
 * @param {import('discord.js').Attachment} attachment
 * @param {DocumentFormat} format
 */
async function readDocumentAttachment(attachment, format) {
    const buf = await fetchAttachmentBuffer(attachment);
    let raw = '';

    if (format === 'pdf') {
        raw = await extractPdfText(buf);
    } else if (format === 'docx') {
        const name = (attachment.name || '').toLowerCase();
        if (name.endsWith('.doc') && !name.endsWith('.docx')) {
            throw new Error(
                'legacy .doc files are not supported — save as .docx and re-upload'
            );
        }
        raw = await extractDocxText(buf);
    } else if (format === 'xlsx' || format === 'xls') {
        raw = extractSpreadsheetText(buf);
    } else {
        throw new Error(`unsupported document format: ${format}`);
    }

    return truncateText(raw, config.maxDocumentAttachmentChars);
}

/**
 * @param {import('discord.js').Message} message
 * @returns {Promise<{ attachments: Array<{ type: string, name?: string, content?: string, url?: string, format?: string, truncated?: boolean }>, warnings: string[] }>}
 */
async function extractAttachments(message) {
    const entries = Array.from(message.attachments.values()).map(
        (attachment) => {
            const { isText, isImage, documentFormat, isLegacyDoc } =
                classifyAttachment(attachment);
            return {
                attachment,
                isText,
                isImage,
                documentFormat,
                isLegacyDoc,
            };
        }
    );

    const warnings = [];
    const results = [];

    const textIndices = [];
    const docIndices = [];

    for (let i = 0; i < entries.length; i++) {
        if (entries[i].isText) {
            textIndices.push(i);
        } else if (entries[i].documentFormat) {
            docIndices.push(i);
        }
    }

    const textContents = await Promise.all(
        textIndices.map((i) => readTextAttachment(entries[i].attachment))
    );
    const textByIndex = new Map(
        textIndices.map((i, j) => [i, textContents[j]])
    );

    const docContents = await Promise.all(
        docIndices.map(async (i) => {
            const { attachment, documentFormat } = entries[i];
            try {
                return await readDocumentAttachment(
                    attachment,
                    documentFormat
                );
            } catch (err) {
                const msg = err?.message || String(err);
                warnings.push(
                    `Could not read **${attachment.name}**: ${msg}`
                );
                console.warn(
                    `[attachments] ${attachment.name}:`,
                    msg
                );
                return null;
            }
        })
    );
    const docByIndex = new Map(
        docIndices.map((i, j) => [i, docContents[j]])
    );

    for (let i = 0; i < entries.length; i++) {
        const { attachment, isText, isImage, documentFormat, isLegacyDoc } =
            entries[i];

        if (isLegacyDoc) {
            warnings.push(
                `**${attachment.name}**: legacy Word \`.doc\` is not supported — save as \`.docx\` and re-upload`
            );
            continue;
        }

        if (isText) {
            const parsed = textByIndex.get(i);
            if (parsed?.text) {
                results.push({
                    type: 'text',
                    name: attachment.name,
                    content: parsed.text,
                    truncated: parsed.truncated,
                });
            }
        } else if (documentFormat) {
            const parsed = docByIndex.get(i);
            if (parsed?.text) {
                results.push({
                    type: 'document',
                    format: documentFormat,
                    name: attachment.name,
                    content: parsed.text,
                    truncated: parsed.truncated,
                });
            }
        } else if (isImage) {
            results.push({
                type: 'image',
                name: attachment.name,
                url: attachment.url,
            });
        } else if (attachment.name) {
            warnings.push(
                `Unsupported file type: **${attachment.name}** (try PDF, DOCX, XLSX, TXT, or an image)`
            );
        }
    }

    return { attachments: results, warnings };
}

module.exports = {
    extractAttachments,
    classifyAttachment,
};
