const { Riffy, Player } = require("riffy");
const {
    ContainerBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    PermissionsBitField,
    MessageFlags,
    MediaGalleryBuilder,
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

const { autoplayCollection, playlistCollection } = require("./mongodb.js");
const {
    initializeLavalinkManager,
    getLavalinkManager
} = require("./lavalink.js");

const {
    cardFromMessage,
    safeDeferUpdate
} = require("./utils/responseHandler.js");

let getLangSync, getLang;

try {
    const langLoader = require("./utils/languageLoader.js");
    getLangSync = langLoader.getLangSync;
    getLang = langLoader.getLang;
} catch (e) {
    getLangSync = () => ({ console: {} });
    getLang = async () => ({ player: {} });
}

const guildTrackMessages = new Map();
const nowPlayingMessages = new Map();
const progressUpdateIntervals = new Map();
const guildActiveFilter = new Map();

/*
 * IMPORTANT:
 * guildTrackMediaCache now stores ONLY the real Discord CDN URL.
 *
 * Do NOT store/use:
 * attachment://song-banner.png
 *
 * after the original message has been sent.
 */
const guildTrackMediaCache = new Map();

const musicCard = new EnhancedMusicCard();

const useGeneratedSongCard = config.generateSongCard !== false;
const enableVoiceChannelIdPatch =
    config.enableVoiceChannelIdPatch === true;

const voiceDebug = config.voiceDebug === true;

const COMMAND_MENTION_CACHE_TTL_MS = 5 * 60 * 1000;

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
        const fetched = await client.application.commands.fetch();

        fetched.forEach((cmd) => {
            if (cmd?.name && cmd?.id) {
                map.set(cmd.name, cmd.id);
            }
        });
    } catch (_) {
        // Fallback to plain /command text
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
    const searchIcon = getEmoji("search") || "🔎";

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

    const shuffled = [...pool].sort(
        () => Math.random() - 0.5
    );

    for (const cmd of shuffled) {
        if (picks.length >= 3) break;
        picks.push(cmd);
    }

    const refs = [
        getCommandRef("help", mentionMap),
        ...picks.map((cmd) =>
            getCommandRef(cmd, mentionMap)
        )
    ];

    return `${searchIcon} Try: ${refs.join(" • ")}`;
}

const PLAYER_FAVORITES_NAME = "AutoFavourites";
const LEGACY_PLAYER_FAVORITES_NAME = "**FAVORITES**";

const PLAYER_FILTER_OPTIONS = [
    { label: "Karaoke", value: "karaoke" },
    { label: "Timescale", value: "timescale" },
    { label: "Tremolo", value: "tremolo" },
    { label: "Vibrato", value: "vibrato" },
    { label: "3D", value: "rotation" },
    { label: "Distortion", value: "distortion" },
    { label: "Channel Mix", value: "channelmix" },
    { label: "Low Pass", value: "lowpass" },
    { label: "Bassboost", value: "bassboost" },
    { label: "Nightcore", value: "nightcore" },
    { label: "Daycore", value: "daycore" }
];

function createAddSongModal() {
    const modal = new ModalBuilder()
        .setCustomId("player_modal_addsong")
        .setTitle("Add Song to Queue");

    const input = new TextInputBuilder()
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
    const modal = new ModalBuilder()
        .setCustomId("player_modal_volume")
        .setTitle("Set Volume");

    const input = new TextInputBuilder()
        .setCustomId("volume")
        .setLabel("Volume (1-100)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(
            String(
                Math.min(
                    100,
                    Math.max(1, currentVolume || 100)
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
    const modal = new ModalBuilder()
        .setCustomId("player_modal_save_song")
        .setTitle("Save Song to Playlist");

    const input = new TextInputBuilder()
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

function patchVoiceChannelIdSupport(player) {
    const connection = player?.connection;

    if (
        !connection ||
        connection.__voiceChannelIdPatchApplied
    ) {
        return;
    }

    connection.__voiceChannelIdPatchApplied = true;
    connection.voice = connection.voice || {};

    if (
        !connection.voice.channelId &&
        player.voiceChannel
    ) {
        connection.voice.channelId =
            player.voiceChannel;
    }

    if (
        typeof connection.setStateUpdate === "function"
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
                connection.voice.channelId = channelId;
            }

            if (voiceDebug) {
                console.log(
                    `[ VOICE DEBUG ] stateUpdate guild=${player.guildId} channelId=${channelId || "null"} sessionId=${data?.session_id ? "yes" : "no"}`
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
                const v = connection.voice || {};

                console.log(
                    `[ VOICE DEBUG ] updatePlayerVoiceData guild=${player.guildId} channelId=${v.channelId || "null"} sessionId=${v.sessionId ? "yes" : "no"} token=${v.token ? "yes" : "no"} endpoint=${v.endpoint ? "yes" : "no"}`
                );
            }

            originalUpdatePlayerVoiceData();
        };
    }
}

function stripMediaGallery(components = []) {
    return components.filter(
        (component) =>
            !(component instanceof MediaGalleryBuilder)
    );
}

function formatSourceName(sourceName) {
    const raw = String(
        sourceName || "Unknown"
    ).toLowerCase();

    if (raw === "youtube") return "YouTube";
    if (raw === "soundcloud") return "SoundCloud";
    if (raw === "spotify") return "Spotify";
    if (raw === "applemusic") return "Apple Music";

    return (
        raw.charAt(0).toUpperCase() +
        raw.slice(1)
    );
}

/*
 * FIX:
 * Only save the actual Discord CDN media URL.
 */
function setTrackMediaCache(
    guildId,
    trackUri,
    mediaUrl = null
) {
    if (!guildId || !trackUri) return;

    if (
        !mediaUrl ||
        typeof mediaUrl !== "string" ||
        mediaUrl.startsWith("attachment://")
    ) {
        return;
    }

    guildTrackMediaCache.set(guildId, {
        trackUri,
        mediaUrl
    });
}

function getTrackMediaCache(guildId, trackUri) {
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

function clearProgressUpdates(guildId) {
    const intervalId =
        progressUpdateIntervals.get(guildId);

    if (intervalId) {
        clearInterval(intervalId);
        progressUpdateIntervals.delete(guildId);
    }
}

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
    const musicIcon =
        getEmoji("music") || "🎵";

    const titleIcon =
        getEmoji("music") || "🎧";

    const infoIcon =
        getEmoji("info") || "ℹ️";

    const timeIcon =
        getEmoji("uptime") || "⏱️";

    const queueIcon =
        getEmoji("queue") || "📄";

    const userIcon =
        getEmoji("users") || "👤";

    const sourceIcon =
        getEmoji("servers") || "🌐";

    const playIcon =
        getEmoji("play") || "▶️";

    const pauseIcon =
        getEmoji("pause") || "⏸️";

    const loopIcon =
        getEmoji("settings") || "🔁";

    const controlsIcon =
        getEmoji("settings") || "⚙️";

    const manageIcon =
        getEmoji("owner") || "👑";

    const filterIcon =
        getEmoji("servers") || "🌐";

    const byText =
        t.trackInfo?.by || "by";

    const isPaused =
        playerState.paused === true;

    const loopMode =
        playerState.loop || "none";

    const isLoopOn =
        loopMode !== "none";

    const sourceName =
        formatSourceName(
            track.info?.sourceName
        );

    const stateLabel = isPaused
        ? (
            t.playerState?.paused ||
            "Paused"
        )
        : (
            t.playerState?.playing ||
            "Playing"
        );

    const loopStateLabel = isLoopOn
        ? (
            t.playerState?.loopOn ||
            "Loop On"
        )
        : (
            t.playerState?.loopOff ||
            "Loop Off"
        );

    const infoLine =
        `${timeIcon} ${formatDuration(track.info.length)} • ` +
        `${userIcon} ${requesterName || (t.trackInfo?.unknown || "Unknown")} • ` +
        `${sourceIcon} ${sourceName}`;

    const stateLine1 =
        `${isPaused ? pauseIcon : playIcon} ${stateLabel}`;

    const stateLine2 =
        `${loopIcon} ${loopStateLabel}`;

    const durationLine =
        `${timeIcon} ${formatDuration(track.info.length)}`;

    const requesterLine =
        `${userIcon} ${requesterName || (t.trackInfo?.unknown || "Unknown")}`;

    const sourceLine =
        `${sourceIcon} ${sourceName}`;

    const queueHint =
        `${queueIcon} ${playerState.queueLength || 0} ${
            playerState.queueLength === 1
                ? "song"
                : "songs"
        } in queue`;

    const tryHint =
        buildRandomTryHint(
            playerState.commandMentionMap
        );

    const showTitleBlock = !mediaUrl;

    const container =
        new ContainerBuilder();

    /*
     * IMPORTANT:
     * mediaUrl must be the actual Discord CDN URL.
     *
     * NEVER pass attachment://song-banner.png
     * here during message edits.
     */
    if (mediaUrl) {
        const mediaGallery =
            new MediaGalleryBuilder().addItems(
                (mediaItem) =>
                    mediaItem
                        .setURL(mediaUrl)
                        .setDescription(
                            `${track.info?.title || "Unknown Title"} - ${track.info?.author || "Unknown Artist"}`
                        )
            );

        container
            .addSeparatorComponents(
                (separator) => separator
            )
            .addMediaGalleryComponents(
                mediaGallery
            );
    }

    if (showTitleBlock) {
        container.addTextDisplayComponents(
            (textDisplay) =>
                textDisplay.setContent(
                    `### ${titleIcon} ${track.info.title || "Unknown Title"}\n` +
                    `${byText} ${track.info.author || (t.trackInfo?.unknownArtist || "Unknown Artist")}`
                )
        );
    }

    const showSongDetails =
        !mediaUrl ||
        config.metadataTag === true;

    if (showSongDetails) {
        container
            .addSeparatorComponents(
                (separator) => separator
            )
            .addTextDisplayComponents(
                (textDisplay) =>
                    textDisplay.setContent(
                        `### ${infoIcon} ${t.songDetailsTitle || "Song Details"}\n` +
                        `${stateLine1}\n` +
                        `${stateLine2}\n` +
                        `${durationLine}\n` +
                        `${requesterLine}\n` +
                        `${sourceLine}\n` +
                        `${queueHint}`
                    )
            );
    }

    if (actionRows?.playbackRow) {
        container
            .addSeparatorComponents(
                (separator) => separator
            )
            .addTextDisplayComponents(
                (textDisplay) =>
                    textDisplay.setContent(
                        `### ${controlsIcon} Playback`
                    )
            )
            .addActionRowComponents(
                actionRows.playbackRow
            );
    }

    if (actionRows?.manageRow) {
        container
            .addSeparatorComponents(
                (separator) => separator
            )
            .addTextDisplayComponents(
                (textDisplay) =>
                    textDisplay.setContent(
                        `### ${manageIcon} Library`
                    )
            )
            .addActionRowComponents(
                actionRows.manageRow
            );
    }

    if (actionRows?.filterRow) {
        container
            .addSeparatorComponents(
                (separator) => separator
            )
            .addTextDisplayComponents(
                (textDisplay) =>
                    textDisplay.setContent(
                        `### ${filterIcon} Effects`
                    )
            )
            .addActionRowComponents(
                actionRows.filterRow
            );
    }

    container
        .addSeparatorComponents(
            (separator) => separator
        )
        .addTextDisplayComponents(
            (textDisplay) =>
                textDisplay.setContent(
                    tryHint
                )
        );

    return container;
}

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

        const needsAttachPermission =
            !!attachment;

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

        if (
            needsAttachPermission &&
            !permissions.has(
                PermissionsBitField.Flags.AttachFiles
            )
        ) {
            safeComponents =
                stripMediaGallery(
                    components
                );

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
            console.error(
                "[ PLAYER ] Initial message send failed:",
                sendError.message
            );

            /*
             * FALLBACK:
             * Remove the media gallery completely.
             */
            const fallbackComponents =
                stripMediaGallery(
                    components
                );

            const fallbackOptions = {
                components:
                    fallbackComponents,
                flags:
                    MessageFlags.IsComponentsV2
            };

            try {
                return await channel.send(
                    fallbackOptions
                );
            } catch (_) {
                return null;
            }
        }
    } catch (error) {
        const langSync =
            getLangSync();

        console.error(
            langSync.console?.player?.errorSendingMessage?.replace(
                "{message}",
                error.message
            ) ||
            "Error sending message:",
            error.message
        );

        return null;
    }
}

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

async function initializePlayer(client) {
    const nodeManager =
        await initializeLavalinkManager(
            client
        );

    client.riffy =
        nodeManager.riffy;

    client.lavalinkManager =
        nodeManager;

    client.nodeManager =
        nodeManager;

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
                    `[ VOICE DEBUG ] playerCreate guild=${player.guildId} voiceChannel=${player.voiceChannel || "null"} patch=${enableVoiceChannelIdPatch ? "on" : "off"}`
                );
            }
        }
    );

    client.riffy.on(
        "trackException",
        async (player, error) => {
            const langSync =
                getLangSync();

            const errorMsg =
                error?.message ||
                "Unknown error";

            const isTimeout =
                errorMsg.includes(
                    "timeout"
                ) ||
                errorMsg.includes(
                    "Read timed out"
                ) ||
                errorMsg.includes(
                    "SocketTimeoutException"
                );

            if (isTimeout) {
                console.warn(
                    `${colors.cyan}[ LAVALINK ]${colors.reset} ${colors.yellow}Track timeout for guild ${player?.guildId || "unknown"}: ${errorMsg}${colors.reset}`
                );
            } else {
                console.error(
                    `${colors.cyan}[ LAVALINK ]${colors.reset} ${colors.red}${langSync.console?.player?.trackException?.replace(
                        "{guildId}",
                        player?.guildId ||
                        "unknown"
                    ).replace(
                        "{message}",
                        errorMsg
                    ) ||
                    `Track Exception for guild ${player?.guildId || "unknown"}: ${errorMsg}`}${colors.reset}`
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
                        `${t.trackError?.title || "## ⚠️ Track Error"}\n\n` +
                        `${errorMessage}\n` +
                        `${t.trackError?.skipping || "Skipping to next song..."}`,
                        "Track Error"
                    );

                channel.send({
                    components: [
                        trackErrorCard
                    ],
                    flags:
                        MessageFlags.IsComponentsV2
                })
                    .catch(() => {})
                    .then((msg) => {
                        if (msg) {
                            setTimeout(
                                () =>
                                    msg.delete().catch(() => {}),
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

    client.riffy.on(
        "trackStuck",
        (player, error) => {
            const lang =
                getLangSync();

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
                    `${colors.cyan}[ LAVALINK ]${colors.reset} ${colors.yellow}Track stuck due to connection timeout for guild ${player?.guildId || "unknown"} - will retry${colors.reset}`
                );
            } else {
                console.error(
                    `${colors.cyan}[ LAVALINK ]${colors.reset} ${colors.red}${
                        lang.console?.player?.trackStuck?.replace(
                            "{guildId}",
                            player?.guildId ||
                            "unknown"
                        ).replace(
                            "{message}",
                            errorMsg
                        ) ||
                        `Track Stuck for guild ${player?.guildId || "unknown"}: ${errorMsg}`
                    }${colors.reset}`
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

    client.riffy.on(
        "trackStart",
        async (player, track) => {
            if (
                !track ||
                !track.info
            ) {
                const lang =
                    getLangSync();

                console.error(
                    `[ LAVALINK ] ${
                        lang.console?.player?.trackNull?.replace(
                            "{guildId}",
                            player.guildId
                        ) ||
                        `Track is null or missing info for guild ${player.guildId} - ignoring event`
                    }`
                );

                return;
            }

            await new Promise(
                (resolve) =>
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

            const trackUri =
                track.info.uri;

            const requester =
                requesters.get(
                    trackUri
                );

            const lang =
                await getLang(
                    guildId
                ).catch(() =>
                    getLangSync()
                );

            const t =
                lang.console?.player ||
                {};

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
                    "Error saving to history:",
                    error
                );
            }

            try {
                await cleanupPreviousTrackMessages(
                    channel,
                    guildId
                );

                await new Promise(
                    (resolve) =>
                        setTimeout(
                            resolve,
                            500
                        )
                );

                const canAttachFiles =
                    channel
                        .permissionsFor(
                            channel.guild.members.me
                        )
                        ?.has(
                            PermissionsBitField.Flags.AttachFiles
                        );

                let attachment =
                    null;

                if (
                    useGeneratedSongCard
                ) {
                    let thumbnailURL =
                        track.info.thumbnail ||
                        "";

                    const currentTrackUri =
                        track.info.uri ||
                        "";

                    if (
                        (
                            !thumbnailURL ||
                            !thumbnailURL.startsWith(
                                "http"
                            )
                        ) &&
                        currentTrackUri
                    ) {
                        thumbnailURL =
                            currentTrackUri;
                    }

                    try {
                        const cardBuffer =
                            await musicCard.generateCard(
                                {
                                    thumbnailURL,
                                    trackURI:
                                        currentTrackUri,
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
                                        config.showVisualizer !==
                                        false,
                                    currentPositionMs:
                                        0,
                                    totalDurationMs:
                                        track.info.length ||
                                        0
                                }
                            );

                        if (
                            cardBuffer &&
                            cardBuffer.length > 0
                        ) {
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
                            `Music card render failed: ${error.message}`
                        );
                    }
                }

                const commandMentionMap =
                    await getCommandMentionMap(
                        client
                    );

                const actionRows =
                    buildPlayerActionRows(
                        player.paused,
                        player.loop,
                        guildActiveFilter.get(
                            guildId
                        ) || null
                    );

                /*
                 * IMPORTANT:
                 *
                 * Initial message may use:
                 * attachment://song-banner.png
                 *
                 * because the attachment is being
                 * uploaded in THIS same request.
                 */
                const initialMediaUrl =
                    attachment &&
                    canAttachFiles
                        ? "attachment://song-banner.png"
                        : null;

                const nowPlayingContainer =
                    buildNowPlayingContainer(
                        track,
                        requester,
                        t,
                        config.showProgressBar !==
                            false
                            ? createProgressBar(
                                0,
                                track.info.length
                            )
                            : null,
                        0,
                        initialMediaUrl,
                        actionRows,
                        {
                            paused:
                                player.paused,
                            loop:
                                player.loop,
                            currentPosition:
                                0,
                            queueLength:
                                player.queue.length,
                            commandMentionMap
                        }
                    );

                const components = [
                    nowPlayingContainer
                ];

                const message =
                    await sendMessageWithPermissionsCheck(
                        channel,
                        components,
                        canAttachFiles
                            ? attachment
                            : null
                    );

                if (!message) {
                    console.error(
                        `Failed to send player message for guild ${guildId}`
                    );
                    return;
                }

                /*
                 * CRITICAL FIX:
                 *
                 * Discord gives the uploaded attachment
                 * a real CDN URL.
                 *
                 * We store THAT URL.
                 *
                 * We do NOT store:
                 * attachment://song-banner.png
                 */
                const sentAttachment =
                    message.attachments?.first();

                const sentMediaUrl =
                    sentAttachment?.url ||
                    null;

                if (
                    sentMediaUrl &&
                    !sentMediaUrl.startsWith(
                        "attachment://"
                    )
                ) {
                    setTrackMediaCache(
                        guildId,
                        track.info.uri,
                        sentMediaUrl
                    );
                } else {
                    clearTrackMediaCache(
                        guildId
                    );
                }

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
                        type: "track"
                    });

                nowPlayingMessages.set(
                    guildId,
                    {
                        messageId:
                            message.id,
                        channelId:
                            channel.id,
                        player,
                        trackUri:
                            track.info.uri
                    }
                );

                const intervalId =
                    await startProgressUpdates(
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

                setupCollector(
                    client,
                    player,
                    channel,
                    message
                );
            } catch (error) {
                console.error(
                    "Error creating or sending music card:",
                    error.message
                );
            }
        }
    );

    client.riffy.on(
        "trackEnd",
        async (player) => {
            const guildId =
                player.guildId;

            clearTrackMediaCache(
                guildId
            );

            if (
                client.statusManager
            ) {
                await client.statusManager
                    .onTrackEnd(
                        guildId
                    )
                    .catch(() => {});
            }

            clearProgressUpdates(
                guildId
            );

            const channel =
                client.channels.cache.get(
                    player.textChannel
                );

            if (channel) {
                const settings =
                    await autoplayCollection
                        .findOne({
                            guildId
                        })
                        .catch(
                            () => null
                        );

                const hasNextTrack =
                    player.queue.length >
                        0 ||
                    player.loop ===
                        "queue" ||
                    player.loop ===
                        "track" ||
                    settings?.autoplay;

                if (!hasNextTrack) {
                    await cleanupTrackMessages(
                        client,
                        player
                    );
                }
            }
        }
    );

    client.riffy.on(
        "playerDisconnect",
        async (player) => {
            const guildId =
                player.guildId;

            clearTrackMediaCache(
                guildId
            );

            if (
                client.statusManager
            ) {
                await client.statusManager
                    .onPlayerDisconnect(
                        guildId
                    )
                    .catch(() => {});
            }

            clearProgressUpdates(
                guildId
            );

            await cleanupTrackMessages(
                client,
                player
            );
        }
    );

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
                    await autoplayCollection.findOne(
                        {
                            guildId
                        }
                    );

                const is24_7 =
                    settings?.twentyfourseven;

                if (settings?.autoplay) {
                    await cleanupPreviousTrackMessages(
                        channel,
                        guildId
                    );

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

                            await sendTransientCard(
                                channel,
                                "⚠️ **No more tracks to autoplay. Disconnecting...**",
                                5000,
                                "Autoplay Ended"
                            );
                        } else {
                            await sendTransientCard(
                                channel,
                                "🔄 **24/7 Mode: Bot will stay in voice channel. Queue is empty.**",
                                5000,
                                "Queue Empty"
                            );
                        }
                    }
                } else {
                    await cleanupTrackMessages(
                        client,
                        player
                    );

                    if (!is24_7) {
                        player.destroy();

                        await sendTransientCard(
                            channel,
                            "🎶 **Queue has ended. Autoplay is disabled.**",
                            5000,
                            "Queue Ended"
                        );
                    } else {
                        await sendTransientCard(
                            channel,
                            "🔄 **24/7 Mode: Bot will stay in voice channel. Queue is empty.**",
                            5000,
                            "Queue Empty"
                        );
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
            }
        }
    );
}

async function cleanupPreviousTrackMessages(
    channel,
    guildId
) {
    const messages =
        guildTrackMessages.get(
            guildId
        ) || [];

    for (const messageInfo of messages) {
        try {
            const fetchChannel =
                channel.client.channels.cache.get(
                    messageInfo.channelId
                );

            if (fetchChannel) {
                const message =
                    await fetchChannel.messages
                        .fetch(
                            messageInfo.messageId
                        )
                        .catch(
                            () => null
                        );

                if (message) {
                    await message
                        .delete()
                        .catch(() => {});
                }
            }
        } catch (_) {}
    }

    guildTrackMessages.set(
        guildId,
        []
    );
}

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

    const messages =
        guildTrackMessages.get(
            guildId
        ) || [];

    for (const messageInfo of messages) {
        try {
            const channel =
                client.channels.cache.get(
                    messageInfo.channelId
                );

            if (channel) {
                const message =
                    await channel.messages
                        .fetch(
                            messageInfo.messageId
                        )
                        .catch(
                            () => null
                        );

                if (message) {
                    await message
                        .delete()
                        .catch(() => {});
                }
            }
        } catch (_) {}
    }

    guildTrackMessages.set(
        guildId,
        []
    );

    nowPlayingMessages.delete(
        guildId
    );
}

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

/*
 * Rebuilds the now-playing message.
 *
 * IMPORTANT:
 * It uses ONLY the cached Discord CDN URL.
 *
 * It NEVER uses attachment://song-banner.png.
 */
async function refreshNowPlayingPanel(
    client,
    guildId
) {
    const stored =
        nowPlayingMessages.get(
            guildId
        );

    if (!stored) return;

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

    if (!channel) return;

    const msg =
        await channel.messages
            .fetch(
                stored.messageId
            )
            .catch(() => null);

    if (!msg) return;

    const track =
        player.current;

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
        (
            t.trackInfo?.unknown ||
            "Unknown"
        );

    const commandMentionMap =
        await getCommandMentionMap(
            client
        );

    const progressBar =
        createProgressBar(
            player.position || 0,
            track.info.length || 1
        );

    /*
     * FIX:
     *
     * Get the CDN URL from cache.
     *
     * Do not construct attachment://...
     */
    const cachedMedia =
        useGeneratedSongCard
            ? getTrackMediaCache(
                guildId,
                track.info.uri
            )
            : null;

    let mediaUrl =
        cachedMedia?.mediaUrl ||
        null;

    /*
     * If cache is empty, recover the URL from
     * the existing Discord message.
     */
    if (
        mediaUrl &&
        mediaUrl.startsWith(
            "attachment://"
        )
    ) {
        mediaUrl = null;
    }

    if (!mediaUrl) {
        const existingAttachment =
            msg.attachments?.first();

        if (existingAttachment?.url) {
            mediaUrl =
                existingAttachment.url;

            setTrackMediaCache(
                guildId,
                track.info.uri,
                mediaUrl
            );
        }
    }

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
            config.showProgressBar !==
                false
                ? progressBar
                : null,
            Math.min(
                100,
                Math.round(
                    (
                        (player.position || 0) /
                        (track.info.length || 1)
                    ) * 100
                )
            ),
            mediaUrl,
            actionRows,
            {
                paused:
                    player.paused,
                loop:
                    player.loop,
                currentPosition:
                    player.position || 0,
                queueLength:
                    player.queue.length,
                commandMentionMap
            }
        );

    await msg
        .edit({
            components: [
                container
            ],
            flags:
                MessageFlags.IsComponentsV2
        })
        .catch((error) => {
            console.warn(
                "[ PLAYER ] Failed to refresh panel:",
                error.message
            );
        });
}

function setupCollector(
    client,
    player,
    channel,
    message
) {
    const filter = (i) =>
        [
            "loopToggle",
            "skipTrack",
            "stopTrack",
            "togglePlayback",
            "player_favorite",
            "player_add_song",
            "player_volume",
            "player_save_song",
            "player_queue",
            "player_shuffle",
            "player_filter_select",
            "player_filter_clear"
        ].includes(i.customId);

    const collector =
        message.createMessageComponentCollector(
            {
                filter,
                time: 300000
            }
        );

    collector.on(
        "collect",
        async (i) => {
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
                        "## 🔒 Voice Channel Required\n\nYou need to be in the same voice channel to use the controls!",
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
                    config.embedTimeout *
                        1000
                );

                return;
            }

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
                    await i
                        .awaitModalSubmit({
                            filter: (m) =>
                                m.customId ===
                                    "player_modal_addsong" &&
                                m.user.id ===
                                    i.user.id,
                            time: 60000
                        })
                        .catch(
                            () => null
                        );

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
                    await i
                        .awaitModalSubmit({
                            filter: (m) =>
                                m.customId ===
                                    "player_modal_volume" &&
                                m.user.id ===
                                    i.user.id,
                            time: 60000
                        })
                        .catch(
                            () => null
                        );

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
                    await i
                        .awaitModalSubmit({
                            filter: (m) =>
                                m.customId ===
                                    "player_modal_save_song" &&
                                m.user.id ===
                                    i.user.id,
                            time: 60000
                        })
                        .catch(
                            () => null
                        );

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
                await safeDeferUpdate(
                    i
                );

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

    return collector;
}

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
        case "loopToggle":
            await toggleLoop(
                player,
                channel,
                t
            );

            await refreshNowPlayingPanel(
                client,
                player.guildId
            );
            break;

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

        case "disableLoop":
            await disableLoop(
                player,
                channel,
                t
            );
            break;

        case "showLyrics":
            await showLyrics(
                channel,
                player
            );
            break;

        case "clearQueue":
            player.queue.clear();

            await sendEmbed(
                channel,
                t.controls?.queueCleared ||
                    "🗑️ **Queue has been cleared!**"
            );

            break;

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
                    "⏹️ **Playback has been stopped and player destroyed!**"
            );

            break;

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

                    await sendEmbed(
                        channel,
                        t.controls?.playbackResumed ||
                            "▶️ **Playback has been resumed!**"
                    );
                } else {
                    player.pause(true);

                    await sendEmbed(
                        channel,
                        t.controls?.playbackPaused ||
                            "⏸️ **Playback has been paused!**"
                    );
                }

                await refreshNowPlayingPanel(
                    client,
                    player.guildId
                );
            } catch (error) {
                console.warn(
                    `[ PLAYER ] Toggle playback error: ${error.message}`
                );

                await sendEmbed(
                    channel,
                    "⚠️ **Failed to change playback state. Please try again.**"
                );
            }

            break;

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
                    await playlistCollection.findOne(
                        {
                            name:
                                playlistName,
                            userId,
                            serverId
                        }
                    );

                if (!existing) {
                    const legacy =
                        await playlistCollection.findOne(
                            {
                                name:
                                    legacyPlaylistName,
                                userId,
                                serverId
                            }
                        );

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
                            await playlistCollection.findOne(
                                {
                                    _id:
                                        legacy._id
                                }
                            );
                    }
                }

                if (!existing) {
                    await playlistCollection.insertOne(
                        {
                            name:
                                playlistName,
                            songs: [],
                            isPrivate:
                                true,
                            userId,
                            serverId,
                            serverName
                        }
                    );
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

                await sendEmbed(
                    channel,
                    "✅ **Added to Favorites.**"
                );
            } catch (_) {
                await sendEmbed(
                    channel,
                    "⚠️ **Failed to add favorite.**"
                );
            }

            break;
        }

        case "player_filter_select": {
            const selectedFilter =
                i.values?.[0];

            /*
             * FIX:
             * Use the same clear value used
             * by createFilterRow().
             */
            if (
                selectedFilter ===
                "__clear__"
            ) {
                player.filters.clearFilters();

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

        case "player_filter_clear":
            player.filters.clearFilters();

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
                            `${index + 1}. ${
                                item.info?.title ||
                                "Unknown title"
                            }`
                    )
                    .join("\n");

            await sendEmbed(
                channel,
                `📄 **Upcoming Queue**\n\n${preview}`
            );

            break;
        }

        case "player_shuffle":
            if (player.queue.length < 2) {
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

        case "volumeUp":
            await adjustVolume(
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

        case "volumeDown":
            await adjustVolume(
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
    }
}

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
                await client.riffy.resolve(
                    {
                        query,
                        requester:
                            modal.user.username
                    }
                );

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
                for (const track of resolve.tracks) {
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
                player.play();
            }

            await refreshNowPlayingPanel(
                client,
                player.guildId
            );

            await modal.editReply({
                content:
                    `✅ Added ${added} track${
                        added === 1
                            ? ""
                            : "s"
                    } to queue.`
            });

            return;
        }

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
                await playlistCollection.findOne(
                    {
                        name:
                            playlistName,
                        userId,
                        serverId
                    }
                );

            if (!existing) {
                await playlistCollection.insertOne(
                    {
                        name:
                            playlistName,
                        songs: [],
                        isPrivate:
                            false,
                        userId,
                        serverId,
                        serverName
                    }
                );
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
            "[ PLAYER ] Modal error:",
            error
        );

        await modal.editReply({
            content:
                "⚠️ Failed to process modal action."
        }).catch(() => {});
    }
}

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
                player.volume +
                    amount
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
            ).replace(
                "{volume}",
                newVolume
            )
        );
    }
}

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
            error.response?.data
                ?.message ||
                error.message
        );

        return null;
    }
}

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
                (line) =>
                    line.trim()
            )
            .filter(Boolean);

    const songDuration =
        Math.floor(
            track.length / 1000
        );

    const lyricsContainer =
        new ContainerBuilder()
            .addTextDisplayComponents(
                (textDisplay) =>
                    textDisplay.setContent(
                        `${
                            (
                                t.lyrics?.liveTitle ||
                                "## 🎵 Live Lyrics: {title}"
                            ).replace(
                                "{title}",
                                track.title
                            )
                        }\n\n` +
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
            type: "lyrics"
        });

    const updateLyrics =
        async () => {
            const currentTime =
                Math.floor(
                    player.position /
                        1000
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
                    currentLineIndex -
                        3
                );

            const end =
                Math.min(
                    totalLines,
                    currentLineIndex +
                        3
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
                        (textDisplay) =>
                            textDisplay.setContent(
                                `${
                                    (
                                        t.lyrics?.liveTitle ||
                                        "## 🎵 Live Lyrics: {title}"
                                    ).replace(
                                        "{title}",
                                        track.title
                                    )
                                }\n\n` +
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
            });
        };

    const interval =
        setInterval(
            updateLyrics,
            3000
        );

    updateLyrics();

    const collector =
        message.createMessageComponentCollector(
            {
                time: 300000
            }
        );

    collector.on(
        "collect",
        async (i) => {
            const deferred =
                await safeDeferUpdate(
                    i
                );

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
            }

            if (
                i.customId ===
                "fullLyrics"
            ) {
                clearInterval(
                    interval
                );

                const fullLyricsContainer =
                    new ContainerBuilder()
                        .addTextDisplayComponents(
                            (textDisplay) =>
                                textDisplay.setContent(
                                    `${
                                        (
                                            t.lyrics?.fullTitle ||
                                            "## 🎵 Full Lyrics: {title}"
                                        ).replace(
                                            "{title}",
                                            track.title
                                        )
                                    }\n\n` +
                                    lines.join(
                                        "\n"
                                    )
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
            }

            if (
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

    const volumeEmoji =
        getButtonEmoji("volume") ||
        "🔊";

    const loopEmoji =
        getButtonEmoji("settings") ||
        "🔁";

    const stopEmoji =
        getButtonEmoji("stop") ||
        "⏹️";

    const loopEnabled =
        loopMode !== "none";

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
                .setLabel("Skip")
                .setStyle(
                    ButtonStyle.Secondary
                )
                .setDisabled(
                    disabled
                ),

            new ButtonBuilder()
                .setCustomId(
                    "player_volume"
                )
                .setEmoji(
                    volumeEmoji
                )
                .setLabel("Volume")
                .setStyle(
                    ButtonStyle.Secondary
                )
                .setDisabled(
                    disabled
                ),

            new ButtonBuilder()
                .setCustomId(
                    "loopToggle"
                )
                .setEmoji(
                    loopEmoji
                )
                .setLabel("Loop")
                .setStyle(
                    loopEnabled
                        ? ButtonStyle.Success
                        : ButtonStyle.Secondary
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
                .setLabel("Stop")
                .setStyle(
                    ButtonStyle.Danger
                )
                .setDisabled(
                    disabled
                )
        );
}

function createManageSongActionRow(
    disabled
) {
    const favoriteEmoji =
        getButtonEmoji(
            "welcome"
        ) || "⭐";

    const addEmoji =
        getButtonEmoji(
            "play"
        ) || "➕";

    const queueEmoji =
        getButtonEmoji(
            "queue"
        ) || "📄";

    const saveEmoji =
        getButtonEmoji(
            "folder"
        ) || "💾";

    const shuffleEmoji =
        getButtonEmoji(
            "servers"
        ) || "🌐";

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
                .setLabel("Add")
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
                .setLabel("Queue")
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
                .setLabel("Save")
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
                    (item) => ({
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
            ),

        manageRow:
            createManageSongActionRow(
                false
            ),

        filterRow:
            createFilterRow(
                false,
                activeFilter
            )
    };
}

async function applyFilterByKey(
    player,
    selectedFilter
) {
    switch (
        selectedFilter
    ) {
        case "karaoke":
            player.filters.setKaraoke(
                true
            );
            break;

        case "timescale":
            player.filters.setTimescale(
                true,
                {
                    speed: 1.2,
                    pitch: 1.2
                }
            );
            break;

        case "tremolo":
            player.filters.setTremolo(
                true,
                {
                    frequency: 4,
                    depth: 0.75
                }
            );
            break;

        case "vibrato":
            player.filters.setVibrato(
                true,
                {
                    frequency: 4,
                    depth: 0.75
                }
            );
            break;

        case "rotation":
            player.filters.setRotation(
                true,
                {
                    rotationHz: 0.2
                }
            );
            break;

        case "distortion":
            player.filters.setDistortion(
                true,
                {
                    sinScale: 1,
                    cosScale: 1
                }
            );
            break;

        case "channelmix":
            player.filters.setChannelMix(
                true,
                {
                    leftToLeft: 0.5,
                    leftToRight: 0.5,
                    rightToLeft: 0.5,
                    rightToRight: 0.5
                }
            );
            break;

        case "lowpass":
            player.filters.setLowPass(
                true,
                {
                    smoothing: 0.5
                }
            );
            break;

        case "bassboost":
            player.filters.setBassboost(
                true,
                {
                    value: 3
                }
            );
            break;

        case "nightcore":
            player.filters.setTimescale(
                true,
                {
                    speed: 1.25,
                    pitch: 1.25,
                    rate: 1
                }
            );
            break;

        case "daycore":
            player.filters.setTimescale(
                true,
                {
                    speed: 1,
                    pitch: 0.8,
                    rate: 1
                }
            );
            break;

        default:
            return false;
    }

    return true;
}

function createProgressBar(
    current,
    total,
    length = 20
) {
    const progress =
        Math.round(
            (
                current /
                total
            ) * length
        );

    const safeProgress =
        Math.max(
            0,
            Math.min(
                length,
                progress
            )
        );

    const emptyProgress =
        length -
        safeProgress;

    const progressText =
        "▓".repeat(
            safeProgress
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

    return `\`${currentTime}\` ${progressText}${emptyProgressText} \`${totalTime}\``;
}

async function startProgressUpdates(
    client,
    guildId,
    message,
    player,
    track
) {
    if (
        config.lowMemoryMode ===
        true
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
                        currentPlayer !==
                            player
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
                        player.current.info
                            .uri !==
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
                        player.position ||
                        0;

                    const totalDuration =
                        track.info.length ||
                        1;

                    const progress =
                        Math.min(
                            100,
                            Math.round(
                                (
                                    currentPosition /
                                    totalDuration
                                ) * 100
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
                        lang.console
                            ?.player ||
                        {};

                    const requester =
                        requesters.get(
                            track.info.uri
                        ) ||
                        (
                            t.trackInfo
                                ?.unknown ||
                            "Unknown"
                        );

                    const commandMentionMap =
                        await getCommandMentionMap(
                            client
                        );

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
                     * CRITICAL FIX:
                     *
                     * Get the actual CDN URL.
                     *
                     * NEVER create:
                     *
                     * attachment://song-banner.png
                     */
                    let mediaUrl =
                        null;

                    const cachedMedia =
                        useGeneratedSongCard
                            ? getTrackMediaCache(
                                guildId,
                                track.info.uri
                            )
                            : null;

                    if (
                        cachedMedia?.mediaUrl &&
                        !cachedMedia.mediaUrl.startsWith(
                            "attachment://"
                        )
                    ) {
                        mediaUrl =
                            cachedMedia.mediaUrl;
                    }

                    /*
                     * If the cache doesn't have it,
                     * recover the original attachment
                     * URL from the Discord message.
                     */
                    if (!mediaUrl) {
                        const existingAttachment =
                            msg.attachments?.first();

                        if (
                            existingAttachment?.url
                        ) {
                            mediaUrl =
                                existingAttachment.url;

                            setTrackMediaCache(
                                guildId,
                                track.info.uri,
                                mediaUrl
                            );
                        }
                    }

                    const nowPlayingContainer =
                        buildNowPlayingContainer(
                            track,
                            requester,
                            t,
                            config.showProgressBar !==
                                false
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
                                currentPosition,
                                queueLength:
                                    player.queue.length,
                                commandMentionMap
                            }
                        );

                    /*
                     * NO files array here.
                     *
                     * The original attachment already
                     * exists on the message.
                     *
                     * We simply use its CDN URL.
                     */
                    await msg.edit({
                        components: [
                            nowPlayingContainer
                        ],
                        flags:
                            MessageFlags.IsComponentsV2
                    });
                } catch (error) {
                    console.warn(
                        "[ PLAYER ] Progress update error:",
                        error.message
                    );
                }
            },
            15000
        );

    return updateInterval;
}

module.exports = {
    initializePlayer,
    cleanupTrackMessages
};
