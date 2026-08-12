const { Riffy, Player } = require("riffy");

const {
    ContainerBuilder,
    SectionBuilder,
    ThumbnailBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    PermissionsBitField,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder
} = require("discord.js");

const { requesters } = require("./commands/music/play");
const { EnhancedMusicCard } = require("./utils/musicCard");
const config = require("./config.js");
const { getEmoji, getButtonEmoji } = require("./UI/emojis/emoji");
const colors = require("./UI/colors/colors");
const axios = require("axios");

const {
    autoplayCollection,
    playlistCollection
} = require("./mongodb.js");

const {
    initializeLavalinkManager,
    getLavalinkManager
} = require("./lavalink.js");

const {
    cardFromMessage,
    safeDeferUpdate
} = require("./utils/responseHandler.js");


/* ============================================================
   LANGUAGE
============================================================ */

let getLangSync;
let getLang;

try {
    const langLoader = require("./utils/languageLoader.js");

    getLangSync = langLoader.getLangSync;
    getLang = langLoader.getLang;

} catch (e) {

    getLangSync = () => ({
        console: {}
    });

    getLang = async () => ({
        player: {}
    });
}


/* ============================================================
   GLOBAL STATE
============================================================ */

const guildTrackMessages = new Map();
const nowPlayingMessages = new Map();
const progressUpdateIntervals = new Map();

const guildActiveFilter = new Map();
const guildTrackMediaCache = new Map();

const finishedTrackInfo = new Map();

const musicCard = new EnhancedMusicCard();

const useGeneratedSongCard =
    config.generateSongCard !== false;

const enableVoiceChannelIdPatch =
    config.enableVoiceChannelIdPatch === true;

const voiceDebug =
    config.voiceDebug === true;
/* ============================================================
   COMMAND MENTION CACHE
============================================================ */

const COMMAND_MENTION_CACHE_TTL_MS =
    5 * 60 * 1000;

let commandMentionCache = {
    expiresAt: 0,
    map: new Map()
};


async function getCommandMentionMap(client) {

    const now = Date.now();

    if (
        commandMentionCache.expiresAt > now &&
        commandMentionCache.map.size
    ) {
        return commandMentionCache.map;
    }

    const map = new Map();

    try {

        const fetched =
            await client.application.commands.fetch();

        fetched.forEach((cmd) => {

            if (cmd?.name && cmd?.id) {
                map.set(cmd.name, cmd.id);
            }

        });

    } catch (_) {
        // Fallback to normal slash command text
    }

    commandMentionCache = {
        expiresAt: now + COMMAND_MENTION_CACHE_TTL_MS,
        map
    };

    return map;
}


function getCommandRef(name, mentionMap) {

    const id = mentionMap?.get?.(name);

    return id
        ? `</${name}:${id}>`
        : `/${name}`;
}


function buildRandomTryHint(mentionMap) {

    const searchIcon =
        getEmoji("search") || "🔎";

    const pool = [
        "play",
        "queue",
        "search",
        "history",
        "filters",
        "trackinfo",
        "stats",
        "support"
    ];

    const picks = [];

    const shuffled =
        [...pool].sort(() => Math.random() - 0.5);

    for (const cmd of shuffled) {

        if (picks.length >= 3) {
            break;
        }

        picks.push(cmd);
    }

    const refs = [
        getCommandRef("help", mentionMap),
        ...picks.map(cmd =>
            getCommandRef(cmd, mentionMap)
        )
    ];

    return `${searchIcon} Try: ${refs.join(" • ")}`;
}


/* ============================================================
   CONSTANTS
============================================================ */

const PLAYER_FAVORITES_NAME =
    "AutoFavourites";

const LEGACY_PLAYER_FAVORITES_NAME =
    "**FAVORITES**";


const PLAYER_FILTER_OPTIONS = [

    {
        label: "Karaoke",
        value: "karaoke"
    },

    {
        label: "Timescale",
        value: "timescale"
    },

    {
        label: "Tremolo",
        value: "tremolo"
    },

    {
        label: "Vibrato",
        value: "vibrato"
    },

    {
        label: "3D",
        value: "rotation"
    },

    {
        label: "Distortion",
        value: "distortion"
    },

    {
        label: "Channel Mix",
        value: "channelmix"
    },

    {
        label: "Low Pass",
        value: "lowpass"
    },

    {
        label: "Bassboost",
        value: "bassboost"
    },

    {
        label: "Nightcore",
        value: "nightcore"
    },

    {
        label: "Daycore",
        value: "daycore"
    }

];


/* ============================================================
   MODALS
============================================================ */

function createAddSongModal() {

    const modal =
        new ModalBuilder()
            .setCustomId("player_modal_addsong")
            .setTitle("Add Song to Queue");

    const input =
        new TextInputBuilder()
            .setCustomId("query")
            .setLabel("Song Name or URL")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(
                "e.g. Adele Skyfall or https://..."
            )
            .setRequired(true)
            .setMaxLength(200);

    modal.addComponents(
        new ActionRowBuilder().addComponents(input)
    );

    return modal;
}


function createVolumeModal(currentVolume = 100) {

    const modal =
        new ModalBuilder()
            .setCustomId("player_modal_volume")
            .setTitle("Set Volume");

    const input =
        new TextInputBuilder()
            .setCustomId("volume")
            .setLabel("Volume (1-100)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(
                String(
                    Math.min(
                        100,
                        Math.max(
                            1,
                            currentVolume || 100
                        )
                    )
                )
            )
            .setRequired(true)
            .setMaxLength(3);

    modal.addComponents(
        new ActionRowBuilder().addComponents(input)
    );

    return modal;
}


function createSaveSongModal() {

    const modal =
        new ModalBuilder()
            .setCustomId("player_modal_save_song")
            .setTitle("Save Song to Playlist");

    const input =
        new TextInputBuilder()
            .setCustomId("playlistName")
            .setLabel("Playlist Name")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("My Favorites")
            .setRequired(true)
            .setMaxLength(80);

    modal.addComponents(
        new ActionRowBuilder().addComponents(input)
    );

    return modal;
}


/* ============================================================
   VOICE PATCH
============================================================ */

function patchVoiceChannelIdSupport(player) {

    const connection = player?.connection;

    if (
        !connection ||
        connection.__voiceChannelIdPatchApplied
    ) {
        return;
    }

    connection.__voiceChannelIdPatchApplied = true;

    connection.voice =
        connection.voice || {};

    if (
        !connection.voice.channelId &&
        player.voiceChannel
    ) {
        connection.voice.channelId =
            player.voiceChannel;
    }

    if (
        typeof connection.setStateUpdate ===
        "function"
    ) {

        const originalSetStateUpdate =
            connection.setStateUpdate.bind(connection);

        connection.setStateUpdate = (data) => {

            originalSetStateUpdate(data);

            const channelId =
                data?.channel_id ||
                connection.voiceChannel ||
                player.voiceChannel ||
                null;

            if (channelId) {
                connection.voice.channelId =
                    channelId;
            }

            if (voiceDebug) {

                console.log(
                    `[ VOICE DEBUG ] stateUpdate ` +
                    `guild=${player.guildId} ` +
                    `channelId=${channelId || "null"} ` +
                    `sessionId=${data?.session_id ? "yes" : "no"}`
                );
            }
        };
    }

    if (
        typeof connection.updatePlayerVoiceData ===
        "function"
    ) {

        const originalUpdatePlayerVoiceData =
            connection.updatePlayerVoiceData.bind(
                connection
            );

        connection.updatePlayerVoiceData = () => {

            if (!connection.voice.channelId) {

                connection.voice.channelId =
                    connection.voiceChannel ||
                    player.voiceChannel ||
                    null;
            }

            if (voiceDebug) {

                const v =
                    connection.voice || {};

                console.log(
                    `[ VOICE DEBUG ] updatePlayerVoiceData ` +
                    `guild=${player.guildId} ` +
                    `channelId=${v.channelId || "null"} ` +
                    `sessionId=${v.sessionId ? "yes" : "no"} ` +
                    `token=${v.token ? "yes" : "no"} ` +
                    `endpoint=${v.endpoint ? "yes" : "no"}`
                );
            }

            originalUpdatePlayerVoiceData();
        };
    }
}


/* ============================================================
   MEDIA CACHE
============================================================ */

function setTrackMediaCache(
    guildId,
    trackUri,
    mediaUrl = null,
    cardBuffer = null
) {

    if (!guildId || !trackUri) {
        return;
    }

    guildTrackMediaCache.set(
        guildId,
        {
            trackUri,
            mediaUrl,
            cardBuffer
        }
    );
}


function getTrackMediaCache(
    guildId,
    trackUri
) {

    const cached =
        guildTrackMediaCache.get(guildId);

    if (
        !cached ||
        cached.trackUri !== trackUri
    ) {
        return null;
    }

    return cached;
}


function clearTrackMediaCache(guildId) {

    guildTrackMediaCache.delete(guildId);
}


/* ============================================================
   PROGRESS
============================================================ */

function clearProgressUpdates(guildId) {

    const intervalId =
        progressUpdateIntervals.get(guildId);

    if (intervalId) {

        clearInterval(intervalId);

        progressUpdateIntervals.delete(
            guildId
        );
    }
}


/* ============================================================
   NOW PLAYING CONTAINER
   THIS IS THE NEW UI
============================================================ */

function buildNowPlayingContainer(
    track,
    requesterName,
    t,
    progressBar,
    progressPercent,
    mediaUrl,
    actionRows = {},
    playerState = {}
) {

    const title =
        track.info?.title ||
        "Unknown Title";

    const author =
        track.info?.author ||
        "Unknown Artist";

    const duration =
        formatDuration(
            track.info?.length || 0
        );

    const requester =
        requesterName ||
        t.trackInfo?.unknown ||
        "Unknown";

    const volume =
        playerState.volume ?? 100;

    const queueLength =
        playerState.queueLength || 0;


    /*
     * Make title clickable
     */
    const titleLine =
        track.info?.uri
            ? `[${title}](${track.info.uri})`
            : title;


    const container =
        new ContainerBuilder();


    /*
     * ========================================================
     * TOP SECTION
     * Song title + artist + thumbnail
     * ========================================================
     */

    if (mediaUrl) {

        const section =
            new SectionBuilder()
                .addTextDisplayComponents(
                    text =>
                        text.setContent(
                            `### ${titleLine}\n` +
                            `${author}`
                        )
                )
                .setThumbnailAccessory(
                    new ThumbnailBuilder()
                        .setURL(mediaUrl)
                        .setDescription(
                            `${title} - ${author}`
                        )
                );

        container.addSectionComponents(
            section
        );

    } else {

        container.addTextDisplayComponents(
            text =>
                text.setContent(
                    `### ${titleLine}\n` +
                    `${author}`
                )
        );
    }


    /*
     * ========================================================
     * REQUESTER / DURATION
     * ========================================================
     */

    container.addTextDisplayComponents(
        text =>
            text.setContent(
                `**${requester}** — **${duration}**`
            )
    );


    /*
     * ========================================================
     * VOLUME / QUEUE / TOTAL
     * ========================================================
     */

    container.addTextDisplayComponents(
        text =>
            text.setContent(
                `🔊 **Volume: ${volume}%**` +
                ` — ` +
                `📄 **Queue: ${queueLength} songs**` +
                ` — ` +
                `⏱️ **Total: ${duration}**`
            )
    );


    /*
     * ========================================================
     * PROGRESS BAR
     * ========================================================
     */

    if (progressBar) {

        container.addTextDisplayComponents(
            text =>
                text.setContent(
                    progressBar
                )
        );
    }


    /*
     * ========================================================
     * MAIN CONTROL ROW
     * ========================================================
     */

    if (actionRows?.playbackRow) {

        container.addActionRowComponents(
            actionRows.playbackRow
        );
    }


    return container;
}


/* ============================================================
   SEND MESSAGE WITH PERMISSION CHECK
============================================================ */

async function sendMessageWithPermissionsCheck(
    channel,
    components,
    attachment
) {

    try {

        const permissions =
            channel.permissionsFor(
                channel.guild.members.me
            );

        if (
            !permissions.has(
                PermissionsBitField.Flags.SendMessages
            ) ||
            !permissions.has(
                PermissionsBitField.Flags.EmbedLinks
            )
        ) {

            const lang =
                getLangSync();

            console.error(
                lang.console?.player?.lacksPermissions ||
                "Bot lacks necessary permissions to send messages in this channel."
            );

            return;
        }


        let safeComponents =
            components;

        let safeAttachment =
            attachment;


        /*
         * If Attach Files permission is missing,
         * don't use generated attachment.
         */

        if (
            safeAttachment &&
            !permissions.has(
                PermissionsBitField.Flags.AttachFiles
            )
        ) {

            safeAttachment = null;
        }


        const messageOptions = {

            components:
                safeComponents,

            flags:
                MessageFlags.IsComponentsV2
        };


        if (safeAttachment) {

            messageOptions.files = [
                safeAttachment
            ];
        }


        try {

            return await channel.send(
                messageOptions
            );

        } catch (sendError) {

            /*
             * Retry without attachment
             */

            const fallbackOptions = {

                components:
                    safeComponents,

                flags:
                    MessageFlags.IsComponentsV2
            };

            return await channel.send(
                fallbackOptions
            );
        }

    } catch (error) {

        const langSync =
            getLangSync();

        console.error(
            langSync.console?.player?.errorSendingMessage ||
            "Error sending message:",
            error.message
        );

        const errorContainer =
            cardFromMessage(
                "## ⚠️ Unable to Send Message\n\n" +
                "Unable to send the player message. " +
                "Please check bot permissions.",
                "Unable to Send Message"
            );

        await channel.send({
            components: [
                errorContainer
            ],
            flags:
                MessageFlags.IsComponentsV2
        }).catch(() => {});
    }
}


/* ============================================================
   TRANSIENT MESSAGE
============================================================ */

async function sendTransientCard(
    channel,
    message,
    deleteMs = 5000,
    fallbackTitle = "Notice"
) {

    const container =
        cardFromMessage(
            message,
            fallbackTitle
        );

    const sent =
        await channel.send({

            components: [
                container
            ],

            flags:
                MessageFlags.IsComponentsV2
        });

    setTimeout(
        () =>
            sent.delete().catch(() => {}),
        deleteMs
    );

    return sent;
}


/* ============================================================
   INITIALIZE PLAYER
============================================================ */

async function initializePlayer(client) {

    const nodeManager =
        await initializeLavalinkManager(client);

    client.riffy =
        nodeManager.riffy;

    client.lavalinkManager =
        nodeManager;

    client.nodeManager =
        nodeManager;


    /* ========================================================
       PLAYER CREATE
    ======================================================== */

    client.riffy.on(
        "playerCreate",
        (player) => {

            if (enableVoiceChannelIdPatch) {

                patchVoiceChannelIdSupport(
                    player
                );
            }

            if (voiceDebug) {

                console.log(
                    `[ VOICE DEBUG ] playerCreate ` +
                    `guild=${player.guildId} ` +
                    `voiceChannel=${player.voiceChannel || "null"} ` +
                    `patch=${enableVoiceChannelIdPatch ? "on" : "off"}`
                );
            }
        }
    );


    /* ========================================================
       TRACK EXCEPTION
    ======================================================== */

    client.riffy.on(
        "trackException",
        async (player, error) => {

            const langSync =
                getLangSync();

            const errorMsg =
                error?.message ||
                "Unknown error";

            const isTimeout =
                errorMsg.includes("timeout") ||
                errorMsg.includes("Read timed out") ||
                errorMsg.includes(
                    "SocketTimeoutException"
                );


            if (isTimeout) {

                console.warn(
                    `${colors.cyan}[ LAVALINK ]${colors.reset} ` +
                    `${colors.yellow}` +
                    `Track timeout for guild ` +
                    `${player?.guildId || "unknown"}: ` +
                    `${errorMsg}` +
                    `${colors.reset}`
                );

            } else {

                console.error(
                    `${colors.cyan}[ LAVALINK ]${colors.reset} ` +
                    `${colors.red}` +
                    `${errorMsg}` +
                    `${colors.reset}`
                );
            }


            const channel =
                client.channels.cache.get(
                    player?.textChannel
                );


            if (channel) {

                const lang =
                    await getLang(
                        player.guildId
                    ).catch(
                        () => ({
                            console: {
                                player: {}
                            }
                        })
                    );

                const t =
                    lang.console?.player ||
                    {};


                let errorMessage =
                    t.trackError?.message ||
                    "Failed to load the track.";


                if (isTimeout) {

                    errorMessage =
                        t.trackError?.timeoutMessage ||
                        "Connection timeout while loading track. This is usually a network issue on the Lavalink server.";
                }


                const trackErrorCard =
                    cardFromMessage(
                        `## ⚠️ Track Error\n\n` +
                        `${errorMessage}\n` +
                        `Skipping to next song...`,
                        "Track Error"
                    );


                channel.send({

                    components: [
                        trackErrorCard
                    ],

                    flags:
                        MessageFlags.IsComponentsV2

                }).catch(() => {})
                .then(msg => {

                    if (msg) {

                        setTimeout(
                            () =>
                                msg.delete()
                                    .catch(() => {}),
                            5000
                        );
                    }
                });
            }


            if (
                player &&
                !player.destroyed
            ) {

                try {

                    player.stop();

                } catch (_) {}
            }
        }
    );


    /* ========================================================
       TRACK STUCK
    ======================================================== */

    client.riffy.on(
        "trackStuck",
        (player, error) => {

            const errorMsg =
                error?.message ||
                "Unknown error";


            if (
                errorMsg.includes(
                    "Connect Timeout"
                ) ||
                errorMsg.includes(
                    "fetch failed"
                ) ||
                errorMsg.includes(
                    "timeout"
                )
            ) {

                console.warn(
                    `${colors.cyan}[ LAVALINK ]${colors.reset} ` +
                    `${colors.yellow}` +
                    `Track stuck because of connection timeout ` +
                    `guild=${player?.guildId || "unknown"}` +
                    `${colors.reset}`
                );

            } else {

                console.error(
                    `${colors.cyan}[ LAVALINK ]${colors.reset} ` +
                    `${colors.red}` +
                    `Track stuck: ${errorMsg}` +
                    `${colors.reset}`
                );
            }


            if (
                player &&
                !player.destroyed
            ) {

                try {

                    player.stop();

                } catch (_) {}
            }
        }
    );


   /* ========================================================
   TRACK START
======================================================== */

client.riffy.on(
    "trackStart",
    async (player, track) => {

        if (
            !track ||
            !track.info
        ) {

            console.error(
                `[ LAVALINK ] Track is null or missing info`
            );

            return;
        }


        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    200
                )
        );


        const currentPlayer =
            client.riffy.players.get(
                player.guildId
            );


        if (
            !currentPlayer ||
            currentPlayer !== player ||
            player.destroyed
        ) {

            console.error(
                `[ LAVALINK ] Player invalid for guild ${player.guildId}`
            );

            return;
        }


        if (
            client.statusManager &&
            track.info.title
        ) {

            await client.statusManager
                .onTrackStart(
                    player.guildId
                )
                .catch(() => {});
        }


        const channel =
            client.channels.cache.get(
                player.textChannel
            );


        if (!channel) {

            console.error(
                `[ LAVALINK ] Channel not found for guild ${player.guildId}`
            );

            return;
        }


        const guildId =
            player.guildId;


        /* =========================================================
           STORE CURRENT TRACK FOR TRACK END
        ========================================================= */

        finishedTrackInfo.set(
            guildId,
            track
        );


        const trackUri =
            track.info.uri;


        const requester =
            requesters.get(trackUri);


        const lang =
            await getLang(guildId)
                .catch(() =>
                    getLangSync()
                );


        const t =
            lang.console?.player ||
            {};


            /* =================================================
               SAVE HISTORY
            ================================================= */

            try {

                await playlistCollection.updateOne(

                    {
                        guildId,
                        name: "__HISTORY__"
                    },

                    {
                        $push: {
                            songs: {
                                $each: [
                                    trackUri
                                ],
                                $slice: -100
                            }
                        }
                    },

                    {
                        upsert: true
                    }
                );

            } catch (error) {

                console.error(
                    "Error saving history:",
                    error
                );
            }


   /* =================================================
      KEEP PREVIOUS NOW PLAYING MESSAGE
   ================================================= */

// Do not delete the previous player message.


            /* =================================================
               THUMBNAIL
            ================================================= */

            let thumbnailURL =
                track.info.thumbnail || null;


            /*
             * Try extracting YouTube thumbnail
             * from URI when Riffy doesn't provide it.
             */

            if (
                !thumbnailURL &&
                trackUri
            ) {

                const youtubeMatch =
                    trackUri.match(
                        /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?/]+)/i
                    );

                if (youtubeMatch?.[1]) {

                    thumbnailURL =
                        `https://img.youtube.com/vi/${youtubeMatch[1]}/hqdefault.jpg`;
                }
            }


            /* =================================================
               FALLBACK CARD
            ================================================= */

            let attachment = null;
            let cardBufferForCache = null;


            /*
             * We still generate the card if your config
             * has it enabled, but it is now used only
             * as the thumbnail instead of a giant gallery.
             */

            if (
                useGeneratedSongCard &&
                !thumbnailURL
            ) {

                try {

                    const cardBuffer =
                        await musicCard.generateCard({

                            thumbnailURL:
                                track.info.thumbnail ||
                                trackUri,

                            trackURI:
                                trackUri,

                            songTitle:
                                track.info.title,

                            songArtist:
                                track.info.author ||
                                "Unknown Artist",

                            trackRequester:
                                requester,

                            isPlaying:
                                true,

                            showVisualizer:
                                config.showVisualizer !== false,

                            currentPositionMs:
                                0,

                            totalDurationMs:
                                track.info.length ||
                                0
                        });


                    if (
                        cardBuffer &&
                        cardBuffer.length > 0
                    ) {

                        cardBufferForCache =
                            cardBuffer;

                        attachment =
                            new AttachmentBuilder(
                                cardBuffer,
                                {
                                    name:
                                        "song-banner.png"
                                }
                            );
                    }

                } catch (error) {

                    console.warn(
                        `[ PLAYER ] Music card failed: ${error.message}`
                    );
                }
            }


            /* =================================================
               ACTION BUTTONS
            ================================================= */

            const actionRows =
                buildPlayerActionRows(
                    player.paused,
                    player.loop,
                    guildActiveFilter.get(
                        guildId
                    ) || null
                );


            /* =================================================
               BUILD NOW PLAYING
            ================================================= */

            const nowPlayingContainer =
                buildNowPlayingContainer(

                    track,

                    requester,

                    t,

                    config.showProgressBar !== false
                        ? createProgressBar(
                            0,
                            track.info.length
                        )
                        : null,

                    0,

                    thumbnailURL,

                    actionRows,

                    {
                        paused:
                            player.paused,

                        loop:
                            player.loop,

                        volume:
                            player.volume,

                        currentPosition:
                            0,

                        queueLength:
                            player.queue.length
                    }
                );


            const components = [
                nowPlayingContainer
            ];


            /* =================================================
               SEND
            ================================================= */

            const message =
                await sendMessageWithPermissionsCheck(

                    channel,

                    components,

                    null
                );


            if (!message) {

                console.error(
                    `[ PLAYER ] Failed to send now playing message`
                );

                return;
            }


            /*
             * Cache thumbnail
             */

            if (
                thumbnailURL ||
                cardBufferForCache
            ) {

                setTrackMediaCache(
                    guildId,
                    track.info.uri,
                    thumbnailURL,
                    cardBufferForCache
                );

            } else {

                clearTrackMediaCache(
                    guildId
                );
            }


            /* =================================================
               TRACK MESSAGE STORAGE
            ================================================= */

            if (
                !guildTrackMessages.has(
                    guildId
                )
            ) {

                guildTrackMessages.set(
                    guildId,
                    []
                );
            }


            guildTrackMessages
                .get(guildId)
                .push({

                    messageId:
                        message.id,

                    channelId:
                        channel.id,

                    type:
                        "track"
                });


            nowPlayingMessages.set(
                guildId,
                {

                    messageId:
                        message.id,

                    channelId:
                        channel.id,

                    player:
                        player,

                    trackUri:
                        track.info.uri
                }
            );


            /* =================================================
               PROGRESS
            ================================================= */

            const intervalId =
                startProgressUpdates(
                    client,
                    guildId,
                    message,
                    player,
                    track
                );


            if (intervalId) {

                progressUpdateIntervals.set(
                    guildId,
                    intervalId
                );
            }


            /* =================================================
               COLLECTOR
            ================================================= */

            setupCollector(
                client,
                player,
                channel,
                message
            );
        }
    );


  /* =====================================================
   TRACK END
===================================================== */

client.riffy.on(
    "trackEnd",
    async (
        player
    ) => {

        if (!player?.guildId) {
            return;
        }


        const guildId =
            player.guildId;


        /*
         * Get the track that was playing.
         */

        const finishedTrack =
            finishedTrackInfo.get(
                guildId
            );


        const title =
            finishedTrack?.info?.title ||
            "Unknown Title";


        /*
         * Stop progress updates.
         */

        clearProgressUpdates(
            guildId
        );


        clearTrackMediaCache(
            guildId
        );


        /*
         * Find the Discord channel.
         */

        const channel =
            client.channels.cache.get(
                player.textChannel
            );


        if (!channel) {
            return;
        }


        /*
         * SEND PERMANENT FINISHED MESSAGE
         */

        try {

            await channel.send({
                content:
                    `➕ Finished playing ${title}`
            });

            console.log(
                `[ LAVALINK ] Finished playing: ${title}`
            );

        } catch (error) {

            console.error(
                "Finished playing message error:",
                error
            );
        }


        /*
         * IMPORTANT:
         *
         * Do NOT delete the previous player message.
         *
         * cleanupTrackMessages() has also been changed
         * so it does not delete Discord messages.
         */


        const settings =
            await autoplayCollection
                .findOne({
                    guildId
                })
                .catch(
                    () => null
                );


        const hasNext =
            (
                player.queue?.length >
                0
            ) ||
            player.loop === "queue" ||
            player.loop === "track" ||
            Boolean(
                settings?.autoplay
            );


        if (!hasNext) {

            await cleanupTrackMessages(
                client,
                player
            );
        }

    }
);


    /* ========================================================
       QUEUE END
    ======================================================== */

    client.riffy.on(
        "queueEnd",
        async (player) => {

            const channel =
                client.channels.cache.get(
                    player.textChannel
                );

            const guildId =
                player.guildId;


            clearTrackMediaCache(
                guildId
            );


            try {

                const settings =
                    await autoplayCollection
                        .findOne({
                            guildId
                        });


                const is24_7 =
                    settings?.twentyfourseven;


                /* =============================================
                   AUTOPLAY
                ============================================= */

                if (settings?.autoplay) {

                    if (channel) {

                        await cleanupPreviousTrackMessages(
                            channel,
                            guildId
                        );
                    }


                    const nextTrack =
                        await player.autoplay(
                            player
                        );


                    if (!nextTrack) {

                        await cleanupTrackMessages(
                            client,
                            player
                        );


                        if (!is24_7) {

                            player.destroy();

                            if (channel) {

                                await sendTransientCard(

                                    channel,

                                    "⚠️ **No more tracks to autoplay. Disconnecting...**",

                                    5000,

                                    "Autoplay Ended"
                                );
                            }

                        } else {

                            if (channel) {

                                await sendTransientCard(

                                    channel,

                                    "🔄 **24/7 Mode: Bot will stay in voice channel. Queue is empty.**",

                                    5000,

                                    "Queue Empty"
                                );
                            }
                        }
                    }


                } else {

                    await cleanupTrackMessages(
                        client,
                        player
                    );


                    if (!is24_7) {

                        player.destroy();

                        if (channel) {

                            await sendTransientCard(

                                channel,

                                "🎶 **Queue has ended. Autoplay is disabled.**",

                                5000,

                                "Queue Ended"
                            );
                        }

                    } else {

                        if (channel) {

                            await sendTransientCard(

                                channel,

                                "🔄 **24/7 Mode: Bot will stay in voice channel. Queue is empty.**",

                                5000,

                                "Queue Empty"
                            );
                        }
                    }
                }

            } catch (error) {

                console.error(
                    "Error handling queue end:",
                    error
                );


                await cleanupTrackMessages(
                    client,
                    player
                );


                const settings =
                    await autoplayCollection
                        .findOne({
                            guildId
                        });


                if (
                    !settings?.twentyfourseven
                ) {

                    player.destroy();

                    if (channel) {

                        await sendTransientCard(

                            channel,

                            "👾 **Queue Empty! Disconnecting...**",

                            5000,

                            "Queue Empty"
                        );
                    }
                }
            }
        }
    );
}


/* ============================================================
   CLEANUP PREVIOUS TRACK
============================================================ */

async function cleanupPreviousTrackMessages(
    channel,
    guildId
) {

    /*
     * IMPORTANT:
     *
     * Do NOT delete the previous Now Playing message.
     *
     * This function is intentionally kept so existing calls
     * elsewhere in player.js do not break.
     */

    guildTrackMessages.set(
        guildId,
        []
    );
}

/* ============================================================
   CLEANUP ALL TRACK MESSAGES
============================================================ */

async function cleanupTrackMessages(
    client,
    player
) {

    const guildId =
        player.guildId;


    clearTrackMediaCache(
        guildId
    );

    clearProgressUpdates(
        guildId
    );


    /*
     * IMPORTANT:
     *
     * DO NOT DELETE DISCORD MESSAGES HERE.
     *
     * Previous Now Playing messages and
     * Finished Playing messages must remain
     * permanently in the channel.
     */


    guildTrackMessages.set(
        guildId,
        []
    );


    nowPlayingMessages.delete(
        guildId
    );
}

/* ============================================================
   FORMAT DURATION
============================================================ */

function formatDuration(ms) {

    const seconds =
        Math.floor(
            (ms / 1000) % 60
        );

    const minutes =
        Math.floor(
            (ms / (1000 * 60)) % 60
        );

    const hours =
        Math.floor(
            (ms / (1000 * 60 * 60)) % 24
        );


    return [

        hours > 0
            ? `${hours}h`
            : null,

        minutes > 0
            ? `${minutes}m`
            : null,

        `${seconds}s`

    ]
        .filter(Boolean)
        .join(" ");
}


/* ============================================================
   REFRESH NOW PLAYING
============================================================ */

async function refreshNowPlayingPanel(
    client,
    guildId
) {

    const stored =
        nowPlayingMessages.get(
            guildId
        );


    if (!stored) {
        return;
    }


    const player =
        client.riffy.players.get(
            guildId
        );


    if (
        !player ||
        player.destroyed ||
        !player.current
    ) {
        return;
    }


    const channel =
        client.channels.cache.get(
            stored.channelId
        );


    if (!channel) {
        return;
    }


    const msg =
        await channel.messages
            .fetch(
                stored.messageId
            )
            .catch(() => null);


    if (!msg) {
        return;
    }


    const track =
        player.current;


    const lang =
        await getLang(guildId)
            .catch(() => ({
                console: {
                    player: {}
                }
            }));


    const t =
        lang.console?.player ||
        {};


    const requester =
        requesters.get(
            track.info.uri
        ) ||
        "Unknown";


    /*
     * Get thumbnail
     */

    let mediaUrl =
        track.info.thumbnail ||
        null;


    /*
     * YouTube fallback
     */

    if (
        !mediaUrl &&
        track.info.uri
    ) {

        const match =
            track.info.uri.match(
                /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?/]+)/i
            );


        if (match?.[1]) {

            mediaUrl =
                `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg`;
        }
    }


    const progressBar =
        createProgressBar(
            player.position || 0,
            track.info.length || 1
        );


    const progress =
        Math.min(
            100,
            Math.round(
                (
                    (player.position || 0) /
                    (track.info.length || 1)
                ) * 100
            )
        );


    const actionRows =
        buildPlayerActionRows(
            player.paused,
            player.loop,
            guildActiveFilter.get(
                guildId
            ) || null
        );


    const container =
        buildNowPlayingContainer(

            track,

            requester,

            t,

            config.showProgressBar !== false
                ? progressBar
                : null,

            progress,

            mediaUrl,

            actionRows,

            {
                paused:
                    player.paused,

                loop:
                    player.loop,

                volume:
                    player.volume,

                currentPosition:
                    player.position || 0,

                queueLength:
                    player.queue.length
            }
        );


    await msg.edit({

        components: [
            container
        ],

        flags:
            MessageFlags.IsComponentsV2

    }).catch(() => {});
}


/* ============================================================
   COLLECTOR
============================================================ */

function setupCollector(
    client,
    player,
    channel,
    message
) {

    const filter =
        i => [

            "loopToggle",
            "skipTrack",
            "stopTrack",
            "togglePlayback",

            "volumeDown",
            "volumeUp",

            "player_favorite",
            "player_add_song",
            "player_volume",
            "player_save_song",

            "player_queue",
            "player_shuffle",

            "player_filter_select",
            "player_filter_clear"

        ].includes(
            i.customId
        );


    const collector =
        message.createMessageComponentCollector({

            filter,

            time:
                300000
        });


    collector.on(
        "collect",
        async i => {

            const member =
                i.member;


            const voiceChannel =
                member.voice.channel;


            const playerChannel =
                player.voiceChannel;


            if (
                !voiceChannel ||
                voiceChannel.id !==
                    playerChannel
            ) {

                const vcContainer =
                    cardFromMessage(

                        "## 🔒 Voice Channel Required\n\n" +
                        "You need to be in the same voice channel to use the controls!",

                        "Voice Channel Required"
                    );


                const sentMessage =
                    await channel.send({

                        components: [
                            vcContainer
                        ],

                        flags:
                            MessageFlags.IsComponentsV2

                    });


                setTimeout(
                    () =>
                        sentMessage
                            .delete()
                            .catch(() => {}),
                    config.embedTimeout * 1000
                );


                return;
            }


            /* =================================================
               ADD SONG
            ================================================= */

            if (
                i.customId ===
                "player_add_song"
            ) {

                await i
                    .showModal(
                        createAddSongModal()
                    )
                    .catch(() => {});


                const modal =
                    await i.awaitModalSubmit({

                        filter:
                            m =>
                                m.customId ===
                                    "player_modal_addsong" &&
                                m.user.id ===
                                    i.user.id,

                        time:
                            60000

                    }).catch(() => null);


                if (modal) {

                    await handlePlayerModalSubmit(
                        client,
                        modal,
                        player,
                        channel
                    );
                }


                return;
            }


            /* =================================================
               VOLUME MODAL
            ================================================= */

            if (
                i.customId ===
                "player_volume"
            ) {

                await i
                    .showModal(
                        createVolumeModal(
                            player.volume
                        )
                    )
                    .catch(() => {});


                const modal =
                    await i.awaitModalSubmit({

                        filter:
                            m =>
                                m.customId ===
                                    "player_modal_volume" &&
                                m.user.id ===
                                    i.user.id,

                        time:
                            60000

                    }).catch(() => null);


                if (modal) {

                    await handlePlayerModalSubmit(
                        client,
                        modal,
                        player,
                        channel
                    );
                }


                return;
            }


            /* =================================================
               SAVE SONG
            ================================================= */

            if (
                i.customId ===
                "player_save_song"
            ) {

                await i
                    .showModal(
                        createSaveSongModal()
                    )
                    .catch(() => {});


                const modal =
                    await i.awaitModalSubmit({

                        filter:
                            m =>
                                m.customId ===
                                    "player_modal_save_song" &&
                                m.user.id ===
                                    i.user.id,

                        time:
                            60000

                    }).catch(() => null);


                if (modal) {

                    await handlePlayerModalSubmit(
                        client,
                        modal,
                        player,
                        channel
                    );
                }


                return;
            }


            const deferred =
                await safeDeferUpdate(i);


            if (
                !deferred &&
                !i.deferred &&
                !i.replied
            ) {
                return;
            }


            await handleInteraction(
                client,
                i,
                player,
                channel
            );
        }
    );


    collector.on(
        "end",
        () => {}
    );


    return collector;
}


/* ============================================================
   HANDLE BUTTON INTERACTIONS
============================================================ */

async function handleInteraction(
    client,
    i,
    player,
    channel
) {

    const lang =
        await getLang(
            channel.guildId
        ).catch(() => ({
            console: {
                player: {}
            }
        }));


    const t =
        lang.console?.player ||
        {};


    switch (i.customId) {


        /* ====================================================
           LOOP
        ==================================================== */

        case "loopToggle":

            toggleLoop(
                player,
                channel,
                t
            );

            await refreshNowPlayingPanel(
                client,
                player.guildId
            );

            break;


        /* ====================================================
           SKIP
        ==================================================== */

        case "skipTrack": {

            const guildId =
                player.guildId;

            clearProgressUpdates(
                guildId
            );

            player.stop();

            await sendEmbed(
                channel,
                t.controls?.skip ||
                "⏭️ **Skipping to next song...**"
            );

            break;
        }


        /* ====================================================
           STOP
        ==================================================== */

        case "stopTrack":

            await cleanupTrackMessages(
                client,
                player
            );

            player.stop();

            player.destroy();

            await sendEmbed(
                channel,
                t.controls?.playbackStopped ||
                "⏹️ **Playback has been stopped!**"
            );

            break;


        /* ====================================================
           PAUSE / PLAY
        ==================================================== */

        case "togglePlayback":

            try {

                if (
                    !player ||
                    player.destroyed
                ) {

                    await sendEmbed(
                        channel,
                        "❌ **Player is not available!**"
                    );

                    return;
                }


                if (player.paused) {

                    player.pause(false);

                } else {

                    player.pause(true);
                }


                await refreshNowPlayingPanel(
                    client,
                    player.guildId
                );

            } catch (error) {

                console.warn(
                    `${colors.cyan}[ PLAYER ]${colors.reset} ` +
                    `${colors.yellow}` +
                    `Toggle playback error: ${error.message}` +
                    `${colors.reset}`
                );


                await sendEmbed(
                    channel,
                    "⚠️ **Failed to change playback state.**"
                );
            }

            break;


        /* ====================================================
           VOLUME DOWN
        ==================================================== */

        case "volumeDown":

            adjustVolume(
                player,
                channel,
                -10,
                t
            );

            await refreshNowPlayingPanel(
                client,
                player.guildId
            );

            break;


        /* ====================================================
           VOLUME UP
        ==================================================== */

        case "volumeUp":

            adjustVolume(
                player,
                channel,
                10,
                t
            );

            await refreshNowPlayingPanel(
                client,
                player.guildId
            );

            break;


        /* ====================================================
           FAVORITE
        ==================================================== */

        case "player_favorite": {

            try {

                const current =
                    player.current?.info;


                if (!current?.uri) {

                    await sendEmbed(
                        channel,
                        "❌ **No active song to favorite.**"
                    );

                    return;
                }


                const userId =
                    i.user.id;

                const serverId =
                    channel.guild.id;

                const serverName =
                    channel.guild.name;

                const playlistName =
                    PLAYER_FAVORITES_NAME;

                const legacyPlaylistName =
                    `${LEGACY_PLAYER_FAVORITES_NAME}_${userId}`;


                let existing =
                    await playlistCollection.findOne({

                        name:
                            playlistName,

                        userId,

                        serverId

                    });


                if (!existing) {

                    const legacy =
                        await playlistCollection.findOne({

                            name:
                                legacyPlaylistName,

                            userId,

                            serverId

                        });


                    if (legacy) {

                        await playlistCollection.updateOne(

                            {
                                _id:
                                    legacy._id
                            },

                            {
                                $set: {
                                    name:
                                        playlistName,

                                    isPrivate:
                                        true
                                }
                            }
                        );


                        existing =
                            await playlistCollection.findOne({

                                _id:
                                    legacy._id
                            });
                    }
                }


                if (!existing) {

                    await playlistCollection.insertOne({

                        name:
                            playlistName,

                        songs:
                            [],

                        isPrivate:
                            true,

                        userId,

                        serverId,

                        serverName
                    });
                }


                const songEntry = {
                    url:
                        current.uri
                };


                await playlistCollection.updateOne(

                    {
                        name:
                            playlistName,

                        userId,

                        serverId
                    },

                    {
                        $addToSet: {
                            songs:
                                songEntry
                        }
                    }
                );


                await sendEmbed(
                    channel,
                    "✅ **Added to Favorites.**"
                );

            } catch (error) {

                await sendEmbed(
                    channel,
                    "⚠️ **Failed to add favorite.**"
                );
            }

            break;
        }


        /* ====================================================
           FILTER SELECT
        ==================================================== */

        case "player_filter_select": {

            const selectedFilter =
                i.values?.[0];


            if (
                selectedFilter ===
                "__clear__"
            ) {

                player.filters
                    .clearFilters();

                guildActiveFilter.delete(
                    player.guildId
                );


                await refreshNowPlayingPanel(
                    client,
                    player.guildId
                );


                await sendEmbed(
                    channel,
                    "🧹 **Filters cleared.**"
                );

                break;
            }


            const applied =
                await applyFilterByKey(
                    player,
                    selectedFilter
                );


            if (!applied) {

                await sendEmbed(
                    channel,
                    "⚠️ **Invalid filter selection.**"
                );

                return;
            }


            guildActiveFilter.set(
                player.guildId,
                selectedFilter
            );


            await refreshNowPlayingPanel(
                client,
                player.guildId
            );


            await sendEmbed(
                channel,
                `🎛️ **Filter applied:** ${selectedFilter}`
            );

            break;
        }


        /* ====================================================
           CLEAR FILTER
        ==================================================== */

        case "player_filter_clear":

            player.filters
                .clearFilters();

            guildActiveFilter.delete(
                player.guildId
            );


            await refreshNowPlayingPanel(
                client,
                player.guildId
            );


            await sendEmbed(
                channel,
                "🧹 **Filters cleared.**"
            );

            break;


        /* ====================================================
           QUEUE
        ==================================================== */

        case "player_queue": {

            if (!player.queue.length) {

                await sendEmbed(
                    channel,
                    "📭 **Queue is empty.**"
                );

                return;
            }


            const preview =
                player.queue
                    .slice(0, 8)
                    .map(
                        (item, index) =>
                            `${index + 1}. ${item.info?.title || "Unknown title"}`
                    )
                    .join("\n");


            await sendEmbed(
                channel,
                `📄 **Upcoming Queue**\n\n${preview}`
            );

            break;
        }


        /* ====================================================
           SHUFFLE
        ==================================================== */

        case "player_shuffle": {

            if (
                player.queue.length < 2
            ) {

                await sendEmbed(
                    channel,
                    "🔀 **Need at least 2 songs in queue to shuffle.**"
                );

                return;
            }


            player.queue.shuffle();


            await refreshNowPlayingPanel(
                client,
                player.guildId
            );


            await sendEmbed(
                channel,
                "🔀 **Queue shuffled.**"
            );

            break;
        }
    }
}


/* ============================================================
   MODAL SUBMIT
============================================================ */

async function handlePlayerModalSubmit(
    client,
    modal,
    player,
    channel
) {

    await modal
        .deferReply({
            flags:
                MessageFlags.Ephemeral
        })
        .catch(() => {});


    try {


        /* ====================================================
           ADD SONG
        ==================================================== */

        if (
            modal.customId ===
            "player_modal_addsong"
        ) {

            const query =
                modal.fields
                    .getTextInputValue(
                        "query"
                    )
                    ?.trim();


            if (!query) {

                await modal.editReply({
                    content:
                        "❌ Please provide a valid song name or URL."
                });

                return;
            }


            const resolve =
                await client.riffy.resolve({

                    query,

                    requester:
                        modal.user.username

                });


            if (
                !resolve ||
                !Array.isArray(
                    resolve.tracks
                ) ||
                !resolve.tracks.length
            ) {

                await modal.editReply({

                    content:
                        "❌ No results found for that query."

                });

                return;
            }


            let added = 0;


            if (
                resolve.loadType ===
                "playlist"
            ) {

                for (
                    const track
                    of resolve.tracks
                ) {

                    if (!track?.info) {
                        continue;
                    }


                    track.info.requester =
                        modal.user.username;


                    player.queue.add(
                        track
                    );


                    requesters.set(
                        track.info.uri,
                        modal.user.username
                    );


                    added++;
                }

            } else {

                const track =
                    resolve.tracks[0];


                if (!track?.info) {

                    await modal.editReply({

                        content:
                            "❌ Unable to load this track."

                    });

                    return;
                }


                track.info.requester =
                    modal.user.username;


                player.queue.add(
                    track
                );


                requesters.set(
                    track.info.uri,
                    modal.user.username
                );


                added = 1;
            }


            if (
                !player.playing &&
                !player.paused &&
                !player.current
            ) {

                await player.play();
            }


            await refreshNowPlayingPanel(
                client,
                player.guildId
            );


            await modal.editReply({

                content:
                    `✅ Added ${added} track${added === 1 ? "" : "s"} to queue.`

            });

            return;
        }


        /* ====================================================
           VOLUME MODAL
        ==================================================== */

        if (
            modal.customId ===
            "player_modal_volume"
        ) {

            const raw =
                modal.fields
                    .getTextInputValue(
                        "volume"
                    )
                    ?.trim();


            const volume =
                Number.parseInt(
                    raw,
                    10
                );


            if (
                Number.isNaN(volume) ||
                volume < 1 ||
                volume > 100
            ) {

                await modal.editReply({

                    content:
                        "❌ Volume must be a number between 1 and 100."

                });

                return;
            }


            player.setVolume(
                volume
            );


            await refreshNowPlayingPanel(
                client,
                player.guildId
            );


            await modal.editReply({

                content:
                    `🔊 Volume set to ${volume}%.`

            });

            return;
        }


        /* ====================================================
           SAVE SONG
        ==================================================== */

        if (
            modal.customId ===
            "player_modal_save_song"
        ) {

            const current =
                player.current?.info;


            if (!current?.uri) {

                await modal.editReply({

                    content:
                        "❌ No active song to save."

                });

                return;
            }


            const rawPlaylistName =
                modal.fields
                    .getTextInputValue(
                        "playlistName"
                    )
                    ?.trim();


            const playlistName =
                rawPlaylistName?.slice(
                    0,
                    80
                );


            if (!playlistName) {

                await modal.editReply({

                    content:
                        "❌ Playlist name is required."

                });

                return;
            }


            const userId =
                modal.user.id;

            const serverId =
                channel.guild.id;

            const serverName =
                channel.guild.name;


            const existing =
                await playlistCollection.findOne({

                    name:
                        playlistName,

                    userId,

                    serverId

                });


            if (!existing) {

                await playlistCollection.insertOne({

                    name:
                        playlistName,

                    songs:
                        [],

                    isPrivate:
                        false,

                    userId,

                    serverId,

                    serverName
                });
            }


            await playlistCollection.updateOne(

                {
                    name:
                        playlistName,

                    userId,

                    serverId
                },

                {
                    $addToSet: {

                        songs: {
                            url:
                                current.uri
                        }
                    }
                }
            );


            await modal.editReply({

                content:
                    `💾 Saved current song to playlist: ${playlistName}`

            });
        }

    } catch (error) {

        console.error(
            "[ PLAYER MODAL ERROR ]",
            error
        );


        await modal.editReply({

            content:
                "⚠️ Failed to process modal action."

        }).catch(() => {});
    }
}


/* ============================================================
   SEND EMBED / TRANSIENT
============================================================ */

async function sendEmbed(
    channel,
    message
) {

    const container =
        cardFromMessage(
            message,
            "Player Update"
        );


    const sentMessage =
        await channel.send({

            components: [
                container
            ],

            flags:
                MessageFlags.IsComponentsV2

        });


    setTimeout(

        () =>
            sentMessage
                .delete()
                .catch(() => {}),

        config.embedTimeout * 1000

    );
}


/* ============================================================
   VOLUME
============================================================ */

async function adjustVolume(
    player,
    channel,
    amount,
    t = {}
) {

    const newVolume =
        Math.min(
            100,
            Math.max(
                10,
                player.volume + amount
            )
        );


    if (
        newVolume ===
        player.volume
    ) {

        await sendEmbed(

            channel,

            amount > 0

                ? (
                    t.controls?.volumeMax ||
                    "🔊 **Volume is already at maximum!**"
                )

                : (
                    t.controls?.volumeMin ||
                    "🔉 **Volume is already at minimum!**"
                )
        );

    } else {

        player.setVolume(
            newVolume
        );


        await sendEmbed(

            channel,

            (
                t.controls?.volumeChanged ||
                "🔊 **Volume changed to {volume}%!**"
            )
                .replace(
                    "{volume}",
                    newVolume
                )
        );
    }
}


/* ============================================================
   LOOP
============================================================ */

async function toggleLoop(
    player,
    channel,
    t = {}
) {

    const currentMode =
        player.loop || "none";


    const nextMode =
        currentMode === "none"
            ? "track"

            : currentMode === "track"
                ? "queue"

                : "none";


    player.setLoop(
        nextMode
    );


    if (
        nextMode === "track"
    ) {

        await sendEmbed(
            channel,
            t.controls?.trackLoopActivated ||
            "🔁 **Track loop is activated!**"
        );

    } else if (
        nextMode === "queue"
    ) {

        await sendEmbed(
            channel,
            t.controls?.queueLoopActivated ||
            "🔁 **Queue loop is activated!**"
        );

    } else {

        await sendEmbed(
            channel,
            t.controls?.loopDisabled ||
            "❌ **Loop is disabled!**"
        );
    }
}


async function disableLoop(
    player,
    channel,
    t = {}
) {

    player.setLoop(
        "none"
    );


    await sendEmbed(
        channel,
        t.controls?.loopDisabled ||
        "❌ **Loop is disabled!**"
    );
}


/* ============================================================
   LYRICS
============================================================ */

async function getLyrics(
    trackName,
    artistName,
    duration
) {

    try {

        trackName =
            trackName
                .replace(
                    /\b(Official|Audio|Video|Lyrics|Theme|Soundtrack|Music|Full Version|HD|4K|Visualizer|Radio Edit|Live|Remix|Mix|Extended|Cover|Parody|Performance|Version|Unplugged|Reupload)\b/gi,
                    ""
                )
                .replace(
                    /\s*[-_/|]\s*/g,
                    " "
                )
                .replace(
                    /\s+/g,
                    " "
                )
                .trim();


        artistName =
            artistName
                .replace(
                    /\b(Topic|VEVO|Records|Label|Productions|Entertainment|Ltd|Inc|Band|DJ|Composer|Performer)\b/gi,
                    ""
                )
                .replace(
                    / x /gi,
                    " & "
                )
                .replace(
                    /\s+/g,
                    " "
                )
                .trim();


        if (
            !trackName ||
            !artistName
        ) {
            return null;
        }


        let response =
            await axios.get(
                "https://lrclib.net/api/get",
                {

                    params: {
                        track_name:
                            trackName,

                        artist_name:
                            artistName,

                        duration
                    },

                    timeout:
                        5000
                }
            );


        if (
            response.data &&
            (
                response.data.syncedLyrics ||
                response.data.plainLyrics
            )
        ) {

            return (
                response.data.syncedLyrics ||
                response.data.plainLyrics
            );
        }


        response =
            await axios.get(
                "https://lrclib.net/api/get",
                {

                    params: {

                        track_name:
                            trackName,

                        artist_name:
                            artistName
                    },

                    timeout:
                        5000
                }
            );


        if (
            response.data &&
            (
                response.data.syncedLyrics ||
                response.data.plainLyrics
            )
        ) {

            return (
                response.data.syncedLyrics ||
                response.data.plainLyrics
            );
        }


        return null;

    } catch (error) {

        console.error(
            "Lyrics fetch error:",
            error.response?.data?.message ||
            error.message
        );

        return null;
    }
}


/* ============================================================
   SHOW LYRICS
============================================================ */

async function showLyrics(
    channel,
    player
) {

    const lang =
        await getLang(
            player.guildId
        ).catch(() => ({
            console: {
                player: {}
            }
        }));


    const t =
        lang.console?.player ||
        {};


    if (
        !player ||
        !player.current ||
        !player.current.info
    ) {

        await sendEmbed(
            channel,
            t.lyrics?.noSongPlaying ||
            "🚫 **No song is currently playing.**"
        );

        return;
    }


    const track =
        player.current.info;


    const lyrics =
        await getLyrics(

            track.title,

            track.author,

            Math.floor(
                track.length / 1000
            )
        );


    if (!lyrics) {

        await sendEmbed(
            channel,
            t.lyrics?.notFound ||
            "❌ **Lyrics not found!**"
        );

        return;
    }


    const lines =
        lyrics
            .split("\n")
            .map(
                line => line.trim()
            )
            .filter(Boolean);


    const songDuration =
        Math.floor(
            track.length / 1000
        );


    const lyricsContainer =
        new ContainerBuilder()
            .addTextDisplayComponents(

                text =>
                    text.setContent(

                        (
                            t.lyrics?.liveTitle ||
                            "## 🎵 Live Lyrics: {title}"
                        )
                            .replace(
                                "{title}",
                                track.title
                            ) +

                        "\n\n" +

                        (
                            t.lyrics?.syncing ||
                            "🔄 Syncing lyrics..."
                        )
                    )
            );


    const stopButton =
        new ButtonBuilder()
            .setCustomId(
                "stopLyrics"
            )
            .setLabel(
                t.lyrics?.stopButton ||
                "Stop Lyrics"
            )
            .setStyle(
                ButtonStyle.Danger
            );


    const fullButton =
        new ButtonBuilder()
            .setCustomId(
                "fullLyrics"
            )
            .setLabel(
                t.lyrics?.fullButton ||
                "Full Lyrics"
            )
            .setStyle(
                ButtonStyle.Primary
            );


    const row =
        new ActionRowBuilder()
            .addComponents(
                fullButton,
                stopButton
            );


    const message =
        await channel.send({

            components: [
                lyricsContainer,
                row
            ],

            flags:
                MessageFlags.IsComponentsV2

        });


    const guildId =
        player.guildId;


    if (
        !guildTrackMessages.has(
            guildId
        )
    ) {

        guildTrackMessages.set(
            guildId,
            []
        );
    }


    guildTrackMessages
        .get(guildId)
        .push({

            messageId:
                message.id,

            channelId:
                channel.id,

            type:
                "lyrics"
        });


    const updateLyrics =
        async () => {

            const currentTime =
                Math.floor(
                    player.position / 1000
                );


            const totalLines =
                lines.length;


            const linesPerSecond =
                totalLines /
                songDuration;


            const currentLineIndex =
                Math.floor(
                    currentTime *
                    linesPerSecond
                );


            const start =
                Math.max(
                    0,
                    currentLineIndex - 3
                );


            const end =
                Math.min(
                    totalLines,
                    currentLineIndex + 3
                );


            const visibleLines =
                lines
                    .slice(
                        start,
                        end
                    )
                    .join("\n");


            const updatedContainer =
                new ContainerBuilder()
                    .addTextDisplayComponents(

                        text =>
                            text.setContent(

                                (
                                    t.lyrics?.liveTitle ||
                                    "## 🎵 Live Lyrics: {title}"
                                )
                                    .replace(
                                        "{title}",
                                        track.title
                                    ) +

                                "\n\n" +

                                visibleLines
                            )
                    );


            await message.edit({

                components: [
                    updatedContainer,
                    row
                ],

                flags:
                    MessageFlags.IsComponentsV2

            }).catch(() => {});
        };


    const interval =
        setInterval(
            updateLyrics,
            3000
        );


    updateLyrics();


    const collector =
        message.createMessageComponentCollector({

            time:
                300000
        });


    collector.on(
        "collect",
        async i => {

            const deferred =
                await safeDeferUpdate(i);


            if (
                !deferred &&
                !i.deferred &&
                !i.replied
            ) {
                return;
            }


            if (
                i.customId ===
                "stopLyrics"
            ) {

                clearInterval(
                    interval
                );

                await message
                    .delete()
                    .catch(() => {});


            } else if (
                i.customId ===
                "fullLyrics"
            ) {

                clearInterval(
                    interval
                );


                const fullLyricsContainer =
                    new ContainerBuilder()
                        .addTextDisplayComponents(

                            text =>
                                text.setContent(

                                    (
                                        t.lyrics?.fullTitle ||
                                        "## 🎵 Full Lyrics: {title}"
                                    )
                                        .replace(
                                            "{title}",
                                            track.title
                                        ) +

                                    "\n\n" +

                                    lines.join("\n")
                                )
                        );


                const deleteButton =
                    new ButtonBuilder()
                        .setCustomId(
                            "deleteLyrics"
                        )
                        .setLabel(
                            t.lyrics?.deleteButton ||
                            "Delete"
                        )
                        .setStyle(
                            ButtonStyle.Danger
                        );


                const deleteRow =
                    new ActionRowBuilder()
                        .addComponents(
                            deleteButton
                        );


                await message.edit({

                    components: [
                        fullLyricsContainer,
                        deleteRow
                    ],

                    flags:
                        MessageFlags.IsComponentsV2

                });


            } else if (
                i.customId ===
                "deleteLyrics"
            ) {

                await message
                    .delete()
                    .catch(() => {});
            }
        }
    );


    collector.on(
        "end",
        () => {

            clearInterval(
                interval
            );

            message
                .delete()
                .catch(() => {});
        }
    );
}


/* ============================================================
   NEW PLAYBACK BUTTON ROW
============================================================ */

function createPlaybackActionRow(
    disabled,
    paused = false,
    loopMode = "none"
) {

    const playEmoji =
        getButtonEmoji("play") ||
        "▶️";


    const pauseEmoji =
        getButtonEmoji("pause") ||
        "⏸️";


    const skipEmoji =
        getButtonEmoji("next") ||
        "⏭️";


    const stopEmoji =
        getButtonEmoji("stop") ||
        "⏹️";


    const playbackEmoji =
        paused
            ? playEmoji
            : pauseEmoji;


    const playbackLabel =
        paused
            ? "Play"
            : "Pause";


    const playbackStyle =
        paused
            ? ButtonStyle.Success
            : ButtonStyle.Secondary;


    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId(
                    "togglePlayback"
                )
                .setEmoji(
                    playbackEmoji
                )
                .setLabel(
                    playbackLabel
                )
                .setStyle(
                    playbackStyle
                )
                .setDisabled(
                    disabled
                ),


            new ButtonBuilder()
                .setCustomId(
                    "skipTrack"
                )
                .setEmoji(
                    skipEmoji
                )
                .setLabel(
                    "Skip"
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
                .setDisabled(
                    disabled
                ),


            new ButtonBuilder()
                .setCustomId(
                    "volumeDown"
                )
                .setEmoji(
                    "🔉"
                )
                .setLabel(
                    "Vol−"
                )
                .setStyle(
                    ButtonStyle.Primary
                )
                .setDisabled(
                    disabled
                ),


            new ButtonBuilder()
                .setCustomId(
                    "volumeUp"
                )
                .setEmoji(
                    "🔊"
                )
                .setLabel(
                    "Vol+"
                )
                .setStyle(
                    ButtonStyle.Primary
                )
                .setDisabled(
                    disabled
                ),


            new ButtonBuilder()
                .setCustomId(
                    "stopTrack"
                )
                .setEmoji(
                    stopEmoji
                )
                .setLabel(
                    "Stop"
                )
                .setStyle(
                    ButtonStyle.Danger
                )
                .setDisabled(
                    disabled
                )
        );
}


/* ============================================================
   MANAGEMENT ROW
   KEPT FOR OTHER FEATURES
============================================================ */

function createManageSongActionRow(
    disabled
) {

    const favoriteEmoji =
        getButtonEmoji("welcome") ||
        "⭐";


    const addEmoji =
        getButtonEmoji("play") ||
        "➕";


    const queueEmoji =
        getButtonEmoji("queue") ||
        "📄";


    const saveEmoji =
        getButtonEmoji("folder") ||
        "💾";


    const shuffleEmoji =
        getButtonEmoji("servers") ||
        "🔀";


    return new ActionRowBuilder()
        .addComponents(

            new ButtonBuilder()
                .setCustomId(
                    "player_favorite"
                )
                .setEmoji(
                    favoriteEmoji
                )
                .setLabel(
                    "Favorite"
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
                .setDisabled(
                    disabled
                ),

            new ButtonBuilder()
                .setCustomId(
                    "player_add_song"
                )
                .setEmoji(
                    addEmoji
                )
                .setLabel(
                    "Add"
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
                .setDisabled(
                    disabled
                ),

            new ButtonBuilder()
                .setCustomId(
                    "player_queue"
                )
                .setEmoji(
                    queueEmoji
                )
                .setLabel(
                    "Queue"
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
                .setDisabled(
                    disabled
                ),

            new ButtonBuilder()
                .setCustomId(
                    "player_save_song"
                )
                .setEmoji(
                    saveEmoji
                )
                .setLabel(
                    "Save"
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
                .setDisabled(
                    disabled
                ),

            new ButtonBuilder()
                .setCustomId(
                    "player_shuffle"
                )
                .setEmoji(
                    shuffleEmoji
                )
                .setLabel(
                    "Shuffle"
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
                .setDisabled(
                    disabled
                )
        );
}


/* ============================================================
   FILTER ROW
============================================================ */

function createFilterRow(
    disabled,
    activeFilter = null
) {

    const select =
        new StringSelectMenuBuilder()
            .setCustomId(
                "player_filter_select"
            )
            .setPlaceholder(
                activeFilter
                    ? `Filter: ${activeFilter}`
                    : "Select audio filter"
            )
            .setDisabled(
                disabled
            )
            .addOptions(

                [

                    {
                        label:
                            "Clear Filters",

                        value:
                            "__clear__"
                    },

                    ...PLAYER_FILTER_OPTIONS

                ].map(
                    item => ({

                        label:
                            item.label,

                        value:
                            item.value,

                        default:
                            item.value ===
                            activeFilter
                    })
                )
            );


    return new ActionRowBuilder()
        .addComponents(
            select
        );
}


/* ============================================================
   PLAYER ACTION ROWS
   ONLY PLAYBACK ROW IS SHOWN IN NOW PLAYING
============================================================ */

function buildPlayerActionRows(
    paused,
    loopMode,
    activeFilter
) {

    return {

        playbackRow:
            createPlaybackActionRow(
                false,
                paused,
                loopMode
            )
    };
}


/* ============================================================
   FILTERS
============================================================ */

async function applyFilterByKey(
    player,
    selectedFilter
) {

    switch (selectedFilter) {

        case "karaoke":

            player.filters
                .setKaraoke(true);

            break;


        case "timescale":

            player.filters
                .setTimescale(
                    true,
                    {
                        speed:
                            1.2,

                        pitch:
                            1.2
                    }
                );

            break;


        case "tremolo":

            player.filters
                .setTremolo(
                    true,
                    {
                        frequency:
                            4,

                        depth:
                            0.75
                    }
                );

            break;


        case "vibrato":

            player.filters
                .setVibrato(
                    true,
                    {
                        frequency:
                            4,

                        depth:
                            0.75
                    }
                );

            break;


        case "rotation":

            player.filters
                .setRotation(
                    true,
                    {
                        rotationHz:
                            0.2
                    }
                );

            break;


        case "distortion":

            player.filters
                .setDistortion(
                    true,
                    {
                        sinScale:
                            1,

                        cosScale:
                            1
                    }
                );

            break;


        case "channelmix":

            player.filters
                .setChannelMix(
                    true,
                    {
                        leftToLeft:
                            0.5,

                        leftToRight:
                            0.5,

                        rightToLeft:
                            0.5,

                        rightToRight:
                            0.5
                    }
                );

            break;


        case "lowpass":

            player.filters
                .setLowPass(
                    true,
                    {
                        smoothing:
                            0.5
                    }
                );

            break;


        case "bassboost":

            player.filters
                .setBassboost(
                    true,
                    {
                        value:
                            3
                    }
                );

            break;


        case "nightcore":

            player.filters
                .setTimescale(
                    true,
                    {
                        speed:
                            1.25,

                        pitch:
                            1.25,

                        rate:
                            1.0
                    }
                );

            break;


        case "daycore":

            player.filters
                .setTimescale(
                    true,
                    {
                        speed:
                            1.0,

                        pitch:
                            0.8,

                        rate:
                            1.0
                    }
                );

            break;


        default:

            return false;
    }


    return true;
}


/* ============================================================
   PROGRESS BAR
============================================================ */

function createProgressBar(
    current,
    total,
    length = 20
) {

    if (!total || total <= 0) {

        return "`0s` ░░░░░░░░░░░░░░░░░░░░ `0s`";
    }


    const progress =
        Math.max(
            0,
            Math.min(
                length,
                Math.round(
                    (
                        current /
                        total
                    ) *
                    length
                )
            )
        );


    const emptyProgress =
        length -
        progress;


    const progressText =
        "▓".repeat(
            progress
        );


    const emptyProgressText =
        "░".repeat(
            emptyProgress
        );


    const currentTime =
        formatDuration(
            current
        );


    const totalTime =
        formatDuration(
            total
        );


    return (
        `\`${currentTime}\` ` +
        `${progressText}${emptyProgressText} ` +
        `\`${totalTime}\``
    );
}


/* ============================================================
   PROGRESS UPDATE LOOP
============================================================ */

async function startProgressUpdates(
    client,
    guildId,
    message,
    player,
    track
) {

    if (
        config.lowMemoryMode === true
    ) {

        return null;
    }


    const boundMessageId =
        message.id;

    const boundChannelId =
        message.channelId;

    const boundTrackUri =
        track.info.uri;


    const updateInterval =
        setInterval(
            async () => {

                try {

                    const currentPlayer =
                        client.riffy.players.get(
                            guildId
                        );


                    if (
                        !currentPlayer ||
                        currentPlayer !== player
                    ) {

                        clearInterval(
                            updateInterval
                        );

                        progressUpdateIntervals.delete(
                            guildId
                        );

                        return;
                    }


                    const stored =
                        nowPlayingMessages.get(
                            guildId
                        );


                    if (
                        !stored ||
                        stored.messageId !==
                            boundMessageId ||
                        stored.channelId !==
                            boundChannelId
                    ) {

                        clearInterval(
                            updateInterval
                        );

                        progressUpdateIntervals.delete(
                            guildId
                        );

                        return;
                    }


                    if (
                        !player ||
                        !player.current ||
                        player.current.info.uri !==
                            boundTrackUri
                    ) {

                        clearInterval(
                            updateInterval
                        );

                        progressUpdateIntervals.delete(
                            guildId
                        );

                        return;
                    }


                    const currentPosition =
                        player.position || 0;


                    const totalDuration =
                        track.info.length || 1;


                    const progress =
                        Math.min(
                            100,
                            Math.round(
                                (
                                    currentPosition /
                                    totalDuration
                                ) *
                                100
                            )
                        );


                    const progressBar =
                        createProgressBar(
                            currentPosition,
                            totalDuration
                        );


                    const lang =
                        await getLang(
                            guildId
                        ).catch(() => ({
                            console: {
                                player: {}
                            }
                        }));


                    const t =
                        lang.console?.player ||
                        {};


                    const requester =
                        requesters.get(
                            track.info.uri
                        ) ||
                        "Unknown";


                    const actionRows =
                        buildPlayerActionRows(
                            player.paused,
                            player.loop,
                            guildActiveFilter.get(
                                guildId
                            ) || null
                        );


                    const channel =
                        client.channels.cache.get(
                            stored.channelId
                        );


                    if (!channel) {
                        return;
                    }


                    const msg =
                        await channel.messages
                            .fetch(
                                stored.messageId
                            )
                            .catch(
                                () => null
                            );


                    if (!msg) {
                        return;
                    }


                    /*
                     * Get thumbnail again
                     */

                    let mediaUrl =
                        track.info.thumbnail ||
                        null;


                    if (
                        !mediaUrl &&
                        track.info.uri
                    ) {

                        const match =
                            track.info.uri.match(
                                /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?/]+)/i
                            );


                        if (match?.[1]) {

                            mediaUrl =
                                `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg`;
                        }
                    }


                    const nowPlayingContainer =
                        buildNowPlayingContainer(

                            track,

                            requester,

                            t,

                            config.showProgressBar !== false
                                ? progressBar
                                : null,

                            progress,

                            mediaUrl,

                            actionRows,

                            {
                                paused:
                                    player.paused,

                                loop:
                                    player.loop,

                                volume:
                                    player.volume,

                                currentPosition,

                                queueLength:
                                    player.queue.length
                            }
                        );


                    await msg.edit({

                        components: [
                            nowPlayingContainer
                        ],

                        flags:
                            MessageFlags.IsComponentsV2

                    }).catch(() => {});


                } catch (error) {

                    clearInterval(
                        updateInterval
                    );

                    progressUpdateIntervals.delete(
                        guildId
                    );
                }

            },

            /*
             * Update every 15 seconds.
             * Change to 5000 if you want smoother updates.
             */

            15000
        );


    return updateInterval;
}


/* ============================================================
   EXPORT
============================================================ */

module.exports = {
    initializePlayer,
    cleanupTrackMessages
};
