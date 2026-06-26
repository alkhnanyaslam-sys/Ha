require('dotenv').config()
const { Telegraf } = require('telegraf')
const { exec }    = require('child_process')
const path        = require('path')
const fs          = require('fs')

const bot      = new Telegraf(process.env.BOT_TOKEN)
const ADMIN_ID = Number(process.env.ADMIN_ID)

const SOURCES = {
  mecca: {
    name: '🕋 الحرم المكي',
    type: 'stream',
    url:  'http://n07.radiojar.com/0tpy1h0kxtzuv',
    img:  'mecca.png'
  },
  cairo: {
    name: '📻 إذاعة القرآن الكريم من القاهرة',
    type: 'stream',
    url:  'https://stream.radiojar.com/8s5u5tpdtwzuv',
    img:  'cairo.png'
  },
  dosari: {
    name: '🎙️ ياسر الدوسري',
    type: 'online',
    base: 'https://server11.mp3quran.net/yasser/',
    img:  'dosari.png'
  },
  abdulbasit: {
    name: '🎙️ عبد الباسط عبد الصمد',
    type: 'online',
    base: 'https://server7.mp3quran.net/basit/',
    img:  'abdulbasit.png'
  },
  minshawi: {
    name: '🎙️ محمد صديق المنشاوي',
    type: 'online',
    base: 'https://server10.mp3quran.net/minsh/',
    img:  'minshawi.png'
  },
  qatami: {
    name: '🎙️ ناصر القطامي',
    type: 'online',
    base: 'https://server8.mp3quran.net/qtm/',
    img:  'qatami.png'
  },
  hussary: {
    name: '🎙️ محمود خليل الحصري',
    type: 'online',
    base: 'https://server13.mp3quran.net/husr/',
    img:  'hussary.png'
  },
  muaiqly: {
    name: '🎙️ ماهر المعيقلي',
    type: 'online',
    base: 'https://server12.mp3quran.net/maher/',
    img:  'muaiqly.png'
  },
  alafasy: {
    name: '🎙️ مشاري راشد العفاسي',
    type: 'online',
    base: 'https://server8.mp3quran.net/afs/',
    img:  'alafasy.png'
  }
}

const CHANNELS = [
  { id: 'ch1', rtmp: process.env.CHANNEL_1_RTMP, key: process.env.CHANNEL_1_KEY, source: process.env.CHANNEL_1_SOURCE || 'mecca'      },
  { id: 'ch2', rtmp: process.env.CHANNEL_2_RTMP, key: process.env.CHANNEL_2_KEY, source: process.env.CHANNEL_2_SOURCE || 'dosari'     },
  { id: 'ch3', rtmp: process.env.CHANNEL_3_RTMP, key: process.env.CHANNEL_3_KEY, source: process.env.CHANNEL_3_SOURCE || 'abdulbasit' },
  { id: 'ch4', rtmp: process.env.CHANNEL_4_RTMP, key: process.env.CHANNEL_4_KEY, source: process.env.CHANNEL_4_SOURCE || 'minshawi'   },
  { id: 'ch5', rtmp: process.env.CHANNEL_5_RTMP, key: process.env.CHANNEL_5_KEY, source: process.env.CHANNEL_5_SOURCE || 'cairo'      },
  { id: 'ch6', rtmp: process.env.CHANNEL_6_RTMP, key: process.env.CHANNEL_6_KEY, source: process.env.CHANNEL_6_SOURCE || 'mecca'      },
].filter(ch => ch.rtmp && ch.key)

const procs        = {}
const retries      = {}
const currentSurah = {}
const MAX_RETRY    = 5

// ─── ملفات محلية ────────────────────────────────────────────────────────────
function getAudioFiles(dir) {
  const fullDir = path.join(__dirname, dir)
  if (!fs.existsSync(fullDir)) return []
  return fs.readdirSync(fullDir)
    .filter(f => /\.(mp3|aac|m4a|opus|flac|wav)$/i.test(f))
    .sort()
    .map(f => path.join(fullDir, f))
}

function buildConcatList(files, chId) {
  const listPath = path.join('/tmp', `concat_${chId}.txt`)
  const repeated = Array(999).fill(files).flat()
  fs.writeFileSync(listPath, repeated.map(f => `file '${f}'`).join('\n'), 'utf8')
  return listPath
}

// ─── بناء videoInput ─────────────────────────────────────────────────────────
function findImg(imgFile) {
  // جرب الاسم كما هو، ثم بحرف أول كبير، ثم كله كبير
  const candidates = [
    imgFile,
    imgFile.charAt(0).toUpperCase() + imgFile.slice(1),
    imgFile.toUpperCase()
  ]
  for (const name of candidates) {
    const p = path.join(__dirname, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

function buildVideoInput(imgFile) {
  const img     = findImg(imgFile)
  const isVideo = /\.(mp4|mkv|avi)$/i.test(imgFile)
  if (!img)    return '-f lavfi -i color=black:s=1280x720:r=25'
  if (isVideo) return `-thread_queue_size 1024 -stream_loop -1 -re -i "${img}"`
  return              `-thread_queue_size 1024 -loop 1 -i "${img}"`
}

// ─── بناء أمر ffmpeg ─────────────────────────────────────────────────────────
function buildFFmpegCmd(src, dest, chId) {

  // ════════════════════════════════════════════════════
  // بث مباشر (راديو) — mecca / cairo
  // ════════════════════════════════════════════════════
  if (src.type === 'stream') {
    const img        = path.join(__dirname, src.img)
    const imgExists  = fs.existsSync(img)
    const isVideo    = /\.(mp4|mkv|avi)$/i.test(src.img)

    // فيديو الخلفية
    const videoInput = !imgExists
      ? '-f lavfi -i color=black:s=1280x720:r=25'
      : isVideo
        ? `-thread_queue_size 1024 -stream_loop -1 -re -i "${img}"`
        : `-thread_queue_size 1024 -loop 1 -i "${img}"`

    // خيارات الصوت المباشر — reconnect ضروري جداً
    const audioOpts = [
      '-thread_queue_size 4096',
      '-reconnect 1',
      '-reconnect_streamed 1',
      '-reconnect_at_eof 1',
      '-reconnect_delay_max 10',
      '-rw_timeout 20000000',
      '-probesize 10M',
      '-analyzeduration 10M'
    ].join(' ')

    return [
      'ffmpeg -y -hide_banner -loglevel error',
      videoInput,
      audioOpts,
      `-i "${src.url}"`,
      '-map 0:v:0 -map 1:a:0',
      '-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p',
      '-vf scale=1280:720,fps=25',
      '-b:v 500k -maxrate 600k -bufsize 1000k -g 50',
      '-c:a aac -b:a 128k -ar 44100 -ac 2',
      '-max_muxing_queue_size 2048',
      `-f flv "${dest}"`
    ].join(' ')
  }

  // ════════════════════════════════════════════════════
  // ملفات محلية
  // ════════════════════════════════════════════════════
  if (src.type === 'files') {
    const files      = getAudioFiles(src.dir)
    const videoInput = buildVideoInput(src.img)

    if (files.length === 0) {
      return [
        'ffmpeg -y -hide_banner -loglevel error',
        videoInput,
        '-f lavfi -i anullsrc=r=44100:cl=stereo',
        '-map 0:v -map 1:a',
        '-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p',
        '-vf scale=1280:720,fps=25',
        '-b:v 500k -g 50',
        '-c:a aac -b:a 128k -ar 44100 -ac 2',
        '-max_muxing_queue_size 1024',
        `-f flv "${dest}"`
      ].join(' ')
    }

    const listPath = buildConcatList(files, chId)
    return [
      'ffmpeg -y -hide_banner -loglevel error',
      videoInput,
      '-thread_queue_size 4096',
      `-f concat -safe 0 -i "${listPath}"`,
      '-map 0:v:0 -map 1:a:0',
      '-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p',
      '-vf scale=1280:720,fps=25',
      '-b:v 500k -maxrate 600k -bufsize 1000k -g 50',
      '-c:a aac -b:a 128k -ar 44100 -ac 2',
      '-async 1 -vsync 1',
      '-max_muxing_queue_size 1024',
      `-f flv "${dest}"`
    ].join(' ')
  }

  // ════════════════════════════════════════════════════
  // سور أونلاين — سورة واحدة في كل مرة
  // ════════════════════════════════════════════════════
  if (src.type === 'online') {
    if (!currentSurah[chId]) currentSurah[chId] = 1
    const num        = String(currentSurah[chId]).padStart(3, '0')
    const url        = `${src.base}${num}.mp3`
    const videoInput = buildVideoInput(src.img)

    return [
      'ffmpeg -y -hide_banner -loglevel error',
      videoInput,
      '-thread_queue_size 4096',
      '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5',
`-re -i "${url}"`,
      '-map 0:v:0 -map 1:a:0',
      '-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p',
      '-vf scale=1280:720,fps=25',
      '-b:v 500k -maxrate 600k -bufsize 1000k -g 50',
      '-c:a aac -b:a 128k -ar 44100 -ac 2',
      '-async 1 -vsync 1',
      '-max_muxing_queue_size 1024',
      `-f flv "${dest}"`
    ].join(' ')
  }

  throw new Error(`نوع مصدر غير معروف: ${src.type}`)
}

// ─── إدارة البث ──────────────────────────────────────────────────────────────
function startStream(ch, sourceKey) {
  const key  = sourceKey || ch.source || 'mecca'
  const src  = SOURCES[key] || SOURCES.mecca
  const dest = `${ch.rtmp}/${ch.key}`

  if (procs[ch.id]) {
    try { procs[ch.id].kill('SIGKILL') } catch(e) {}
    delete procs[ch.id]
  }

  ch.source = key
  if (!retries[ch.id])      retries[ch.id]      = 0
  if (!currentSurah[ch.id]) currentSurah[ch.id] = Math.floor(Math.random() * 114) + 1

  let cmd
  try   { cmd = buildFFmpegCmd(src, dest, ch.id) }
  catch (err) { console.log(`❌ ${ch.id} خطأ: ${err.message}`); return }

  console.log(`▶️  ${ch.id} [${src.name}]${src.type === 'online' ? ` سورة ${currentSurah[ch.id]}` : ''}`)
  const proc = exec(cmd, { shell: '/bin/bash', maxBuffer: 1024 * 1024 * 10 })

  proc.stderr?.on('data', d => {
    const msg = d.toString().trim()
    if (msg) console.log(`⚠️  ${ch.id}: ${msg.substring(0, 300)}`)
  })

  proc.on('exit', (code, signal) => {
    delete procs[ch.id]

    if (src.type === 'online') {
      // روتيت عشوائي دايماً بغض النظر عن كود الخروج
      if (signal !== 'SIGKILL') {
        const next = Math.floor(Math.random() * 114) + 1
        currentSurah[ch.id] = next
        retries[ch.id] = 0
        const delay = code === 0 ? 500 : 2000
        console.log(`🔀 ${ch.id} → سورة ${next} (عشوائي)`)
        setTimeout(() => startStream(ch, ch.source), delay)
      }
    } else if (code !== 0 && signal !== 'SIGKILL') {
      retries[ch.id]++
      const delay = Math.min(retries[ch.id] * 5000, 30000)
      console.log(`🔄 ${ch.id} كود ${code} — محاولة ${retries[ch.id]}/${MAX_RETRY} بعد ${delay/1000}ث`)
      if (retries[ch.id] <= MAX_RETRY) {
        setTimeout(() => startStream(ch, ch.source), delay)
      } else {
        retries[ch.id] = 0
        notifyAdmin(`❌ قناة ${ch.id} فشلت ${MAX_RETRY} مرات — إعادة بعد 5 دقائق`)
        setTimeout(() => startStream(ch, ch.source), 5 * 60 * 1000)
      }
    } else {
      retries[ch.id] = 0
      if (src.type === 'files') {
        setTimeout(() => startStream(ch, ch.source), 2000)
      } else {
        setTimeout(() => startStream(ch, ch.source), 3000)
      }
    }
  })

  procs[ch.id] = proc
  console.log(`🟢 ${ch.id} → ${src.name}`)
}

function startAll() {
  CHANNELS.forEach((ch, i) => setTimeout(() => startStream(ch, ch.source), i * 3000))
}

function stopAll() {
  CHANNELS.forEach(ch => {
    if (procs[ch.id]) {
      try { procs[ch.id].kill('SIGKILL') } catch(e) {}
      delete procs[ch.id]
    }
  })
}

function notifyAdmin(msg) {
  bot.telegram.sendMessage(ADMIN_ID, msg, { parse_mode: 'Markdown' })
    .catch(e => console.log('⚠️  Notify error:', e.message))
}

function getStatus() {
  let txt = `📊 *الحالة:*\n\n`
  CHANNELS.forEach(ch => {
    const src   = SOURCES[ch.source]?.name || '—'
    const extra = SOURCES[ch.source]?.type === 'online' ? ` (سورة ${currentSurah[ch.id] || 1})` : ''
    txt += procs[ch.id] ? `🟢 ${ch.id} — ${src}${extra}\n` : `🔴 ${ch.id} — متوقفة\n`
  })
  txt += `\n⏰ ${Math.floor(process.uptime() / 60)} دقيقة`
  return txt
}

// ─── تشغيل ───────────────────────────────────────────────────────────────────
startAll()

// إعادة تشغيل البث المباشر كل ساعتين
setInterval(() => {
  CHANNELS.forEach((ch, i) => {
    if (SOURCES[ch.source]?.type === 'stream') {
      setTimeout(() => startStream(ch, ch.source), i * 3000)
    }
  })
}, 2 * 60 * 60 * 1000)

setTimeout(() => {
  let msg = `✅ *بدأ البث*\n\n`
  CHANNELS.forEach(ch => { msg += `📡 ${ch.id}: ${SOURCES[ch.source]?.name || '—'}\n` })
  msg += `\n*/status* /list /restart /stop`
  notifyAdmin(msg)
}, 10000)

// ─── أوامر البوت ─────────────────────────────────────────────────────────────
bot.command('set', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  const [, chId, srcKey] = ctx.message.text.split(' ')
  if (!chId || !srcKey || !SOURCES[srcKey]) {
    return ctx.reply(`الاستخدام: /set ch1 mecca\nالمصادر: ${Object.keys(SOURCES).join(' | ')}`)
  }
  const ch = CHANNELS.find(c => c.id === chId)
  if (!ch) return ctx.reply(`❌ القناة ${chId} غير موجودة`)
  currentSurah[chId] = 1
  startStream(ch, srcKey)
  await ctx.reply(`✅ ${chId} → ${SOURCES[srcKey].name}`)
})

bot.command('mecca',      async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'mecca'));      await ctx.reply(`🕋 ${SOURCES.mecca.name}`)      })
bot.command('cairo',      async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'cairo'));      await ctx.reply(`📻 ${SOURCES.cairo.name}`)      })
bot.command('dosari',     async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'dosari'));     await ctx.reply(`🎙️ ${SOURCES.dosari.name}`)     })
bot.command('abdulbasit', async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'abdulbasit')); await ctx.reply(`🎙️ ${SOURCES.abdulbasit.name}`) })
bot.command('minshawi',   async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'minshawi'));   await ctx.reply(`🎙️ ${SOURCES.minshawi.name}`)   })
bot.command('qatami',     async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'qatami'));     await ctx.reply(`🎙️ ${SOURCES.qatami.name}`)     })
bot.command('hussary',    async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'hussary'));    await ctx.reply(`🎙️ ${SOURCES.hussary.name}`)    })
bot.command('muaiqly',    async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'muaiqly'));    await ctx.reply(`🎙️ ${SOURCES.muaiqly.name}`)    })
bot.command('alafasy',    async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'alafasy'));    await ctx.reply(`🎙️ ${SOURCES.alafasy.name}`)    })
bot.command('restart',    async ctx => { if (ctx.from.id !== ADMIN_ID) return; startAll();  await ctx.reply('🔄 جاري إعادة التشغيل...') })
bot.command('stop',       async ctx => { if (ctx.from.id !== ADMIN_ID) return; stopAll();   await ctx.reply('⏹ تم الإيقاف') })

bot.command('status', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  await ctx.replyWithMarkdown(getStatus())
})

bot.command('list', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  let msg = `📋 *المصادر المتاحة:*\n\n`
  for (const [key, src] of Object.entries(SOURCES)) {
    const type = src.type === 'stream' ? 'بث مباشر' : src.type === 'online' ? '114 سورة أونلاين' : `${getAudioFiles(src.dir).length} ملف`
    msg += `• \`${key}\` — ${src.name} (${type})\n`
  }
  await ctx.replyWithMarkdown(msg)
})

bot.launch({ dropPendingUpdates: true })
  .catch(e => console.log('⚠️  Bot launch error:', e.message))

console.log('🤖 Bot running!')

process.once('SIGINT',  () => { stopAll(); bot.stop(); process.exit(0) })
process.once('SIGTERM', () => { stopAll(); bot.stop(); process.exit(0) })
