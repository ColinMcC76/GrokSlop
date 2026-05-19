const { Events } = require('discord.js');
const { startSpotifyOAuthServer } = require('../services/spotifyOAuthServer');
const { listLinkedGuildIds, isConfigured } = require('../services/spotifyAuth');
const { ensureConnectDevice } = require('../services/spotifyConnect');

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        console.log(`Grokslop is online as ${client.user.tag}`);
        startSpotifyOAuthServer(client);

        if (isConfigured()) {
            for (const guildId of listLinkedGuildIds()) {
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