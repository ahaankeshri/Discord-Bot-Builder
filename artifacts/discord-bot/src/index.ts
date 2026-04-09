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
  { remainingMs: 5 * 60 * 1000,  label: '5 minutes',  color: 0xef4444 },
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const command = new SlashCommandBuilder()
  .setName('examtimer')
  .setDescription('Join your voice channel and start a 55-minute APWH exam timer with audio warnings');

async function speakText(connection: VoiceConnection, text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve(); return; }

    try {
      const espeak = spawn('espeak-ng', [text, '--stdout', '-s', '140', '-p', '50']);
      const ffmpeg = spawn(ffmpegPath, [
        '-f', 's16le', '-ar', '22050', '-ac', '1', '-i', 'pipe:0',
        '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1',
      ]);

      espeak.stdout.pipe(ffmpeg.stdin);
      espeak.on('error', (e) => { console.error('espeak error:', e); resolve(); });
      ffmpeg.on('error', (e) => { console.error('ffmpeg error:', e); resolve(); });

      const player = createAudioPlayer();
      const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });

      player.on('error', () => resolve());
      player.once(AudioPlayerStatus.Idle, () => resolve());

      connection.subscribe(player);
      player.play(resource);

      setTimeout(() => { try { player.stop(true); } catch { /* ignore */ } resolve(); }, 12000);
    } catch (e) {
      console.error('speakText error:', e);
      resolve();
    }
  });
}

async function playBeep(connection: VoiceConnection, frequency = 880, durationSec = 2): Promise<void> {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve(); return; }

    try {
      const ffmpeg = spawn(ffmpegPath, [
        '-f', 'lavfi',
        '-i', `sine=frequency=${frequency}:duration=${durationSec}`,
        '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1',
      ]);

      ffmpeg.on('error', (e) => { console.error('ffmpeg beep error:', e); resolve(); });

      const player = createAudioPlayer();
      const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        metadata: { title: 'beep' },
      });

      player.on('error', () => resolve());
      player.once(AudioPlayerStatus.Idle, () => resolve());

      connection.subscribe(player);
      player.play(resource);

      setTimeout(() => { try { player.stop(true); } catch { /* ignore */ } resolve(); }, (durationSec + 2) * 1000);
    } catch (e) {
      console.error('playBeep error:', e);
      resolve();
    }
  });
}

async function sendWarning(
  channel: TextChannel,
  connection: VoiceConnection | null,
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

  if (connection) {
    await playBeep(connection, frequency, 2);
    await speakText(connection, `${label} remaining`);
  }
}

async function runTimer(
  interaction: ChatInputCommandInteraction,
  connection: VoiceConnection | null,
): Promise<void> {
  const channel = interaction.channel as TextChannel;
  const endTime = Date.now() + EXAM_DURATION_MS;
  const warningsLeft = [...WARNINGS].sort((a, b) => b.remainingMs - a.remainingMs);

  const startEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📝 APWH Exam Timer Started')
    .setDescription(
      'Your **55-minute** exam timer has begun!\n\nYou will receive warnings at:\n• 20 minutes remaining\n• 10 minutes remaining\n• 5 minutes remaining' +
      (connection ? '' : '\n\n⚠️ *Voice unavailable — warnings will be sent here as text.*'),
    )
    .setTimestamp();

  await channel.send({ embeds: [startEmbed] });

  if (connection) {
    await speakText(connection, '55 minute timer starts now');
  }

  const checkInterval = setInterval(async () => {
    const remaining = endTime - Date.now();

    if (remaining <= 0) {
      clearInterval(checkInterval);

      const doneEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Time is Up!')
        .setDescription('Your **55-minute** APWH exam timer has ended. Pencils down!')
        .setTimestamp();

      await channel.send({ embeds: [doneEmbed] });

      if (connection) {
        await playBeep(connection, 392, 3);
        setTimeout(() => {
          try { connection.destroy(); } catch { /* ignore */ }
          client.user?.setActivity(undefined);
        }, 4000);
      }
      return;
    }

    const nextWarning = warningsLeft[0];
    if (nextWarning && remaining <= nextWarning.remainingMs) {
      warningsLeft.shift();
      const freq =
        nextWarning.remainingMs === 20 * 60 * 1000 ? 660 :
        nextWarning.remainingMs === 10 * 60 * 1000 ? 770 : 880;
      await sendWarning(channel, connection, nextWarning.label, nextWarning.color, freq);
    }
  }, 5000);
}

client.once('clientReady', async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Bot is in ${c.guilds.cache.size} server(s)`);
  c.user.setActivity('APWH Exam Timer', { type: ActivityType.Watching });

  const rest = new REST({ version: '10' }).setToken(token!);
  const appId = c.application.id;

  for (const guild of c.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guild.id), {
        body: [command.toJSON()],
      });
      console.log(`✅ /examtimer registered in guild: ${guild.name} (${guild.id})`);
    } catch (err) {
      console.error(`Failed to register command in guild ${guild.name}:`, err);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  console.log(`Interaction received: ${interaction.type} — ${interaction.isChatInputCommand() ? interaction.commandName : 'non-command'}`);
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'examtimer') return;

  const member = interaction.member as GuildMember;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: '❌ You need to be in a voice channel first!', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  let connection: VoiceConnection | null = null;

  try {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId!,
      adapterCreator: interaction.guild!.voiceAdapterCreator,
    });

    connection.on('error', (err) => {
      console.error('Voice connection error (non-fatal):', err.message);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      try { connection?.destroy(); } catch { /* ignore */ }
    });

    await interaction.editReply(`✅ Joined **${voiceChannel.name}** — starting your 55-minute APWH exam timer!`);
    await runTimer(interaction, connection);

  } catch (err) {
    console.error('Voice connection failed, falling back to text-only mode:', (err as Error).message);

    if (connection) {
      try { connection.destroy(); } catch { /* ignore */ }
      connection = null;
    }

    try {
      await interaction.editReply(
        `⚠️ Could not join **${voiceChannel.name}** (voice may be unavailable in this environment).\n` +
        `Running timer in **text-only mode** — you'll receive warnings here instead.`,
      );
      await runTimer(interaction, null);
    } catch (e) {
      console.error('Failed to send fallback reply:', e);
    }
  }
});

client.login(token);
