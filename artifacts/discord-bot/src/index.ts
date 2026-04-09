import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  TextChannel,
  EmbedBuilder,
  ActivityType,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnection,
  entersState,
  VoiceConnectionStatus,
  StreamType,
} from '@discordjs/voice';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('Missing DISCORD_BOT_TOKEN environment variable');
  process.exit(1);
}

const EXAM_DURATION_MS = 55 * 60 * 1000;
const WARNINGS: { remainingMs: number; label: string; color: number }[] = [
  { remainingMs: 20 * 60 * 1000, label: '20 minutes', color: 0xf59e0b },
  { remainingMs: 10 * 60 * 1000, label: '10 minutes', color: 0xf97316 },
  { remainingMs: 5 * 60 * 1000, label: '5 minutes', color: 0xef4444 },
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const command = new SlashCommandBuilder()
  .setName('apwh-exam')
  .setDescription('Join your voice channel and start a 55-minute APWH exam timer with audio warnings');

async function playBeep(connection: VoiceConnection, frequency = 880, durationSec = 2): Promise<void> {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      console.error('ffmpeg-static not found, skipping audio');
      resolve();
      return;
    }

    const ffmpeg = spawn(ffmpegPath, [
      '-f', 'lavfi',
      '-i', `sine=frequency=${frequency}:duration=${durationSec}`,
      '-ar', '48000',
      '-ac', '2',
      '-f', 's16le',
      'pipe:1',
    ]);

    const player = createAudioPlayer();
    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      metadata: { title: 'beep' },
    });

    connection.subscribe(player);
    player.play(resource);

    player.once(AudioPlayerStatus.Idle, () => resolve());
    player.once('error', () => resolve());

    setTimeout(() => {
      player.stop(true);
      resolve();
    }, (durationSec + 1) * 1000);
  });
}

async function sendWarning(
  channel: TextChannel,
  connection: VoiceConnection,
  label: string,
  color: number,
  frequency: number,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('⏰ Exam Timer Warning')
    .setDescription(`**${label} remaining** on your APWH exam!`)
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  await playBeep(connection, frequency, 2);
}

async function runExamTimer(
  interaction: ChatInputCommandInteraction,
  connection: VoiceConnection,
): Promise<void> {
  const channel = interaction.channel as TextChannel;
  const startTime = Date.now();
  const endTime = startTime + EXAM_DURATION_MS;

  const warningsLeft = [...WARNINGS].sort((a, b) => b.remainingMs - a.remainingMs);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📝 APWH Exam Timer Started')
    .setDescription('Your **55-minute** exam timer has begun!\n\nYou will receive audio warnings at:\n• 20 minutes remaining\n• 10 minutes remaining\n• 5 minutes remaining')
    .setTimestamp();

  await channel.send({ embeds: [embed] });

  await playBeep(connection, 523, 1);

  const checkInterval = setInterval(async () => {
    const now = Date.now();
    const remaining = endTime - now;

    if (remaining <= 0) {
      clearInterval(checkInterval);

      const doneEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Time is Up!')
        .setDescription('Your **55-minute** APWH exam timer has ended. Pencils down!')
        .setTimestamp();

      await channel.send({ embeds: [doneEmbed] });
      await playBeep(connection, 392, 3);

      setTimeout(() => {
        connection.destroy();
        client.user?.setActivity(undefined);
      }, 3000);
      return;
    }

    const nextWarning = warningsLeft[0];
    if (nextWarning && remaining <= nextWarning.remainingMs) {
      warningsLeft.shift();
      const freq = nextWarning.remainingMs === 20 * 60 * 1000 ? 660
        : nextWarning.remainingMs === 10 * 60 * 1000 ? 770
        : 880;
      await sendWarning(channel, connection, nextWarning.label, nextWarning.color, freq);
    }
  }, 5000);
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  client.user?.setActivity('APWH Exam Timer', { type: ActivityType.Watching });

  const rest = new REST({ version: '10' }).setToken(token!);
  try {
    await rest.put(
      Routes.applicationCommands(client.application!.id),
      { body: [command.toJSON()] },
    );
    console.log('Slash command /apwh-exam registered globally');
    console.log('Note: Global commands may take up to 1 hour to appear in servers.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'apwh-exam') return;

  const member = interaction.member as GuildMember;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({
      content: '❌ You need to be in a voice channel first!',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId!,
      adapterCreator: interaction.guild!.voiceAdapterCreator,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

    await interaction.editReply(`✅ Joined **${voiceChannel.name}** and starting your 55-minute exam timer!`);

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      try { connection.destroy(); } catch { /* ignore */ }
    });

    await runExamTimer(interaction, connection);
  } catch (err) {
    console.error('Error starting exam timer:', err);
    await interaction.editReply('❌ Failed to join voice channel or start timer. Make sure I have the correct permissions!');
  }
});

client.login(token);
