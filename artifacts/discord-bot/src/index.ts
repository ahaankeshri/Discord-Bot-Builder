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

interface Warning {
  remainingMs: number;
  label: string;
  color: number;
  beepFreq: number;
}

interface ExamConfig {
  examName: string;
  durationMs: number;
  startMessage: string;
  warnings: Warning[];
}

const MCQ_CONFIG: ExamConfig = {
  examName: 'APUSH MCQ',
  durationMs: 55 * 60 * 1000,
  startMessage: '55 minute timer starts now',
  warnings: [
    { remainingMs: 20 * 60 * 1000, label: '20 minutes', color: 0xf59e0b, beepFreq: 660 },
    { remainingMs: 10 * 60 * 1000, label: '10 minutes', color: 0xf97316, beepFreq: 770 },
    { remainingMs:  5 * 60 * 1000, label: '5 minutes',  color: 0xef4444, beepFreq: 880 },
  ],
};

const SAQ_CONFIG: ExamConfig = {
  examName: 'APUSH SAQ',
  durationMs: 40 * 60 * 1000,
  startMessage: '40 minute timer starts now',
  warnings: [
    { remainingMs: 20 * 60 * 1000, label: '20 minutes', color: 0xf59e0b, beepFreq: 660 },
    { remainingMs: 10 * 60 * 1000, label: '10 minutes', color: 0xf97316, beepFreq: 770 },
    { remainingMs:  2 * 60 * 1000, label: '2 minutes',  color: 0xef4444, beepFreq: 880 },
  ],
};

const LAQ_CONFIG: ExamConfig = {
  examName: 'APUSH LAQ',
  durationMs: 100 * 60 * 1000,
  startMessage: '1 hour 40 minute timer starts now',
  warnings: [
    { remainingMs: 60 * 60 * 1000, label: '60 minutes', color: 0x3b82f6, beepFreq: 550 },
    { remainingMs: 40 * 60 * 1000, label: '40 minutes', color: 0xf59e0b, beepFreq: 660 },
    { remainingMs: 20 * 60 * 1000, label: '20 minutes', color: 0xf97316, beepFreq: 770 },
    { remainingMs: 10 * 60 * 1000, label: '10 minutes', color: 0xef4444, beepFreq: 880 },
    { remainingMs:  2 * 60 * 1000, label: '2 minutes',  color: 0xb91c1c, beepFreq: 980 },
  ],
};

function formatDurationLabel(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  return `${minutes} min ${seconds} sec`;
}

function formatDurationSpeech(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes} minute timer starts now`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (mins === 0) return `${hours} hour timer starts now`;
  return `${hours} hour ${mins} minute timer starts now`;
}

function buildAdminTimerConfig(totalMinutes: number): ExamConfig {
  const durationMs = totalMinutes * 60 * 1000;
  const halfMs = Math.floor(durationMs / 2);

  const candidates: Warning[] = [
    { remainingMs: halfMs,         label: formatDurationLabel(halfMs), color: 0x3b82f6, beepFreq: 550 },
    { remainingMs: 5 * 60 * 1000,  label: '5 minutes',                 color: 0xf97316, beepFreq: 770 },
    { remainingMs: 2 * 60 * 1000,  label: '2 minutes',                 color: 0xef4444, beepFreq: 880 },
  ];

  const seen = new Set<number>();
  const warnings: Warning[] = [];

  for (const w of candidates) {
    if (w.remainingMs <= 0 || w.remainingMs >= durationMs) continue;
    if (seen.has(w.remainingMs)) continue;
    seen.add(w.remainingMs);
    warnings.push(w);
  }

  return {
    examName: 'Custom',
    durationMs,
    startMessage: formatDurationSpeech(totalMinutes),
    warnings,
  };
}

interface ActiveSession {
  interval: ReturnType<typeof setInterval>;
  connection: VoiceConnection | null;
  examName: string;
}

const activeSessions = new Map<string, ActiveSession>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const apushMcqCommand = new SlashCommandBuilder()
  .setName('apush-mcq')
  .setDescription('Start a 55-minute APUSH MCQ exam timer with audio warnings at 20, 10, and 5 minutes');

const apushSaqCommand = new SlashCommandBuilder()
  .setName('apush-saq')
  .setDescription('Start a 40-minute APUSH SAQ exam timer with audio warnings at 20, 10, and 2 minutes');

const apushLaqCommand = new SlashCommandBuilder()
  .setName('apush-laq')
  .setDescription('Start a 1hr 40min APUSH LAQ exam timer with audio warnings at 60, 40, 20, 10, and 2 minutes');

const adminTimerCommand = new SlashCommandBuilder()
  .setName('admin-timer')
  .setDescription('Start a custom timer with reminders at halfway, 5 minutes, and 2 minutes')
  .addIntegerOption(option =>
    option
      .setName('minutes')
      .setDescription('Total timer duration in minutes')
      .setRequired(true)
      .setMinValue(3)
      .setMaxValue(600),
  );

const examCancelCommand = new SlashCommandBuilder()
  .setName('exam-cancel')
  .setDescription('Cancel the currently running exam timer and disconnect the bot');

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
  warning: Warning,
  endTimeUnix: number,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(warning.color)
    .setTitle('⏰ Exam Timer Warning')
    .setDescription(`**${warning.label} remaining** on your exam!\n\n⏳ **Ends:** <t:${endTimeUnix}:R>`)
    .setTimestamp();

  await channel.send({ embeds: [embed] });

  if (connection) {
    await playBeep(connection, warning.beepFreq, 2);
    await speakText(connection, `${warning.label} remaining`);
  }
}

function endSession(guildId: string): void {
  const session = activeSessions.get(guildId);
  if (!session) return;
  clearInterval(session.interval);
  if (session.connection) {
    try { session.connection.destroy(); } catch { /* ignore */ }
  }
  activeSessions.delete(guildId);
  client.user?.setActivity(undefined);
}

async function runTimer(
  interaction: ChatInputCommandInteraction,
  connection: VoiceConnection | null,
  config: ExamConfig,
): Promise<void> {
  const guildId = interaction.guildId!;
  const channel = interaction.channel as TextChannel;
  const endTime = Date.now() + config.durationMs;
  const endTimeUnix = Math.floor(endTime / 1000);
  const totalMinutes = Math.round(config.durationMs / 60000);
  const warningsLeft = [...config.warnings].sort((a, b) => b.remainingMs - a.remainingMs);

  const warningBullets = config.warnings
    .slice()
    .sort((a, b) => b.remainingMs - a.remainingMs)
    .map(w => `• ${w.label} remaining`)
    .join('\n');

  const startEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📝 ${config.examName} Timer Started`)
    .setDescription(
      `Your **${totalMinutes}-minute** exam timer has begun!\n\n⏳ **Ends:** <t:${endTimeUnix}:R> (at <t:${endTimeUnix}:t>)\n\nYou will receive audio warnings at:\n${warningBullets}\n\nRun \`/exam-cancel\` to stop the timer early.`,
    )
    .setTimestamp();

  await channel.send({ embeds: [startEmbed] });

  if (connection) {
    await speakText(connection, config.startMessage);
  }

  const checkInterval = setInterval(async () => {
    const remaining = endTime - Date.now();

    if (remaining <= 0) {
      activeSessions.delete(guildId);
      clearInterval(checkInterval);

      const doneEmbed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Time is Up!')
        .setDescription(`Your **${totalMinutes}-minute** ${config.examName} timer has ended. Pencils down!`)
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
      await sendWarning(channel, connection, nextWarning, endTimeUnix);
    }
  }, 5000);

  activeSessions.set(guildId, { interval: checkInterval, connection, examName: config.examName });
}

async function handleExamCommand(
  interaction: ChatInputCommandInteraction,
  config: ExamConfig,
): Promise<void> {
  const guildId = interaction.guildId!;

  if (activeSessions.has(guildId)) {
    await interaction.reply({
      content: '❌ An exam timer is already running! Use `/exam-cancel` to stop it first.',
      ephemeral: true,
    });
    return;
  }

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
      guildId: guildId,
      adapterCreator: interaction.guild!.voiceAdapterCreator,
    });

    connection.on('error', (err) => {
      console.error('Voice connection error (non-fatal):', err.message);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      endSession(guildId);
    });

    const totalMinutes = Math.round(config.durationMs / 60000);
    await interaction.editReply(
      `✅ Joined **${voiceChannel.name}** — starting your ${totalMinutes}-minute ${config.examName} timer!`,
    );
    await runTimer(interaction, connection, config);

  } catch (err) {
    console.error('Voice connection failed, falling back to text-only mode:', (err as Error).message);

    if (connection) {
      try { connection.destroy(); } catch { /* ignore */ }
      connection = null;
    }

    try {
      await interaction.editReply(
        `❌ Could not connect to **${voiceChannel.name}** for audio.\n` +
        `Make sure the bot has **Connect** and **Speak** permissions in that channel.`,
      );
    } catch (e) {
      console.error('Failed to send error reply:', e);
    }
  }
}

client.once('clientReady', async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  console.log(`Bot is in ${c.guilds.cache.size} server(s)`);
  c.user.setActivity('APUSH Exam Timer', { type: ActivityType.Watching });

  const rest = new REST({ version: '10' }).setToken(token!);
  const appId = c.application.id;

  try {
    await rest.put(Routes.applicationCommands(appId), { body: [] });
    console.log('✅ Cleared all global commands');
  } catch (err) {
    console.error('Failed to clear global commands:', err);
  }

  const commands = [
    apushMcqCommand.toJSON(),
    apushSaqCommand.toJSON(),
    apushLaqCommand.toJSON(),
    adminTimerCommand.toJSON(),
    examCancelCommand.toJSON(),
  ];

  for (const guild of c.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: commands });
      console.log(`✅ Commands registered in guild: ${guild.name} (${guild.id})`);
    } catch (err) {
      console.error(`Failed to register commands in guild ${guild.name}:`, err);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  console.log(`Interaction received: ${interaction.type} — ${interaction.isChatInputCommand() ? interaction.commandName : 'non-command'}`);
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'exam-cancel') {
    const guildId = interaction.guildId!;
    const session = activeSessions.get(guildId);

    if (!session) {
      await interaction.reply({ content: '❌ No exam timer is currently running.', ephemeral: true });
      return;
    }

    endSession(guildId);

    const cancelEmbed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('🛑 Exam Timer Cancelled')
      .setDescription(`The **${session.examName}** timer has been cancelled.`)
      .setTimestamp();

    await interaction.reply({ embeds: [cancelEmbed] });
    return;
  }

  if (interaction.commandName === 'apush-mcq') {
    await handleExamCommand(interaction, MCQ_CONFIG);
    return;
  }

  if (interaction.commandName === 'apush-saq') {
    await handleExamCommand(interaction, SAQ_CONFIG);
    return;
  }

  if (interaction.commandName === 'apush-laq') {
    await handleExamCommand(interaction, LAQ_CONFIG);
    return;
  }

  if (interaction.commandName === 'admin-timer') {
    const minutes = interaction.options.getInteger('minutes', true);
    const config = buildAdminTimerConfig(minutes);
    await handleExamCommand(interaction, config);
    return;
  }
});

client.login(token);
