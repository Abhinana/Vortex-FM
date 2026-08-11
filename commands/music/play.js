// ================================
// RIFFY VOICE CONNECTION
// ================================

const voiceChannel = interaction.member?.voice?.channel;

if (!voiceChannel) {
    return interaction.editReply({
        content: "❌ You must join a voice channel first."
    });
}

const nodeManager = getLavalinkManager();

if (!nodeManager || !nodeManager.riffy) {
    return interaction.editReply({
        content: "❌ Lavalink is not ready. Please try again in a few seconds."
    });
}

const riffy = nodeManager.riffy;
const guildId = interaction.guild.id;

// ================================
// GET / CREATE PLAYER
// ================================

let player = riffy.players.get(guildId);

if (!player || player.destroyed) {
    try {
        player = riffy.createConnection({
            guildId: guildId,
            voiceChannel: voiceChannel.id,
            textChannel: interaction.channel.id,
            deaf: true
        });

        console.log(
            `[ RIFFY ] Created voice connection: ${guildId} -> ${voiceChannel.id}`
        );

    } catch (error) {
        console.error(
            "[ RIFFY ] Failed to create voice connection:",
            error
        );

        return interaction.editReply({
            content:
                `❌ Failed to connect to the voice channel.\n` +
                `\`${error.message}\``
        });
    }
}

if (!player || player.destroyed) {
    return interaction.editReply({
        content: "❌ Riffy could not create the music player."
    });
}

// ================================
// RESOLVE TRACK
// ================================

const resolve = await riffy.resolve({
    query: query,
    requester: interaction.user.username
});

if (
    !resolve ||
    !Array.isArray(resolve.tracks) ||
    resolve.tracks.length === 0
) {
    return interaction.editReply({
        content: "❌ No results found."
    });
}

// ================================
// ADD TRACK
// ================================

if (resolve.loadType === "playlist") {

    for (const track of resolve.tracks) {
        if (!track?.info) continue;

        track.info.requester = interaction.user.username;

        player.queue.add(track);

        if (track.info.uri) {
            requesters.set(
                track.info.uri,
                interaction.user.username
            );
        }
    }

} else {

    const track = resolve.tracks[0];

    if (!track?.info) {
        return interaction.editReply({
            content: "❌ Unable to load this track."
        });
    }

    track.info.requester = interaction.user.username;

    player.queue.add(track);

    if (track.info.uri) {
        requesters.set(
            track.info.uri,
            interaction.user.username
        );
    }
}

// ================================
// START PLAYBACK
// ================================

if (
    !player.playing &&
    !player.paused &&
    !player.current
) {
    try {
        await player.play();

    } catch (error) {
        console.error(
            "[ RIFFY ] Playback error:",
            error
        );

        return interaction.editReply({
            content:
                `❌ Voice connection was not established.\n` +
                `\`${error.message}\``
        });
    }
}
