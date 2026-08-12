const {
    SlashCommandBuilder,
    MessageFlags
} = require("discord.js");

const { getLavalinkManager } = require("../../lavalink.js");

// ============================================================
// REQUESTER MAP
// player.js imports this:
//
// const { requesters } = require("./commands/music/play");
// ============================================================

const requesters = new Map();


// ============================================================
// COMMAND
// ============================================================

const data = new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song or add it to the queue.")
    .addStringOption(option =>
        option
            .setName("query")
            .setDescription("Song name, YouTube URL, Spotify URL, etc.")
            .setRequired(true)
    );


// ============================================================
// EXECUTE
// ============================================================

async function execute(interaction) {

    // --------------------------------------------------------
    // GUILD CHECK
    // --------------------------------------------------------

    if (!interaction.guild) {
        return interaction.reply({
            content: "❌ This command can only be used inside a server.",
            flags: MessageFlags.Ephemeral
        });
    }


    // --------------------------------------------------------
    // VOICE CHANNEL CHECK
    // --------------------------------------------------------

    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
        return interaction.reply({
            content: "❌ You must join a voice channel first.",
            flags: MessageFlags.Ephemeral
        });
    }


    // --------------------------------------------------------
    // GET QUERY
    // --------------------------------------------------------

    const query = interaction.options
        .getString("query", true)
        .trim();

    if (!query) {
        return interaction.reply({
            content: "❌ Please provide a song name or URL.",
            flags: MessageFlags.Ephemeral
        });
    }


    // --------------------------------------------------------
    // DEFER
    // --------------------------------------------------------

    await interaction.deferReply();


    try {

        // ====================================================
        // GET LAVALINK MANAGER
        // ====================================================

        const nodeManager = getLavalinkManager();

        if (!nodeManager || !nodeManager.riffy) {

            return interaction.editReply({
                content:
                    "❌ Lavalink is not ready yet.\n" +
                    "Please wait a few seconds and try again."
            });
        }

        const riffy = nodeManager.riffy;

        const guildId = interaction.guild.id;
        const textChannelId = interaction.channel.id;
        const voiceChannelId = voiceChannel.id;


        // ====================================================
        // GET EXISTING PLAYER
        // ====================================================

        let player = riffy.players.get(guildId);


        // ====================================================
        // CREATE VOICE CONNECTION
        // ====================================================

        if (!player || player.destroyed) {

            console.log(
                `[ RIFFY ] Creating player for guild ${guildId}`
            );

            console.log(
                `[ RIFFY ] Voice channel: ${voiceChannelId}`
            );

            try {

                player = riffy.createConnection({
                    guildId: guildId,
                    voiceChannel: voiceChannelId,
                    textChannel: textChannelId,
                    deaf: true
                });

                console.log(
                    `[ RIFFY ] Voice connection created: ` +
                    `${guildId} -> ${voiceChannelId}`
                );

            } catch (error) {

                console.error(
                    "[ RIFFY ] Failed to create voice connection:",
                    error
                );

                return interaction.editReply({
                    content:
                        "❌ Failed to connect to the voice channel.\n\n" +
                        `\`${error?.message || error}\``
                });
            }
        }


        // ====================================================
        // SAFETY CHECK
        // ====================================================

        if (!player || player.destroyed) {

            return interaction.editReply({
                content:
                    "❌ Riffy could not create the music player."
            });
        }


        // ====================================================
        // MAKE SURE PLAYER IS IN THE CORRECT VC
        // ====================================================

        if (
            player.voiceChannel &&
            player.voiceChannel !== voiceChannelId
        ) {

            return interaction.editReply({
                content:
                    "❌ I am already playing music in another voice channel."
            });
        }


        // ====================================================
        // RESOLVE TRACK
        // ====================================================

        console.log(
            `[ RIFFY ] Resolving: ${query}`
        );

        let resolve;

        try {

            resolve = await riffy.resolve({
                query: query,
                requester: interaction.user.username
            });

        } catch (error) {

            console.error(
                "[ RIFFY ] Resolve error:",
                error
            );

            return interaction.editReply({
                content:
                    "❌ Failed to search for that song.\n\n" +
                    `\`${error?.message || error}\``
            });
        }


        // ====================================================
        // NO RESULTS
        // ====================================================

        if (
            !resolve ||
            !Array.isArray(resolve.tracks) ||
            resolve.tracks.length === 0
        ) {

            return interaction.editReply({
                content:
                    "❌ No results found for that query."
            });
        }


        // ====================================================
        // ADD TRACKS
        // ====================================================

        let addedTracks = 0;

        // ----------------------------------------------------
        // PLAYLIST
        // ----------------------------------------------------

        if (
            resolve.loadType === "playlist" ||
            resolve.loadType === "search"
                ? false
                : false
        ) {

            for (const track of resolve.tracks) {

                if (!track?.info) {
                    continue;
                }

                track.info.requester =
                    interaction.user.username;

                player.queue.add(track);

                if (track.info.uri) {

                    requesters.set(
                        track.info.uri,
                        interaction.user.username
                    );
                }

                addedTracks++;
            }

        } else {

            // ------------------------------------------------
            // SINGLE TRACK
            // ------------------------------------------------

            const track = resolve.tracks[0];

            if (!track?.info) {

                return interaction.editReply({
                    content:
                        "❌ Unable to load that track."
                });
            }

            track.info.requester =
                interaction.user.username;

            player.queue.add(track);

            if (track.info.uri) {

                requesters.set(
                    track.info.uri,
                    interaction.user.username
                );
            }

            addedTracks = 1;
        }


        // ====================================================
        // MAKE SURE SOMETHING WAS ADDED
        // ====================================================

        if (addedTracks === 0) {

            return interaction.editReply({
                content:
                    "❌ No playable tracks were found."
            });
        }


        // ====================================================
        // START PLAYBACK
        // ====================================================

        if (
            !player.playing &&
            !player.paused &&
            !player.current
        ) {

            console.log(
                `[ RIFFY ] Starting playback for guild ${guildId}`
            );

            try {

                await player.play();

                console.log(
                    `[ RIFFY ] Playback started: ${guildId}`
                );

            } catch (error) {

                console.error(
                    "[ RIFFY ] Playback error:",
                    error
                );

                return interaction.editReply({
                    content:
                        "❌ The track was added, but playback could not be started.\n\n" +
                        `\`${error?.message || error}\``
                });
            }
        }


        // ====================================================
        // RESPONSE
        // ====================================================

        const currentTrack =
            player.current || player.queue[0];

        if (
            addedTracks === 1 &&
            currentTrack?.info
        ) {

            const title =
                currentTrack.info.title ||
                "Unknown Title";

            const author =
                currentTrack.info.author ||
                "Unknown Artist";

            const isPlaying =
                player.current &&
                player.playing;

            if (isPlaying) {

                await interaction.editReply({
                    content:
                        `🎵 **Now playing**\n` +
                        `**${title}**\n` +
                        `by ${author}\n\n` +
                        `👤 Requested by ${interaction.user}`
                });

            } else {

                await interaction.editReply({
                    content:
                        `✅ Added to queue: **${title}**\n` +
                        `by ${author}`
                });
            }

        } else {

            await interaction.editReply({
                content:
                    `✅ Added **${addedTracks} tracks** to the queue.`
            });
        }

    } catch (error) {

        console.error(
            "[ PLAY COMMAND ] Unexpected error:",
            error
        );

        try {

            if (interaction.deferred) {

                await interaction.editReply({
                    content:
                        "❌ Something went wrong while trying to play the song.\n\n" +
                        `\`${error?.message || error}\``
                });

            } else {

                await interaction.reply({
                    content:
                        "❌ Something went wrong while trying to play the song.",
                    flags: MessageFlags.Ephemeral
                });
            }

        } catch (replyError) {

            console.error(
                "[ PLAY COMMAND ] Failed to send error response:",
                replyError
            );
        }
    }
}


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    data,
    execute,
    requesters
};
