"use strict";

const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    PermissionsBitField,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder
} = require("discord.js");

const { requesters } = require("./commands/music/play");
const { EnhancedMusicCard } = require("./utils/musicCard");
const config = require("./config.js");
const {
    getEmoji,
    getButtonEmoji
} = require("./UI/emojis/emoji");
const colors = require("./UI/colors/colors");
const axios = require("axios");

const {
    autoplayCollection,
    playlistCollection
} = require("./mongodb.js");

const {
    initializeLavalinkManager
} = require("./lavalink.js");

/* =========================================================
   LANGUAGE
========================================================= */

let getLangSync;
let getLang;

try {
    const langLoader =
        require("./utils/languageLoader.js");

    getLangSync =
        langLoader.getLangSync;

    getLang =
        langLoader.getLang;

} catch (error) {

    getLangSync = () => ({
        console: {}
    });

    getLang = async () => ({
        console: {
            player: {}
        }
    });
}

/* =========================================================
   STORAGE
========================================================= */

const guildTrackMessages = new Map();
const nowPlayingMessages = new Map();
const progressUpdateIntervals = new Map();
const guildActiveFilter = new Map();
const guildTrackMediaCache = new Map();
const playerCollectors = new Map();

const musicCard =
    new EnhancedMusicCard();

const useGeneratedSongCard =
    config.generateSongCard !== false;

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

const PLAYER_COMPONENT_IDS = new Set([
    "togglePlayback",
    "skipTrack",
    "player_volume",
    "loopToggle",
    "stopTrack",

    "player_favorite",
    "player_add_song",
    "player_queue",
    "player_save_song",
    "player_shuffle",

    "player_filter_select"
]);

/* =========================================================
   COMMAND MENTIONS
========================================================= */

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

        fetched.forEach((command) => {

            if (
                command?.name &&
                command?.id
            ) {
                map.set(
                    command.name,
                    command.id
                );
            }
        });

    } catch (error) {

        console.warn(
            "Unable to fetch command mentions:",
            error.message
        );
    }

    commandMentionCache = {
        expiresAt:
            now +
            COMMAND_MENTION_CACHE_TTL_MS,

        map
    };

    return map;
}

function getCommandRef(
    name,
    mentionMap
) {

    const id =
        mentionMap?.get?.(name);

    return id
        ? `</${name}:${id}>`
        : `/${name}`;
}

function buildRandomTryHint(
    mentionMap
) {

    const searchIcon =
        getEmoji("search") ||
        "🔎";

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

    const shuffled =
        [...pool].sort(
            () =>
                Math.random() -
                0.5
        );

    const picks =
        shuffled.slice(0, 3);

    const refs = [
        getCommandRef(
            "help",
            mentionMap
        ),

        ...picks.map(
            (command) =>
                getCommandRef(
                    command,
                    mentionMap
                )
        )
    ];

    return `${searchIcon} Try: ${refs.join(" • ")}`;
}

/* =========================================================
   MODALS
========================================================= */

function createAddSongModal() {

    const modal =
        new ModalBuilder()
            .setCustomId(
                "player_modal_addsong"
            )
            .setTitle(
                "Add Song to Queue"
            );

    const input =
        new TextInputBuilder()
            .setCustomId("query")
            .setLabel(
                "Song Name or URL"
            )
            .setStyle(
                TextInputStyle.Short
            )
            .setPlaceholder(
                "e.g. Adele Skyfall or https://..."
            )
            .setRequired(true)
            .setMaxLength(200);

    modal.addComponents(
        new ActionRowBuilder()
            .addComponents(input)
    );

    return modal;
}

function createVolumeModal(
    currentVolume = 100
) {

    const safeVolume =
        Math.min(
            100,
            Math.max(
                1,
                Number(currentVolume) || 100
            )
        );

    const modal =
        new ModalBuilder()
            .setCustomId(
                "player_modal_volume"
            )
            .setTitle(
                "Set Volume"
            );

    const input =
        new TextInputBuilder()
            .setCustomId("volume")
            .setLabel(
                "Volume (1-100)"
            )
            .setStyle(
                TextInputStyle.Short
            )
            .setPlaceholder(
                String(safeVolume)
            )
            .setRequired(true)
            .setMaxLength(3);

    modal.addComponents(
        new ActionRowBuilder()
            .addComponents(input)
    );

    return modal;
}

function createSaveSongModal() {

    const modal =
        new ModalBuilder()
            .setCustomId(
                "player_modal_save_song"
            )
            .setTitle(
                "Save Song to Playlist"
            );

    const input =
        new TextInputBuilder()
            .setCustomId(
                "playlistName"
            )
            .setLabel(
                "Playlist Name"
            )
            .setStyle(
                TextInputStyle.Short
            )
            .setPlaceholder(
                "My Favorites"
            )
            .setRequired(true)
            .setMaxLength(80);

    modal.addComponents(
        new ActionRowBuilder()
            .addComponents(input)
    );

    return modal;
}

/* =========================================================
   VOICE PATCH
========================================================= */

function patchVoiceChannelIdSupport(
    player
) {

    const connection =
        player?.connection;

    if (
        !connection ||
        connection.__voiceChannelIdPatchApplied
    ) {
        return;
    }

    connection.__voiceChannelIdPatchApplied =
        true;

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
            connection.setStateUpdate.bind(
                connection
            );

        connection.setStateUpdate =
            (data) => {

                try {
                    originalSetStateUpdate(data);
                } catch (error) {
                    console.error(
                        "Voice state update error:",
                        error
                    );
                }

                const channelId =
                    data?.channel_id ||
                    connection.voiceChannel ||
                    player.voiceChannel ||
                    null;

                if (channelId) {
                    connection.voice.channelId =
                        channelId;
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

        connection.updatePlayerVoiceData =
            () => {

                if (
                    !connection.voice.channelId
                ) {

                    connection.voice.channelId =
                        connection.voiceChannel ||
                        player.voiceChannel ||
                        null;
                }

                try {
                    originalUpdatePlayerVoiceData();
                } catch (error) {
                    console.error(
                        "Voice player data update error:",
                        error
                    );
                }
            };
    }
}

/* =========================================================
   TRACK CACHE
========================================================= */

function setTrackMediaCache(
    guildId,
    trackUri,
    mediaUrl = null,
    cardBuffer = null
) {

    if (
        !guildId ||
        !trackUri
    ) {
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
        guildTrackMediaCache.get(
            guildId
        );

    if (
        !cached ||
        cached.trackUri !== trackUri
    ) {
        return null;
    }

    return cached;
}

function clearTrackMediaCache(
    guildId
) {

    guildTrackMediaCache.delete(
        guildId
    );
}

/* =========================================================
   PROGRESS INTERVAL
========================================================= */

function clearProgressUpdates(
    guildId
) {

    const intervalId =
        progressUpdateIntervals.get(
            guildId
        );

    if (intervalId) {

        clearInterval(
            intervalId
        );

        progressUpdateIntervals.delete(
            guildId
        );
    }
}

function replaceProgressInterval(
    guildId,
    interval
) {

    clearProgressUpdates(
        guildId
    );

    if (interval) {

        progressUpdateIntervals.set(
            guildId,
            interval
        );
    }
}

/* =========================================================
   PLAYER VALIDATION
========================================================= */

function isValidPlayer(
    player
) {

    return Boolean(
        player &&
        !player.destroyed
    );
}

function getPlayer(
    client,
    guildId
) {

    return client?.riffy?.players?.get(
        guildId
    ) || null;
}

/* =========================================================
   SOURCE
========================================================= */

function formatSourceName(
    sourceName
) {

    const raw =
        String(
            sourceName ||
            "Unknown"
        ).toLowerCase();

    if (raw === "youtube")
        return "YouTube";

    if (raw === "soundcloud")
        return "SoundCloud";

    if (raw === "spotify")
        return "Spotify";

    if (raw === "applemusic")
        return "Apple Music";

    return (
        raw.charAt(0).toUpperCase() +
        raw.slice(1)
    );
}

/* =========================================================
   DURATION
========================================================= */

function formatDuration(
    ms
) {

    ms = Number(ms) || 0;

    if (ms <= 0) {
        return "0s";
    }

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

/* =========================================================
   PROGRESS BAR
========================================================= */

function createProgressBar(
    current,
    total,
    length = 20
) {

    current =
        Number(current) || 0;

    total =
        Number(total) || 1;

    const progressRatio =
        Math.max(
            0,
            Math.min(
                1,
                current / total
            )
        );

    const progress =
        Math.round(
            progressRatio * length
        );

    const emptyProgress =
        Math.max(
            0,
            length - progress
        );

    const progressText =
        "▬".repeat(progress);

    const emptyProgressText =
        "─".repeat(
            emptyProgress
        );

    const currentTime =
        formatDuration(current);

    const totalTime =
        formatDuration(total);

    return (
        `\`${currentTime}\` ` +
        `${progressText}` +
        `🔘` +
        `${emptyProgressText} ` +
        `\`${totalTime}\``
    );
}

/* =========================================================
   LOOP TEXT
========================================================= */

function getLoopText(
    loopMode
) {

    switch (loopMode) {

        case "track":
            return "Track";

        case "queue":
            return "Queue";

        default:
            return "Disabled";
    }
}

/* =========================================================
   NOW PLAYING EMBED
========================================================= */

function buildNowPlayingEmbed(
    track,
    requesterName,
    t,
    progressBar,
    progressPercent,
    thumbnailUrl,
    playerState = {}
) {

    const musicIcon =
        getEmoji("music") ||
        "🎵";

    const playIcon =
        getEmoji("play") ||
        "▶️";

    const pauseIcon =
        getEmoji("pause") ||
        "⏸️";

    const userIcon =
        getEmoji("users") ||
        "👤";

    const sourceIcon =
        getEmoji("servers") ||
        "🌐";

    const timeIcon =
        getEmoji("uptime") ||
        "⏱️";

    const isPaused =
        playerState.paused === true;

    const sourceName =
        formatSourceName(
            track?.info?.sourceName
        );

    const title =
        track?.info?.title ||
        "Unknown Title";

    const author =
        track?.info?.author ||
        "Unknown Artist";

    const requester =
        requesterName ||
        "Unknown";

    const duration =
        formatDuration(
            track?.info?.length || 0
        );

    const stateIcon =
        isPaused
            ? pauseIcon
            : playIcon;

    const stateText =
        isPaused
            ? "Paused"
            : "Playing";

    const queueLength =
        Number(
            playerState.queueLength
        ) || 0;

    const loopText =
        getLoopText(
            playerState.loop
        );

    const embed =
        new EmbedBuilder()
            .setColor(
                0x5865F2
            )
            .setTitle(
                `${musicIcon} Now Playing`
            )
            .setDescription(
                `**${title}**\n` +
                `> ${author}\n\n` +

                `${stateIcon} **${stateText}**\n` +
                `${timeIcon} **Duration:** ${duration}\n` +
                `${userIcon} **Requested by:** ${requester}\n` +
                `${sourceIcon} **Source:** ${sourceName}\n` +
                `🔁 **Loop:** ${loopText}\n` +
                `📋 **Queue:** ${queueLength} song${queueLength === 1 ? "" : "s"}`
            )
            .setFooter({
                text:
                    "Click the buttons below to control playback"
            })
            .setTimestamp();

    if (
        thumbnailUrl &&
        /^https?:\/\//i.test(
            thumbnailUrl
        )
    ) {

        embed.setThumbnail(
            thumbnailUrl
        );
    }

    if (
        progressBar &&
        config.showProgressBar !== false
    ) {

        embed.addFields({
            name: "Progress",
            value: progressBar,
            inline: false
        });
    }

    if (
        typeof progressPercent ===
        "number" &&
        progressPercent >= 0
    ) {

        embed.addFields({
            name: "Progress %",
            value:
                `${Math.min(
                    100,
                    Math.max(
                        0,
                        progressPercent
                    )
                )}%`,
            inline: false
        });
    }

    return embed;
}

/* =========================================================
   PLAYER BUTTONS
========================================================= */

function createPlaybackActionRow(
    disabled = false,
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

    const playbackEmoji =
        paused
            ? playEmoji
            : pauseEmoji;

    const playbackLabel =
        paused
            ? "Play"
            : "Pause";

    const loopEnabled =
        loopMode !== "none";

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
                    paused
                        ? ButtonStyle.Success
                        : ButtonStyle.Secondary
                )
                .setDisabled(disabled),

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
                .setDisabled(disabled),

            new ButtonBuilder()
                .setCustomId(
                    "player_volume"
                )
                .setEmoji(
                    volumeEmoji
                )
                .setLabel(
                    "Volume"
                )
                .setStyle(
                    ButtonStyle.Secondary
                )
                .setDisabled(disabled),

            new ButtonBuilder()
                .setCustomId(
                    "loopToggle"
                )
                .setEmoji(
                    loopEmoji
                )
                .setLabel(
                    "Loop"
                )
                .setStyle(
                    loopEnabled
                        ? ButtonStyle.Success
                        : ButtonStyle.Secondary
                )
                .setDisabled(disabled),

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
                .setDisabled(disabled)
        );
}

function createManageSongActionRow(
    disabled = false
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
                .setDisabled(disabled),

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
                .setDisabled(disabled),

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
                .setDisabled(disabled),

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
                .setDisabled(disabled),

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
                .setDisabled(disabled)
        );
}

/* =========================================================
   FILTER ROW
========================================================= */

function createFilterRow(
    disabled = false,
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
            .addOptions([

                /*
                 * IMPORTANT:
                 * This value must match the
                 * interaction handler.
                 */
                {
                    label:
                        "Clear Filters",

                    value:
                        "__clear__",

                    default:
                        !activeFilter
                },

                ...PLAYER_FILTER_OPTIONS.map(
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
            ]);

    return new ActionRowBuilder()
        .addComponents(
            select
        );
}

/* =========================================================
   PLAYER ROWS
========================================================= */

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

/* =========================================================
   SEND PLAYER MESSAGE
========================================================= */

async function sendPlayerMessage(
    channel,
    embed,
    actionRows = [],
    attachment = null
) {

    if (!channel) {
        return null;
    }

    try {

        const me =
            channel.guild?.members?.me;

        const permissions =
            me
                ? channel.permissionsFor(me)
                : null;

        if (
            permissions &&
            !permissions.has(
                PermissionsBitField.Flags.SendMessages
            )
        ) {

            console.error(
                "Bot does not have Send Messages permission."
            );

            return null;
        }

        if (
            permissions &&
            !permissions.has(
                PermissionsBitField.Flags.EmbedLinks
            )
        ) {

            console.error(
                "Bot does not have Embed Links permission."
            );

            return null;
        }

        const payload = {
            embeds: [
                embed
            ],

            components:
                actionRows
        };

        if (
            attachment &&
            (
                !permissions ||
                permissions.has(
                    PermissionsBitField.Flags.AttachFiles
                )
            )
        ) {

            payload.files = [
                attachment
            ];
        }

        return await channel.send(
            payload
        );

    } catch (error) {

        console.error(
            "Error sending player message:",
            error
        );

        try {

            return await channel.send({
                content:
                    "⚠️ Unable to display the music player.",

                components:
                    actionRows
            });

        } catch (fallbackError) {

            console.error(
                "Player fallback send failed:",
                fallbackError
            );

            return null;
        }
    }
}

/* =========================================================
   TEMPORARY MESSAGE
========================================================= */

async function sendTemporaryMessage(
    channel,
    content,
    timeout = 5000
) {

    if (!channel) {
        return null;
    }

    try {

        const message =
            await channel.send({
                content
            });

        setTimeout(
            () => {

                message.delete()
                    .catch(() => {});

            },
            timeout
        );

        return message;

    } catch (error) {

        return null;
    }
}

/* =========================================================
   CLEAN COLLECTOR
========================================================= */

function stopPlayerCollector(
    guildId
) {

    const collector =
        playerCollectors.get(
            guildId
        );

    if (collector) {

        try {
            collector.stop(
                "player_replaced"
            );
        } catch (_) {}

        playerCollectors.delete(
            guildId
        );
    }
}

/* =========================================================
   CLEAN PREVIOUS TRACK MESSAGES
========================================================= */

async function cleanupPreviousTrackMessages(
    channel,
    guildId
) {

    const messages =
        guildTrackMessages.get(
            guildId
        ) || [];

    for (const info of messages) {

        try {

            const targetChannel =
                channel?.client?.channels?.cache?.get(
                    info.channelId
                );

            if (!targetChannel) {
                continue;
            }

            const message =
                await targetChannel.messages
                    .fetch(
                        info.messageId
                    )
                    .catch(
                        () => null
                    );

            if (message) {

                await message.delete()
                    .catch(() => {});
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

    clearProgressUpdates(
        guildId
    );
}

/* =========================================================
   CLEAN ALL PLAYER MESSAGES
========================================================= */

async function cleanupTrackMessages(
    client,
    player
) {

    const guildId =
        player?.guildId;

    if (!guildId) {
        return;
    }

    clearTrackMediaCache(
        guildId
    );

    clearProgressUpdates(
        guildId
    );

    stopPlayerCollector(
        guildId
    );

    const messages =
        guildTrackMessages.get(
            guildId
        ) || [];

    for (const info of messages) {

        try {

            const channel =
                client.channels.cache.get(
                    info.channelId
                );

            if (!channel) {
                continue;
            }

            const message =
                await channel.messages
                    .fetch(
                        info.messageId
                    )
                    .catch(
                        () => null
                    );

            if (message) {

                await message.delete()
                    .catch(() => {});
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

    guildActiveFilter.delete(
        guildId
    );
}

/* =========================================================
   THUMBNAIL
========================================================= */

function getTrackThumbnail(
    track
) {

    let thumbnail =
        track?.info?.thumbnail ||
        null;

    const uri =
        track?.info?.uri ||
        "";

    if (
        !thumbnail &&
        uri
    ) {

        const youtubeMatch =
            uri.match(
                /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?/]+)/
            );

        if (youtubeMatch) {

            thumbnail =
                `https://img.youtube.com/vi/${youtubeMatch[1]}/hqdefault.jpg`;
        }
    }

    return thumbnail;
}

/* =========================================================
   REQUESTER
========================================================= */

function getTrackRequester(
    track
) {

    if (!track?.info) {
        return "Unknown";
    }

    return (
        requesters.get(
            track.info.uri
        ) ||
        track.info.requester ||
        "Unknown"
    );
}

/* =========================================================
   REGISTER TRACK MESSAGE
========================================================= */

function registerTrackMessage(
    guildId,
    message
) {

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
                message.channelId,

            type:
                "track"
        });

    nowPlayingMessages.set(
        guildId,
        {
            messageId:
                message.id,

            channelId:
                message.channelId,

            trackUri:
                null
        }
    );
}

/* =========================================================
   REFRESH NOW PLAYING
========================================================= */

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
        getPlayer(
            client,
            guildId
        );

    if (
        !isValidPlayer(player) ||
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

    const message =
        await channel.messages
            .fetch(
                stored.messageId
            )
            .catch(
                () => null
            );

    if (!message) {

        nowPlayingMessages.delete(
            guildId
        );

        clearProgressUpdates(
            guildId
        );

        return;
    }

    const track =
        player.current;

    const trackUri =
        track.info?.uri;

    const requester =
        getTrackRequester(
            track
        );

    const total =
        Number(
            track.info?.length
        ) || 1;

    const position =
        Math.max(
            0,
            Number(
                player.position
            ) || 0
        );

    const progress =
        Math.min(
            100,
            Math.round(
                (
                    position /
                    total
                ) * 100
            )
        );

    const cached =
        getTrackMediaCache(
            guildId,
            trackUri
        );

    let thumbnail =
        cached?.mediaUrl ||
        track.info?.thumbnail ||
        null;

    if (
        thumbnail &&
        thumbnail.startsWith(
            "attachment://"
        )
    ) {

        thumbnail =
            track.info?.thumbnail ||
            null;
    }

    const progressBar =
        config.showProgressBar !== false
            ? createProgressBar(
                position,
                total
            )
            : null;

    const embed =
        buildNowPlayingEmbed(
            track,
            requester,
            {},
            progressBar,
            progress,
            thumbnail,
            {
                paused:
                    player.paused,

                loop:
                    player.loop,

                queueLength:
                    player.queue?.length || 0
            }
        );

    const actionRows =
        buildPlayerActionRows(
            player.paused,
            player.loop,
            guildActiveFilter.get(
                guildId
            ) || null
        );

    await message.edit({
        embeds: [
            embed
        ],

        components: [
            actionRows.playbackRow,
            actionRows.manageRow,
            actionRows.filterRow
        ]
    }).catch(() => {});
}

/* =========================================================
   PROGRESS UPDATES
========================================================= */

function startProgressUpdates(
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

    clearProgressUpdates(
        guildId
    );

    const messageId =
        message.id;

    const channelId =
        message.channelId;

    const trackUri =
        track.info.uri;

    const interval =
        setInterval(
            async () => {

                try {

                    const currentPlayer =
                        getPlayer(
                            client,
                            guildId
                        );

                    if (
                        !currentPlayer ||
                        currentPlayer !== player ||
                        player.destroyed
                    ) {

                        clearInterval(
                            interval
                        );

                        if (
                            progressUpdateIntervals.get(
                                guildId
                            ) === interval
                        ) {

                            progressUpdateIntervals.delete(
                                guildId
                            );
                        }

                        return;
                    }

                    const stored =
                        nowPlayingMessages.get(
                            guildId
                        );

                    if (
                        !stored ||
                        stored.messageId !==
                            messageId
                    ) {

                        clearInterval(
                            interval
                        );

                        if (
                            progressUpdateIntervals.get(
                                guildId
                            ) === interval
                        ) {

                            progressUpdateIntervals.delete(
                                guildId
                            );
                        }

                        return;
                    }

                    if (
                        !player.current ||
                        player.current.info?.uri !==
                            trackUri
                    ) {

                        clearInterval(
                            interval
                        );

                        if (
                            progressUpdateIntervals.get(
                                guildId
                            ) === interval
                        ) {

                            progressUpdateIntervals.delete(
                                guildId
                            );
                        }

                        return;
                    }

                    const channel =
                        client.channels.cache.get(
                            channelId
                        );

                    if (!channel) {
                        return;
                    }

                    const msg =
                        await channel.messages
                            .fetch(
                                messageId
                            )
                            .catch(
                                () => null
                            );

                    if (!msg) {

                        clearInterval(
                            interval
                        );

                        if (
                            progressUpdateIntervals.get(
                                guildId
                            ) === interval
                        ) {

                            progressUpdateIntervals.delete(
                                guildId
                            );
                        }

                        return;
                    }

                    const position =
                        Math.max(
                            0,
                            Number(
                                player.position
                            ) || 0
                        );

                    const total =
                        Math.max(
                            1,
                            Number(
                                track.info.length
                            ) || 1
                        );

                    const progress =
                        Math.min(
                            100,
                            Math.round(
                                (
                                    position /
                                    total
                                ) * 100
                            )
                        );

                    const progressBar =
                        config.showProgressBar !== false
                            ? createProgressBar(
                                position,
                                total
                            )
                            : null;

                    const requester =
                        getTrackRequester(
                            track
                        );

                    const cached =
                        getTrackMediaCache(
                            guildId,
                            trackUri
                        );

                    let thumbnail =
                        cached?.mediaUrl ||
                        track.info?.thumbnail ||
                        null;

                    if (
                        thumbnail &&
                        thumbnail.startsWith(
                            "attachment://"
                        )
                    ) {

                        thumbnail =
                            track.info?.thumbnail ||
                            null;
                    }

                    const embed =
                        buildNowPlayingEmbed(
                            track,
                            requester,
                            {},
                            progressBar,
                            progress,
                            thumbnail,
                            {
                                paused:
                                    player.paused,

                                loop:
                                    player.loop,

                                queueLength:
                                    player.queue?.length || 0
                            }
                        );

                    const actionRows =
                        buildPlayerActionRows(
                            player.paused,
                            player.loop,
                            guildActiveFilter.get(
                                guildId
                            ) || null
                        );

                    await msg.edit({
                        embeds: [
                            embed
                        ],

                        components: [
                            actionRows.playbackRow,
                            actionRows.manageRow,
                            actionRows.filterRow
                        ]
                    }).catch(() => {});

                } catch (error) {

                    console.error(
                        "Progress update error:",
                        error.message
                    );

                    clearInterval(
                        interval
                    );

                    if (
                        progressUpdateIntervals.get(
                            guildId
                        ) === interval
                    ) {

                        progressUpdateIntervals.delete(
                            guildId
                        );
                    }
                }

            },
            15000
        );

    return interval;
}

/* =========================================================
   INITIALIZE PLAYER
========================================================= */

async function initializePlayer(
    client
) {

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

    /* =====================================================
       PLAYER CREATE
    ===================================================== */

    client.riffy.on(
        "playerCreate",
        (player) => {

            try {
                patchVoiceChannelIdSupport(
                    player
                );
            } catch (error) {

                console.error(
                    "Player create patch error:",
                    error
                );
            }
        }
    );

    /* =====================================================
       TRACK EXCEPTION
    ===================================================== */

    client.riffy.on(
        "trackException",
        async (
            player,
            error
        ) => {

            const guildId =
                player?.guildId;

            console.error(
                `[ LAVALINK ] Track Exception for guild ${guildId}:`,
                error?.message ||
                "Unknown error"
            );

            if (!guildId) {
                return;
            }

            const channel =
                client.channels.cache.get(
                    player?.textChannel
                );

            if (channel) {

                const embed =
                    new EmbedBuilder()
                        .setColor(
                            0xED4245
                        )
                        .setTitle(
                            "⚠️ Track Error"
                        )
                        .setDescription(
                            "Failed to load the current track.\n\n" +
                            "Skipping to the next song..."
                        );

                await channel.send({
                    embeds: [
                        embed
                    ]
                })
                    .then(
                        (msg) => {

                            setTimeout(
                                () => {

                                    msg.delete()
                                        .catch(
                                            () => {}
                                        );

                                },
                                5000
                            );
                        }
                    )
                    .catch(
                        () => {}
                    );
            }

            clearProgressUpdates(
                guildId
            );

            if (
                isValidPlayer(
                    player
                )
            ) {

                try {
                    player.stop();
                } catch (_) {}
            }
        }
    );

    /* =====================================================
       TRACK STUCK
    ===================================================== */

    client.riffy.on(
        "trackStuck",
        async (
            player,
            error
        ) => {

            console.warn(
                `[ LAVALINK ] Track stuck in guild ${player?.guildId}:`,
                error?.message ||
                "Unknown error"
            );

            if (
                player &&
                player.guildId
            ) {

                clearProgressUpdates(
                    player.guildId
                );
            }

            if (
                isValidPlayer(
                    player
                )
            ) {

                try {
                    player.stop();
                } catch (_) {}
            }
        }
    );

    /* =====================================================
       TRACK START
    ===================================================== */

    client.riffy.on(
        "trackStart",
        async (
            player,
            track
        ) => {

            try {

                if (
                    !track ||
                    !track.info
                ) {
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
                    getPlayer(
                        client,
                        player.guildId
                    );

                if (
                    !currentPlayer ||
                    currentPlayer !== player ||
                    player.destroyed
                ) {
                    return;
                }

                const guildId =
                    player.guildId;

                const channel =
                    client.channels.cache.get(
                        player.textChannel
                    );

                if (!channel) {
                    return;
                }

                /* =========================================
                   HISTORY
                ========================================= */

                try {

                    await playlistCollection.updateOne(
                        {
                            guildId,
                            name:
                                "__HISTORY__"
                        },
                        {
                            $push: {
                                songs: {
                                    $each: [
                                        track.info.uri
                                    ],

                                    $slice:
                                        -100
                                }
                            },

                            $setOnInsert: {
                                guildId,

                                name:
                                    "__HISTORY__"
                            }
                        },
                        {
                            upsert:
                                true
                        }
                    );

                } catch (error) {

                    console.warn(
                        "History update failed:",
                        error.message
                    );
                }

                /* =========================================
                   REMOVE PREVIOUS PLAYER
                ========================================= */

                await cleanupPreviousTrackMessages(
                    channel,
                    guildId
                );

                clearProgressUpdates(
                    guildId
                );

                /* =========================================
                   REQUESTER
                ========================================= */

                const requester =
                    getTrackRequester(
                        track
                    );

                /* =========================================
                   THUMBNAIL
                ========================================= */

                const thumbnailURL =
                    getTrackThumbnail(
                        track
                    );

                const trackURI =
                    track.info.uri ||
                    "";

                /* =========================================
                   GENERATED CARD
                ========================================= */

                let cardBuffer =
                    null;

                let attachment =
                    null;

                if (
                    useGeneratedSongCard
                ) {

                    try {

                        const generated =
                            await musicCard.generateCard({
                                thumbnailURL:
                                    thumbnailURL ||
                                    trackURI,

                                trackURI,

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
                            });

                        if (
                            generated &&
                            generated.length > 0
                        ) {

                            cardBuffer =
                                generated;

                            attachment =
                                new AttachmentBuilder(
                                    generated,
                                    {
                                        name:
                                            "song-banner.png"
                                    }
                                );
                        }

                    } catch (error) {

                        console.warn(
                            "Music card generation failed:",
                            error.message
                        );
                    }
                }

                /* =========================================
                   LANGUAGE
                ========================================= */

                const lang =
                    await getLang(
                        guildId
                    ).catch(
                        () => ({
                            console: {
                                player: {}
                            }
                        })
                    );

                const t =
                    lang?.console?.player ||
                    {};

                /* =========================================
                   EMBED
                ========================================= */

                const progressBar =
                    config.showProgressBar !== false
                        ? createProgressBar(
                            0,
                            track.info.length ||
                                1
                        )
                        : null;

                const embed =
                    buildNowPlayingEmbed(
                        track,
                        requester,
                        t,
                        progressBar,
                        0,
                        thumbnailURL,
                        {
                            paused:
                                player.paused,

                            loop:
                                player.loop,

                            queueLength:
                                player.queue?.length ||
                                0
                        }
                    );

                /* =========================================
                   BUTTONS
                ========================================= */

                const actionRows =
                    buildPlayerActionRows(
                        player.paused,
                        player.loop,
                        guildActiveFilter.get(
                            guildId
                        ) || null
                    );

                /* =========================================
                   SEND
                ========================================= */

                const message =
                    await sendPlayerMessage(
                        channel,
                        embed,
                        [
                            actionRows.playbackRow,
                            actionRows.manageRow,
                            actionRows.filterRow
                        ],
                        null
                    );

                if (!message) {

                    console.error(
                        `Failed to send player for guild ${guildId}`
                    );

                    return;
                }

                /* =========================================
                   CACHE
                ========================================= */

                setTrackMediaCache(
                    guildId,
                    trackURI,
                    thumbnailURL,
                    cardBuffer
                );

                /* =========================================
                   STORE MESSAGE
                ========================================= */

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

                        trackUri:
                            trackURI
                    }
                );

                /* =========================================
                   PROGRESS
                ========================================= */

                const interval =
                    startProgressUpdates(
                        client,
                        guildId,
                        message,
                        player,
                        track
                    );

                replaceProgressInterval(
                    guildId,
                    interval
                );

                /* =========================================
                   COLLECTOR
                ========================================= */

                setupCollector(
                    client,
                    player,
                    channel,
                    message
                );

            } catch (error) {

                console.error(
                    "trackStart handler error:",
                    error
                );
            }
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

            clearProgressUpdates(
                guildId
            );

            clearTrackMediaCache(
                guildId
            );

            const channel =
                client.channels.cache.get(
                    player.textChannel
                );

            if (!channel) {
                return;
            }

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

    /* =====================================================
       PLAYER DISCONNECT
    ===================================================== */

    client.riffy.on(
        "playerDisconnect",
        async (
            player
        ) => {

            if (!player?.guildId) {
                return;
            }

            const guildId =
                player.guildId;

            clearProgressUpdates(
                guildId
            );

            clearTrackMediaCache(
                guildId
            );

            await cleanupTrackMessages(
                client,
                player
            );
        }
    );

    /* =====================================================
       QUEUE END
    ===================================================== */

    client.riffy.on(
        "queueEnd",
        async (
            player
        ) => {

            if (!player?.guildId) {
                return;
            }

            const guildId =
                player.guildId;

            const channel =
                client.channels.cache.get(
                    player.textChannel
                );

            clearProgressUpdates(
                guildId
            );

            clearTrackMediaCache(
                guildId
            );

            if (!channel) {
                return;
            }

            try {

                const settings =
                    await autoplayCollection
                        .findOne({
                            guildId
                        })
                        .catch(
                            () => null
                        );

                const is24_7 =
                    Boolean(
                        settings?.twentyfourseven
                    );

                /* =========================================
                   AUTOPLAY
                ========================================= */

                if (
                    settings?.autoplay
                ) {

                    await cleanupPreviousTrackMessages(
                        channel,
                        guildId
                    );

                    if (
                        !isValidPlayer(
                            player
                        )
                    ) {
                        return;
                    }

                    let nextTrack =
                        null;

                    try {

                        nextTrack =
                            await player.autoplay(
                                player
                            );

                    } catch (error) {

                        console.error(
                            "Autoplay error:",
                            error
                        );
                    }

                    if (!nextTrack) {

                        await cleanupTrackMessages(
                            client,
                            player
                        );

                        if (!is24_7) {

                            try {
                                player.destroy();
                            } catch (_) {}

                            await sendTemporaryMessage(
                                channel,
                                "⚠️ **No more tracks to autoplay. Disconnecting...**"
                            );

                        } else {

                            await sendTemporaryMessage(
                                channel,
                                "🔄 **24/7 Mode: Bot will stay in the voice channel. Queue is empty.**"
                            );
                        }
                    }

                    return;
                }

                /* =========================================
                   NORMAL QUEUE END
                ========================================= */

                await cleanupTrackMessages(
                    client,
                    player
                );

                if (!is24_7) {

                    try {
                        player.destroy();
                    } catch (_) {}

                    await sendTemporaryMessage(
                        channel,
                        "🎶 **Queue has ended. Autoplay is disabled.**"
                    );

                } else {

                    await sendTemporaryMessage(
                        channel,
                        "🔄 **24/7 Mode: Bot will stay in the voice channel. Queue is empty.**"
                    );
                }

            } catch (error) {

                console.error(
                    "Queue end error:",
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
                        })
                        .catch(
                            () => null
                        );

                if (
                    !settings?.twentyfourseven &&
                    isValidPlayer(player)
                ) {

                    try {
                        player.destroy();
                    } catch (_) {}
                }
            }
        }
    );
}

/* =========================================================
   BUTTON COLLECTOR
========================================================= */

function setupCollector(
    client,
    player,
    channel,
    message
) {

    if (
        !player ||
        !message
    ) {
        return null;
    }

    const guildId =
        player.guildId;

    stopPlayerCollector(
        guildId
    );

    const collector =
        message.createMessageComponentCollector({
            filter:
                (interaction) =>
                    PLAYER_COMPONENT_IDS.has(
                        interaction.customId
                    ),

            time:
                30 * 60 * 1000
        });

    playerCollectors.set(
        guildId,
        collector
    );

    collector.on(
        "collect",
        async (
            interaction
        ) => {

            try {

                if (
                    !interaction.inGuild()
                ) {

                    await interaction.reply({
                        content:
                            "❌ This control can only be used inside a server.",

                        ephemeral:
                            true
                    }).catch(
                        () => {}
                    );

                    return;
                }

                const currentPlayer =
                    getPlayer(
                        client,
                        guildId
                    );

                if (
                    !currentPlayer ||
                    currentPlayer !== player ||
                    player.destroyed
                ) {

                    await interaction.reply({
                        content:
                            "❌ **This music player is no longer active.**",

                        ephemeral:
                            true
                    }).catch(
                        () => {}
                    );

                    return;
                }

                const member =
                    interaction.member;

                const voiceChannel =
                    member?.voice?.channel;

                const playerChannel =
                    player.voiceChannel;

                if (
                    !voiceChannel ||
                    !playerChannel ||
                    voiceChannel.id !==
                        playerChannel
                ) {

                    await interaction.reply({
                        content:
                            "🔒 **You need to be in the same voice channel as the bot to use these controls.**",

                        ephemeral:
                            true
                    }).catch(
                        () => {}
                    );

                    return;
                }

                /* =========================================
                   ADD SONG
                ========================================= */

                if (
                    interaction.customId ===
                    "player_add_song"
                ) {

                    await interaction.showModal(
                        createAddSongModal()
                    ).catch(
                        () => {}
                    );

                    if (
                        interaction.replied ||
                        interaction.deferred
                    ) {
                        return;
                    }

                    const modal =
                        await interaction
                            .awaitModalSubmit({
                                filter:
                                    (m) =>
                                        m.customId ===
                                            "player_modal_addsong" &&
                                        m.user.id ===
                                            interaction.user.id,

                                time:
                                    60000
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

                /* =========================================
                   VOLUME
                ========================================= */

                if (
                    interaction.customId ===
                    "player_volume"
                ) {

                    await interaction.showModal(
                        createVolumeModal(
                            player.volume
                        )
                    ).catch(
                        () => {}
                    );

                    const modal =
                        await interaction
                            .awaitModalSubmit({
                                filter:
                                    (m) =>
                                        m.customId ===
                                            "player_modal_volume" &&
                                        m.user.id ===
                                            interaction.user.id,

                                time:
                                    60000
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

                /* =========================================
                   SAVE SONG
                ========================================= */

                if (
                    interaction.customId ===
                    "player_save_song"
                ) {

                    await interaction.showModal(
                        createSaveSongModal()
                    ).catch(
                        () => {}
                    );

                    const modal =
                        await interaction
                            .awaitModalSubmit({
                                filter:
                                    (m) =>
                                        m.customId ===
                                            "player_modal_save_song" &&
                                        m.user.id ===
                                            interaction.user.id,

                                time:
                                    60000
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

                /* =========================================
                   NORMAL COMPONENT
                ========================================= */

                if (
                    !interaction.deferred &&
                    !interaction.replied
                ) {

                    await interaction.deferUpdate()
                        .catch(
                            () => {}
                        );
                }

                await handleInteraction(
                    client,
                    interaction,
                    player,
                    channel
                );

            } catch (error) {

                console.error(
                    "Player component error:",
                    error
                );

                if (
                    !interaction.replied &&
                    !interaction.deferred
                ) {

                    await interaction.reply({
                        content:
                            "⚠️ **Something went wrong while processing this control.**",

                        ephemeral:
                            true
                    }).catch(
                        () => {}
                    );
                }
            }
        }
    );

    collector.on(
        "end",
        () => {

            if (
                playerCollectors.get(
                    guildId
                ) === collector
            ) {

                playerCollectors.delete(
                    guildId
                );
            }
        }
    );

    return collector;
}

/* =========================================================
   INTERACTION HANDLER
========================================================= */

async function handleInteraction(
    client,
    interaction,
    player,
    channel
) {

    switch (
        interaction.customId
    ) {

        /* =============================================
           LOOP
        ============================================= */

        case "loopToggle": {

            if (
                !isValidPlayer(
                    player
                )
            ) {
                return;
            }

            await toggleLoop(
                player,
                channel
            );

            await refreshNowPlayingPanel(
                client,
                player.guildId
            );

            break;
        }

        /* =============================================
           SKIP
        ============================================= */

        case "skipTrack": {

            if (
                !isValidPlayer(
                    player
                )
            ) {
                return;
            }

            clearProgressUpdates(
                player.guildId
            );

            try {
                player.stop();
            } catch (error) {

                console.error(
                    "Skip error:",
                    error
                );
            }

            await sendTemporaryMessage(
                channel,
                "⏭️ **Skipping to next song...**"
            );

            break;
        }

        /* =============================================
           STOP
        ============================================= */

        case "stopTrack": {

            if (
                !isValidPlayer(
                    player
                )
            ) {
                return;
            }

            await cleanupTrackMessages(
                client,
                player
            );

            try {
                player.stop();
            } catch (_) {}

            try {
                player.destroy();
            } catch (_) {}

            await sendTemporaryMessage(
                channel,
                "⏹️ **Playback stopped.**"
            );

            break;
        }

        /* =============================================
           PLAY / PAUSE
        ============================================= */

        case "togglePlayback": {

            if (
                !isValidPlayer(
                    player
                ) ||
                !player.current
            ) {

                await sendTemporaryMessage(
                    channel,
                    "❌ **Player is not available.**"
                );

                return;
            }

            try {

                if (player.paused) {

                    player.pause(false);

                    await sendTemporaryMessage(
                        channel,
                        "▶️ **Playback resumed.**"
                    );

                } else {

                    player.pause(true);

                    await sendTemporaryMessage(
                        channel,
                        "⏸️ **Playback paused.**"
                    );
                }

                await refreshNowPlayingPanel(
                    client,
                    player.guildId
                );

            } catch (error) {

                console.error(
                    "Playback toggle error:",
                    error
                );

                await sendTemporaryMessage(
                    channel,
                    "⚠️ **Unable to change playback state.**"
                );
            }

            break;
        }

        /* =============================================
           FAVORITE
        ============================================= */

        case "player_favorite": {

            try {

                const current =
                    player.current?.info;

                if (!current?.uri) {

                    await sendTemporaryMessage(
                        channel,
                        "❌ **No active song to favorite.**"
                    );

                    return;
                }

                const userId =
                    interaction.user.id;

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

                /* =====================================
                   LEGACY FAVORITES
                ===================================== */

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
                            legacy;
                    }
                }

                /* =====================================
                   CREATE
                ===================================== */

                if (!existing) {

                    await playlistCollection.insertOne({
                        name:
                            playlistName,

                        songs: [],

                        isPrivate:
                            true,

                        userId,

                        serverId,

                        serverName
                    });
                }

                /* =====================================
                   ADD
                ===================================== */

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

                await sendTemporaryMessage(
                    channel,
                    "⭐ **Added to Favorites.**"
                );

            } catch (error) {

                console.error(
                    "Favorite error:",
                    error
                );

                await sendTemporaryMessage(
                    channel,
                    "⚠️ **Failed to add favorite.**"
                );
            }

            break;
        }

        /* =============================================
           FILTER
        ============================================= */

        case "player_filter_select": {

            const selected =
                interaction.values?.[0];

            if (!selected) {
                return;
            }

            /* =====================================
               CLEAR FILTER
            ===================================== */

            if (
                selected ===
                "__clear__"
            ) {

                try {

                    player.filters.clearFilters();

                } catch (error) {

                    console.error(
                        "Clear filters error:",
                        error
                    );
                }

                guildActiveFilter.delete(
                    player.guildId
                );

                await refreshNowPlayingPanel(
                    client,
                    player.guildId
                );

                await sendTemporaryMessage(
                    channel,
                    "🧹 **Filters cleared.**"
                );

                break;
            }

            /* =====================================
               APPLY FILTER
            ===================================== */

            const applied =
                await applyFilterByKey(
                    player,
                    selected
                );

            if (!applied) {

                await sendTemporaryMessage(
                    channel,
                    "⚠️ **Invalid filter.**"
                );

                break;
            }

            guildActiveFilter.set(
                player.guildId,
                selected
            );

            await refreshNowPlayingPanel(
                client,
                player.guildId
            );

            await sendTemporaryMessage(
                channel,
                `🎛️ **Filter applied:** ${selected}`
            );

            break;
        }

        /* =============================================
           QUEUE
        ============================================= */

        case "player_queue": {

            if (
                !player?.queue?.length
            ) {

                await sendTemporaryMessage(
                    channel,
                    "📭 **Queue is empty.**"
                );

                break;
            }

            const preview =
                player.queue
                    .slice(0, 10)
                    .map(
                        (
                            item,
                            index
                        ) =>
                            `${index + 1}. ${item.info?.title || "Unknown title"}`
                    )
                    .join("\n");

            const remaining =
                Math.max(
                    0,
                    player.queue.length - 10
                );

            const description =
                remaining > 0
                    ? `${preview}\n\n*...and ${remaining} more.*`
                    : preview;

            const embed =
                new EmbedBuilder()
                    .setColor(
                        0x5865F2
                    )
                    .setTitle(
                        "📋 Upcoming Queue"
                    )
                    .setDescription(
                        description
                    );

            try {

                const message =
                    await channel.send({
                        embeds: [
                            embed
                        ]
                    });

                if (
                    config.embedTimeout
                ) {

                    setTimeout(
                        () => {

                            message.delete()
                                .catch(
                                    () => {}
                                );

                        },
                        Number(
                            config.embedTimeout
                        ) * 1000
                    );
                }

            } catch (error) {

                console.error(
                    "Queue message error:",
                    error
                );
            }

            break;
        }

        /* =============================================
           SHUFFLE
        ============================================= */

        case "player_shuffle": {

            if (
                !player?.queue ||
                player.queue.length < 2
            ) {

                await sendTemporaryMessage(
                    channel,
                    "🔀 **Need at least 2 songs in the queue to shuffle.**"
                );

                break;
            }

            try {

                player.queue.shuffle();

                await refreshNowPlayingPanel(
                    client,
                    player.guildId
                );

                await sendTemporaryMessage(
                    channel,
                    "🔀 **Queue shuffled.**"
                );

            } catch (error) {

                console.error(
                    "Queue shuffle error:",
                    error
                );

                await sendTemporaryMessage(
                    channel,
                    "⚠️ **Unable to shuffle the queue.**"
                );
            }

            break;
        }
    }
}

/* =========================================================
   MODAL HANDLER
========================================================= */

async function handlePlayerModalSubmit(
    client,
    modal,
    player,
    channel
) {

    if (
        !modal ||
        !player ||
        !channel
    ) {
        return;
    }

    await modal.deferReply({
        ephemeral:
            true
    }).catch(
        () => {}
    );

    try {

        /* =============================================
           ADD SONG
        ============================================= */

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
                        "❌ Please enter a song name or URL."
                });

                return;
            }

            if (
                !isValidPlayer(
                    player
                )
            ) {

                await modal.editReply({
                    content:
                        "❌ The music player is no longer active."
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
                        "❌ No results found."
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

                    if (
                        track.info.uri
                    ) {

                        requesters.set(
                            track.info.uri,
                            modal.user.username
                        );
                    }

                    added++;
                }

            } else {

                const track =
                    resolve.tracks[0];

                if (
                    !track?.info
                ) {

                    await modal.editReply({
                        content:
                            "❌ Unable to load that track."
                    });

                    return;
                }

                track.info.requester =
                    modal.user.username;

                player.queue.add(
                    track
                );

                if (
                    track.info.uri
                ) {

                    requesters.set(
                        track.info.uri,
                        modal.user.username
                    );
                }

                added = 1;
            }

            if (
                !player.playing &&
                !player.paused &&
                !player.current
            ) {

                player.play();
            }

            await modal.editReply({
                content:
                    `✅ Added ${added} track${added === 1 ? "" : "s"} to the queue.`
            });

            return;
        }

        /* =============================================
           VOLUME
        ============================================= */

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
                        "❌ Volume must be between 1 and 100."
                });

                return;
            }

            if (
                !isValidPlayer(
                    player
                )
            ) {

                await modal.editReply({
                    content:
                        "❌ The player is no longer active."
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
                    `🔊 Volume set to **${volume}%**.`
            });

            return;
        }

        /* =============================================
           SAVE SONG
        ============================================= */

        if (
            modal.customId ===
            "player_modal_save_song"
        ) {

            const current =
                player.current?.info;

            if (!current?.uri) {

                await modal.editReply({
                    content:
                        "❌ No active song."
                });

                return;
            }

            const rawName =
                modal.fields
                    .getTextInputValue(
                        "playlistName"
                    )
                    ?.trim();

            const playlistName =
                rawName?.slice(
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

                    songs: [],

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
                    `💾 Saved to **${playlistName}**.`
            });

            return;
        }

    } catch (error) {

        console.error(
            "Player modal error:",
            error
        );

        await modal.editReply({
            content:
                "⚠️ Failed to process this action."
        }).catch(
            () => {}
        );
    }
}

/* =========================================================
   VOLUME HELPER
========================================================= */

async function adjustVolume(
    player,
    channel,
    amount
) {

    if (
        !isValidPlayer(
            player
        )
    ) {
        return;
    }

    const current =
        Number(
            player.volume
        ) || 100;

    const newVolume =
        Math.min(
            100,
            Math.max(
                1,
                current + amount
            )
        );

    if (
        newVolume ===
        current
    ) {

        await sendTemporaryMessage(
            channel,
            amount > 0
                ? "🔊 **Volume is already at maximum.**"
                : "🔉 **Volume is already at minimum.**"
        );

        return;
    }

    player.setVolume(
        newVolume
    );

    await sendTemporaryMessage(
        channel,
        `🔊 **Volume changed to ${newVolume}%**`
    );
}

/* =========================================================
   LOOP
========================================================= */

async function toggleLoop(
    player,
    channel
) {

    if (
        !isValidPlayer(
            player
        )
    ) {
        return;
    }

    const current =
        player.loop ||
        "none";

    const next =
        current === "none"
            ? "track"
            : current === "track"
                ? "queue"
                : "none";

    try {

        player.setLoop(
            next
        );

    } catch (error) {

        console.error(
            "Loop error:",
            error
        );

        await sendTemporaryMessage(
            channel,
            "⚠️ **Unable to change loop mode.**"
        );

        return;
    }

    if (
        next === "track"
    ) {

        await sendTemporaryMessage(
            channel,
            "🔂 **Track loop activated.**"
        );

    } else if (
        next === "queue"
    ) {

        await sendTemporaryMessage(
            channel,
            "🔁 **Queue loop activated.**"
        );

    } else {

        await sendTemporaryMessage(
            channel,
            "❌ **Loop disabled.**"
        );
    }
}

/* =========================================================
   FILTERS
========================================================= */

async function applyFilterByKey(
    player,
    selectedFilter
) {

    if (
        !isValidPlayer(
            player
        ) ||
        !player.filters
    ) {
        return false;
    }

    try {

        switch (
            selectedFilter
        ) {

            case "karaoke":

                player.filters
                    .setKaraoke(
                        true
                    );

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
                                1
                        }
                    );

                break;

            case "daycore":

                player.filters
                    .setTimescale(
                        true,
                        {
                            speed:
                                1,

                            pitch:
                                0.8,

                            rate:
                                1
                        }
                    );

                break;

            default:

                return false;
        }

        return true;

    } catch (error) {

        console.error(
            `Filter "${selectedFilter}" error:`,
            error
        );

        return false;
    }
}

/* =========================================================
   LYRICS API
========================================================= */

async function getLyrics(
    trackName,
    artistName,
    duration
) {

    try {

        trackName =
            String(
                trackName || ""
            )
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
            String(
                artistName || ""
            )
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

/* =========================================================
   SHOW LYRICS
========================================================= */

async function showLyrics(
    channel,
    player
) {

    if (
        !player ||
        !player.current ||
        !player.current.info
    ) {

        await sendTemporaryMessage(
            channel,
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
                (
                    track.length ||
                    0
                ) / 1000
            )
        );

    if (!lyrics) {

        await sendTemporaryMessage(
            channel,
            "❌ **Lyrics not found.**"
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

    let description =
        lines
            .slice(0, 30)
            .join("\n");

    if (
        description.length >
        4000
    ) {

        description =
            description.slice(
                0,
                3997
            ) +
            "...";
    }

    const embed =
        new EmbedBuilder()
            .setColor(
                0x5865F2
            )
            .setTitle(
                `🎵 ${track.title}`
            )
            .setDescription(
                description
            );

    const row =
        new ActionRowBuilder()
            .addComponents(

                new ButtonBuilder()
                    .setCustomId(
                        "deleteLyrics"
                    )
                    .setLabel(
                        "Delete"
                    )
                    .setStyle(
                        ButtonStyle.Danger
                    )
            );

    let message;

    try {

        message =
            await channel.send({
                embeds: [
                    embed
                ],

                components: [
                    row
                ]
            });

    } catch (error) {

        console.error(
            "Lyrics send error:",
            error
        );

        return;
    }

    if (
        !guildTrackMessages.has(
            player.guildId
        )
    ) {

        guildTrackMessages.set(
            player.guildId,
            []
        );
    }

    guildTrackMessages
        .get(player.guildId)
        .push({
            messageId:
                message.id,

            channelId:
                channel.id,

            type:
                "lyrics"
        });

    const collector =
        message.createMessageComponentCollector({
            time:
                300000
        });

    collector.on(
        "collect",
        async (
            interaction
        ) => {

            if (
                interaction.customId !==
                "deleteLyrics"
            ) {
                return;
            }

            await interaction.deferUpdate()
                .catch(
                    () => {}
                );

            await message.delete()
                .catch(
                    () => {}
                );

            collector.stop(
                "deleted"
            );
        }
    );

    collector.on(
        "end",
        (
            _collected,
            reason
        ) => {

            if (
                reason !==
                "deleted"
            ) {

                message.delete()
                    .catch(
                        () => {}
                    );
            }

            const messages =
                guildTrackMessages.get(
                    player.guildId
                ) || [];

            guildTrackMessages.set(
                player.guildId,
                messages.filter(
                    (item) =>
                        item.messageId !==
                        message.id
                )
            );
        }
    );
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
    initializePlayer,
    cleanupTrackMessages,
    refreshNowPlayingPanel,
    showLyrics
};
