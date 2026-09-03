const { Events } = require('discord.js');
const { initSpotifyLink } = require('../services/spotifyLink');
const { listLinkedGuildIds, isConfigured } = require('../services/spotifyAuth');
const { ensureConnectDevice } = require('../services/spotifyConnect');
const { hasLibrespotCredentials } = require('../services/spotifyLibrespotOAuth');
const { startYoutubeFeed } = require('../services/youtubeFeed');

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        console.log(`Grokslop is online as ${client.user.tag}`);

        try {
            require('pdf-parse');
            require('mammoth');
            require('xlsx');
            console.log(
                '[attachments] PDF, DOCX, and Excel reading enabled'
            );
        } catch {
            console.warn(
                '[attachments] Document reading disabled — run `npm install` in the bot folder'
            );
        }

        initSpotifyLink(client);
        startYoutubeFeed(client);

        if (isConfigured()) {
            for (const guildId of listLinkedGuildIds()) {
                if (!hasLibrespotCredentials(guildId)) {
                    console.warn(
                        `[spotify] guild ${guildId} linked in DB but missing librespot credentials — run /spotify link`
                    );
                    continue;
                }
                ensureConnectDevice(guildId).catch((e) => {
                    console.error(
                        `[spotify] could not start Connect device for guild ${guildId}:`,
                        e.message || e
                    );
                });
            }
        }
    }
};