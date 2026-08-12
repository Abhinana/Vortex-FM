"use strict";

const {
    SlashCommandBuilder,
    MessageFlags
} = require("discord.js");

const config = require("../../config.js");

const SpotifyWebApi = require("spotify-web-api-node");

const {
    getData
} = require("spotify-url-info")(require("node-fetch"));

const {
    sendErrorResponse,
    handleCommandError,
    safeDeferReply,
    buildPaleCard,
    sanitizeTitle,
    stripLeadingIcons
} = require("../../utils/responseHandler.js");

const {
    checkVoiceChannel: checkVC
} = require("../../utils/voiceChannelCheck.js");

const {
    getLavalinkManager
} = require("../../lavalink.js");

const {
    getLang
} = require("../../utils/languageLoader");

const {
    getEmoji
} = require("../../UI/emojis/emoji");

const requesters = new Map();

/* =========================================================
   DURATION
========================================================= */

function formatDuration(ms) {
    ms = Number(ms) || 0;

    if (ms <= 0) {
        return "0s";
    }

    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);

    return [
        hours > 0 ? `${hours}h` : null,
        minutes > 0 ? `${minutes}m` : null,
        `${seconds}s`
    ]
        .filter(Boolean)
        .join(" ");
}

/* =========================================================
   COMMAND
========================================================= */

const data = new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song from a name or link")
    .addStringOption(option =>
        option
            .setName("name")
            .setDescription("Enter song name / link or playlist")
            .setRequired(true)
            .setAutocomplete(true)
    );

/* =========================================================
   SPOTIFY
========================================================= */

const spotifyApi = new SpotifyWebApi({
    clientId: config.spotifyClientId,
    clientSecret: config.spotifyClientSecret
});

async function getSpotifyPlaylistTracks(playlistId) {
    try {
        const auth = await spotifyApi.clientCredentialsGrant();

        spotifyApi.setAccessToken(
            auth.body.access_token
        );

        const tracks = [];

        let offset = 0;
        const limit = 100;
        let total = 0;

        do {
            const response =
                await spotifyApi.getPlaylistTracks(
                    playlistId,
                    {
                        limit,
                        offset
                    }
                );

            total = response.body.total;

            for (const item of response.body.items || []) {
                const track = item?.track;

                if (
                    track &&
                    track.name &&
                    Array.isArray(track.artists)
                ) {
                    const trackName =
                        `${track.name} - ${track.artists
                            .map(a => a.name)
                            .join(", ")}`;

                    tracks.push(trackName);
                }
            }

            offset += limit;

        } while (offset < total);

        return tracks;

    } catch (error) {
        console.error(
            "[SPOTIFY] Playlist error:",
            error
        );

        return [];
    }
}

/* =========================================================
   SAFE PLAYER START
========================================================= */

async function startPlayer(player) {
    if (!player) {
        throw new Error(
            "Player was not created."
        );
    }

    if (player.destroyed) {
        throw new Error(
            "Player was destroyed before playback started."
        );
    }

    /*
     * Riffy handles the actual Lavalink playback.
     *
     * Do NOT wait for player.connected here.
     * That property is not a reliable indication of
     * the voice connection state in this setup.
     */

    if (
        !player.playing &&
        !player.paused &&
        !player.current
    ) {
        console.log(
            "[MUSIC] Starting queued track..."
        );

        await Promise.resolve(
            player.play()
        );
    }
}

/* =========================================================
   MODULE
========================================================= */

module.exports = {

    data,

    run: async (client, interaction) => {

        try {

            /* =================================================
               AUTOCOMPLETE
            ================================================= */

            if (interaction.isAutocomplete()) {

                const focusedOption =
                    interaction.options.getFocused(true);

                if (
                    focusedOption.name !== "name"
                ) {
                    return interaction.respond([]);
                }

                const query =
                    focusedOption.value?.trim() || "";

                if (query.length < 2) {
                    return interaction.respond([]);
                }

                try {

                    const nodeManager =
                        getLavalinkManager();

                    if (!nodeManager) {
                        return interaction.respond([]);
                    }

                    await nodeManager.ensureNodeAvailable();

                    const resolve =
                        await client.riffy.resolve({
                            query,
                            requester:
                                interaction.user.username
                        });

                    if (
                        !resolve ||
                        !Array.isArray(resolve.tracks) ||
                        resolve.tracks.length === 0
                    ) {
                        return interaction.respond([]);
                    }

                    const choices =
                        resolve.tracks
                            .slice(0, 25)
                            .map(track => {

                                const info =
                                    track?.info;

                                if (!info) {
                                    return null;
                                }

                                const duration =
                                    formatDuration(
                                        info.length
                                    );

                                const display =
                                    `${info.title} - ${info.author} (${duration})`;

                                return {
                                    name:
                                        display.length > 100
                                            ? display.substring(0, 97) + "..."
                                            : display,

                                    value:
                                        info.uri || query
                                };
                            })
                            .filter(Boolean);

                    return interaction.respond(
                        choices
                    );

                } catch (error) {

                    console.error(
                        "[AUTOCOMPLETE]",
                        error
                    );

                    return interaction.respond([]);
                }
            }

            /* =================================================
               LANGUAGE
            ================================================= */

            const lang =
                await getLang(
                    interaction.guildId
                );

            const t =
                lang.music.play;

            /* =================================================
               QUERY
            ================================================= */

            const query =
                interaction.options
                    .getString("name")
                    ?.trim();

            if (!query) {
                return;
            }

            /* =================================================
               DEFER
            ================================================= */

            const deferred =
                await safeDeferReply(
                    interaction
                );

            if (
                !deferred &&
                !interaction.deferred &&
                !interaction.replied
            ) {
                return;
            }

            /* =================================================
               EXISTING PLAYER
            ================================================= */

            const existingPlayer =
                client.riffy.players.get(
                    interaction.guildId
                );

            const voiceCheck =
                await checkVC(
                    interaction,
                    existingPlayer
                );

            if (!voiceCheck.allowed) {

                const reply =
                    await interaction.editReply(
                        voiceCheck.response
                    );

                setTimeout(() => {
                    reply
                        .delete()
                        .catch(() => {});
                }, 5000);

                return reply;
            }

            /* =================================================
               LAVALINK MANAGER
            ================================================= */

            const nodeManager =
                getLavalinkManager();

            if (!nodeManager) {

                return sendErrorResponse(
                    interaction,

                    t.lavalinkManagerError.title +
                    "\n\n" +
                    t.lavalinkManagerError.message +
                    "\n" +
                    t.lavalinkManagerError.note,

                    5000
                );
            }

            try {

                await nodeManager
                    .ensureNodeAvailable();

            } catch (error) {

                const nodeCount =
                    nodeManager.getNodeCount();

                const totalCount =
                    nodeManager.getTotalNodeCount();

                return sendErrorResponse(
                    interaction,

                    t.noNodes.title +
                    "\n\n" +

                    t.noNodes.message
                        .replace(
                            "{connected}",
                            nodeCount
                        )
                        .replace(
                            "{total}",
                            totalCount
                        ) +

                    "\n" +

                    t.noNodes.note,

                    5000
                );
            }

            /* =================================================
               VOICE CHANNEL
            ================================================= */

            const userVoiceChannel =
                interaction.member.voice.channelId;

            if (!userVoiceChannel) {

                return sendErrorResponse(
                    interaction,
                    "❌ You must be in a voice channel.",
                    5000
                );
            }

            /* =================================================
               DESTROY PLAYER IF DIFFERENT VC
            ================================================= */

            if (
                existingPlayer &&
                existingPlayer.voiceChannel !==
                    userVoiceChannel
            ) {

                try {

                    const {
                        cleanupTrackMessages
                    } = require("../../player.js");

                    await cleanupTrackMessages(
                        client,
                        existingPlayer
                    );

                } catch (error) {

                    console.error(
                        "[PLAY] Cleanup error:",
                        error
                    );
                }

                try {

                    existingPlayer.queue.clear();

                } catch (_) {}

                try {

                    existingPlayer.stop();

                } catch (_) {}

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            300
                        )
                );

                try {

                    existingPlayer.destroy();

                } catch (_) {}

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            500
                        )
                );
            }

            /* =================================================
               NODE HEALTH
            ================================================= */

            await nodeManager
                .checkAllNodesHealth()
                .catch(() => {});

            await nodeManager
                .forceConnectAllNodes()
                .catch(() => {});

            /* =================================================
               CREATE / GET PLAYER
            ================================================= */

            let player = null;

            let attempts = 0;
            const maxAttempts = 3;

            while (
                attempts < maxAttempts &&
                !player
            ) {

                attempts++;

                try {

                    await nodeManager
                        .ensureNodeAvailable();

                    player =
                        client.riffy.createConnection({
                            guildId:
                                interaction.guildId,

                            voiceChannel:
                                userVoiceChannel,

                            textChannel:
                                interaction.channelId,

                            deaf: true
                        });

                } catch (error) {

                    console.error(
                        `[PLAY] Player creation attempt ${attempts}:`,
                        error?.message ||
                        error
                    );

                    const msg =
                        error?.message || "";

                    if (
                        attempts <
                            maxAttempts &&
                        (
                            msg.includes(
                                "No nodes are available"
                            ) ||
                            msg.includes(
                                "fetch failed"
                            ) ||
                            msg.includes(
                                "ECONNREFUSED"
                            )
                        )
                    ) {

                        await nodeManager
                            .reconnectNodesNow?.(
                                5000
                            )
                            .catch(() => {});

                        await nodeManager
                            .ensureNodeAvailable()
                            .catch(() => {});

                        await new Promise(
                            resolve =>
                                setTimeout(
                                    resolve,
                                    700
                                )
                        );

                        continue;
                    }

                    if (
                        attempts >=
                        maxAttempts
                    ) {

                        try {

                            await nodeManager
                                .refreshRiffy?.();

                        } catch (_) {}

                        await nodeManager
                            .ensureNodeAvailable();

                        player =
                            client.riffy.createConnection({
                                guildId:
                                    interaction.guildId,

                                voiceChannel:
                                    userVoiceChannel,

                                textChannel:
                                    interaction.channelId,

                                deaf: true
                            });

                        break;
                    }

                    throw error;
                }
            }

            if (!player) {
                throw new Error(
                    "Unable to create Riffy player."
                );
            }

            /* =================================================
               RESOLVE / QUEUE
            ================================================= */

            let tracksToQueue = [];

            let isPlaylist = false;

            let queuedTracks = 0;

            /* =================================================
               SPOTIFY
            ================================================= */

            if (
                query.includes(
                    "spotify.com"
                )
            ) {

                try {

                    const spotifyData =
                        await getData(query);

                    if (
                        spotifyData.type ===
                        "track"
                    ) {

                        const trackName =
                            `${spotifyData.name} - ${spotifyData.artists
                                .map(a => a.name)
                                .join(", ")}`;

                        tracksToQueue.push(
                            trackName
                        );

                    } else if (
                        spotifyData.type ===
                        "playlist"
                    ) {

                        isPlaylist = true;

                        const playlistId =
                            query
                                .split(
                                    "/playlist/"
                                )[1]
                                ?.split("?")[0];

                        if (!playlistId) {
                            throw new Error(
                                "Invalid Spotify playlist URL."
                            );
                        }

                        tracksToQueue =
                            await getSpotifyPlaylistTracks(
                                playlistId
                            );
                    }

                } catch (error) {

                    console.error(
                        "[SPOTIFY]",
                        error
                    );

                    return sendErrorResponse(
                        interaction,

                        t.spotifyError.title +
                        "\n\n" +
                        t.spotifyError.message +
                        "\n" +
                        t.spotifyError.note,

                        5000
                    );
                }

            } else {

               /* =================================================
   NORMAL SEARCH / URL
================================================= */

let resolve = null;

try {

    /*
     * First try the original query.
     *
     * This supports:
     * - YouTube URLs
     * - YouTube searches
     * - other Lavalink-supported queries
     */
    resolve =
        await client.riffy.resolve({
            query,
            requester:
                interaction.user.username
        });

} catch (error) {

    console.error(
        "[PLAY] Initial resolve failed:",
        error?.message || error
    );

    const msg =
        error?.message || "";

    if (
        msg.includes("fetch failed") ||
        msg.includes("No nodes are available") ||
        error?.cause?.code === "ECONNREFUSED"
    ) {

        await nodeManager
            .reconnectNodesNow?.(5000)
            .catch(() => {});

        await nodeManager
            .ensureNodeAvailable();

        resolve =
            await client.riffy.resolve({
                query,
                requester:
                    interaction.user.username
            });

    } else {

        throw error;
    }
}


/* =================================================
   YOUTUBE URL TITLE FALLBACK
================================================= */

const isYouTubeUrl =
    /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i
        .test(query);


if (
    isYouTubeUrl &&
    (
        !resolve ||
        !Array.isArray(resolve.tracks) ||
        resolve.tracks.length === 0
    )
) {

    console.log(
        "[PLAY] Direct YouTube URL failed."
    );

    console.log(
        "[PLAY] Trying YouTube title fallback..."
    );

    try {

        const response =
            await fetch(
                `https://www.youtube.com/oembed?url=${encodeURIComponent(query)}&format=json`,
                {
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0"
                    }
                }
            );

        if (response.ok) {

            const data =
                await response.json();

            const youtubeTitle =
                data?.title?.trim();

            if (youtubeTitle) {

                console.log(
                    `[PLAY] YouTube title: ${youtubeTitle}`
                );

                resolve =
                    await client.riffy.resolve({
                        query:
                            youtubeTitle,

                        requester:
                            interaction.user.username
                    });

            }

        } else {

            console.log(
                `[PLAY] YouTube oEmbed failed: HTTP ${response.status}`
            );
        }

    } catch (error) {

        console.error(
            "[PLAY] YouTube title fallback failed:",
            error?.message || error
        );
    }
}


/* =================================================
   VALIDATE RESULT
================================================= */

if (
    !resolve ||
    typeof resolve !== "object" ||
    !Array.isArray(resolve.tracks)
) {

    return sendErrorResponse(
        interaction,

        t.invalidResponse.title +
        "\n\n" +
        t.invalidResponse.message +
        "\n" +
        t.invalidResponse.note,

        5000
    );
}


/* =================================================
   PLAYLIST
================================================= */

if (
    resolve.loadType === "playlist"
) {

    isPlaylist = true;

    for (
        const track
        of resolve.tracks
    ) {

        if (!track?.info) {
            continue;
        }

        track.info.requester =
            interaction.user.username;

        player.queue.add(
            track
        );

        if (track.info.uri) {

            requesters.set(
                track.info.uri,
                interaction.user.username
            );
        }

        queuedTracks++;
    }
}


/* =================================================
   SINGLE TRACK / SEARCH
================================================= */

else if (
    resolve.loadType === "search" ||
    resolve.loadType === "track"
) {

    const track =
        resolve.tracks[0];

    if (!track?.info) {

        return sendErrorResponse(
            interaction,

            t.noResults.title +
            "\n\n" +
            t.noResults.message +
            "\n" +
            t.noResults.note,

            5000
        );
    }

    track.info.requester =
        interaction.user.username;

    player.queue.add(
        track
    );

    if (track.info.uri) {

        requesters.set(
            track.info.uri,
            interaction.user.username
        );
    }

    queuedTracks = 1;

}


/* =================================================
   NO RESULTS
================================================= */

else {

    return sendErrorResponse(
        interaction,

        t.noResults.title +
        "\n\n" +
        t.noResults.message +
        "\n" +
        t.noResults.note,

        5000
    );
}

            /* =============================================
               PLAYLIST
            ============================================= */

            if (
                resolve.loadType ===
                "playlist"
            ) {

                isPlaylist = true;

                for (
                    const track
                    of resolve.tracks
                ) {

                    if (!track?.info) {
                        continue;
                    }


                    track.info.requester =
                        interaction.user.username;


                    player.queue.add(
                        track
                    );


                    if (
                        track.info.uri
                    ) {

                        requesters.set(
                            track.info.uri,
                            interaction.user.username
                        );
                    }


                    queuedTracks++;
                }

            }


            /* =============================================
               SINGLE TRACK / SEARCH
            ============================================= */

            else if (
                resolve.loadType ===
                    "search" ||
                resolve.loadType ===
                    "track"
            ) {

                const track =
                    resolve.tracks[0];


                if (!track?.info) {

                    return sendErrorResponse(
                        interaction,

                        t.noResults.title +
                        "\n\n" +
                        t.noResults.message +
                        "\n" +
                        t.noResults.note,

                        5000
                    );
                }


                track.info.requester =
                    interaction.user.username;


                player.queue.add(
                    track
                );


                if (
                    track.info.uri
                ) {

                    requesters.set(
                        track.info.uri,
                        interaction.user.username
                    );
                }


                queuedTracks = 1;

            }


            /* =============================================
               UNKNOWN LOAD TYPE
            ============================================= */

            else {

                return sendErrorResponse(
                    interaction,

                    t.noResults.title +
                    "\n\n" +
                    t.noResults.message +
                    "\n" +
                    t.noResults.note,

                    5000
                );
            }
        }
                /* =============================================
                   PLAYLIST
                ============================================= */

                if (
                    resolve.loadType ===
                    "playlist"
                ) {

                    isPlaylist = true;

                    for (
                        const track
                        of resolve.tracks
                    ) {

                        if (!track?.info) {
                            continue;
                        }

                        track.info.requester =
                            interaction.user.username;

                        player.queue.add(
                            track
                        );

                        if (
                            track.info.uri
                        ) {

                            requesters.set(
                                track.info.uri,
                                interaction.user.username
                            );
                        }

                        queuedTracks++;
                    }

                }

                /* =============================================
                   SINGLE TRACK / SEARCH
                ============================================= */

                else if (
                    resolve.loadType ===
                        "search" ||
                    resolve.loadType ===
                        "track"
                ) {

                    const track =
                        resolve.tracks[0];

                    if (!track?.info) {

                        return sendErrorResponse(
                            interaction,

                            t.noResults.title +
                            "\n\n" +
                            t.noResults.message +
                            "\n" +
                            t.noResults.note,

                            5000
                        );
                    }

                    track.info.requester =
                        interaction.user.username;

                    player.queue.add(
                        track
                    );

                    if (
                        track.info.uri
                    ) {

                        requesters.set(
                            track.info.uri,
                            interaction.user.username
                        );
                    }

                    queuedTracks = 1;

                } else {

                    return sendErrorResponse(
                        interaction,

                        t.noResults.title +
                        "\n\n" +
                        t.noResults.message +
                        "\n" +
                        t.noResults.note,

                        5000
                    );
                }
            }

            /* =================================================
               SPOTIFY TRACKS / PLAYLIST TRACKS
            ================================================= */

            const maxTracks = 200;

            for (
                let i = 0;
                i <
                    Math.min(
                        tracksToQueue.length,
                        maxTracks
                    );
                i++
            ) {

                const trackQuery =
                    tracksToQueue[i];

                if (!trackQuery) {
                    continue;
                }

                try {

                    const resolve =
                        await client.riffy.resolve({
                            query:
                                trackQuery,

                            requester:
                                interaction.user.username
                        });

                    if (
                        resolve &&
                        Array.isArray(
                            resolve.tracks
                        ) &&
                        resolve.tracks.length >
                            0
                    ) {

                        const track =
                            resolve.tracks[0];

                        if (!track?.info) {
                            continue;
                        }

                        track.info.requester =
                            interaction.user.username;

                        player.queue.add(
                            track
                        );

                        if (
                            track.info.uri
                        ) {

                            requesters.set(
                                track.info.uri,
                                interaction.user.username
                            );
                        }

                        queuedTracks++;
                    }

                } catch (error) {

                    console.error(
                        `[PLAY] Failed to resolve "${trackQuery}":`,
                        error?.message ||
                        error
                    );
                }
            }

            if (
                tracksToQueue.length >
                maxTracks
            ) {

                console.warn(
                    `[PLAY] Playlist truncated. ` +
                    `${tracksToQueue.length} requested, ` +
                    `${maxTracks} queued.`
                );
            }

            /* =================================================
               IMPORTANT:
               START PLAYBACK
            ================================================= */

            console.log(
                `[PLAY] Queue length: ${player.queue?.length || 0}`
            );

            console.log(
                `[PLAY] Player state:`,
                {
                    playing:
                        player.playing,

                    paused:
                        player.paused,

                    current:
                        Boolean(
                            player.current
                        ),

                    destroyed:
                        player.destroyed,

                    voiceChannel:
                        player.voiceChannel
                }
            );

            /*
             * Give Riffy a tiny amount of time to finish
             * creating the voice connection.
             *
             * We DO NOT check player.connected.
             */

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        250
                    )
            );

            await startPlayer(
                player
            );

            /* =================================================
               SUCCESS MESSAGE
            ================================================= */

            const successTitle =
                isPlaylist
                    ? t.success.titlePlaylist
                    : t.success.titleTrack;

            const titleIcon =
                isPlaylist
                    ? (
                        getEmoji(
                            "playlist"
                        ) ||
                        "📚"
                    )
                    : (
                        getEmoji(
                            "music"
                        ) ||
                        "🎵"
                    );

            const addedIcon =
                isPlaylist
                    ? (
                        getEmoji(
                            "playlist"
                        ) ||
                        "📚"
                    )
                    : (
                        getEmoji(
                            "success"
                        ) ||
                        "✅"
                    );

            const statusIcon =
                player.playing
                    ? (
                        getEmoji(
                            "play"
                        ) ||
                        "▶️"
                    )
                    : (
                        getEmoji(
                            "pause"
                        ) ||
                        "⏸️"
                    );

            const statusText =
                stripLeadingIcons(
                    player.playing
                        ? t.success.nowPlaying
                        : t.success.queueReady
                );

            const successContainer =
                buildPaleCard(
                    `${titleIcon} ${sanitizeTitle(
                        successTitle,
                        "Play"
                    )}`,

                    [
                        `### ${addedIcon} Added\n` +
                        (
                            isPlaylist
                                ? t.success.playlistAdded
                                    .replace(
                                        "{count}",
                                        queuedTracks
                                    )
                                : t.success.trackAdded
                        ),

                        `### ${statusIcon} Status\n` +
                        statusText
                    ]
                );

            const message =
                await interaction.editReply({
                    components: [
                        successContainer
                    ],

                    flags:
                        MessageFlags.IsComponentsV2,

                    fetchReply: true
                });

            /* =================================================
               DELETE TEMPORARY MESSAGE
            ================================================= */

            setTimeout(() => {

                message
                    .delete()
                    .catch(() => {});

            }, 3000);

        } catch (error) {

            console.error(
                "[PLAY COMMAND ERROR]",
                error
            );

            const lang =
                await getLang(
                    interaction.guildId
                ).catch(
                    () => ({
                        music: {
                            play: {
                                errors: {}
                            }
                        }
                    })
                );

            const t =
                lang.music?.play?.errors ||
                {};

            return handleCommandError(
                interaction,
                error,
                "play",

                (
                    t.title ||
                    "## ❌ Error"
                ) +

                "\n\n" +

                (
                    t.message ||
                    "An error occurred while processing the request.\nPlease try again later."
                )
            );
        }
    },

    requesters
};
