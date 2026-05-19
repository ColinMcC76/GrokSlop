const { Events } = require('discord.js');
const { startSpotifyOAuthServer } = require('../services/spotifyOAuthServer');

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        console.log(`Grokslop is online as ${client.user.tag}`);
        startSpotifyOAuthServer(client);
    }
};