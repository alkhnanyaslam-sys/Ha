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
  if (!fs.existsSync(fullDir)) {
    console.log(`❌ مجلد الصوت غير موجود: ${fullDir}`)
    return []
  }
  return fs.readdirSync(fullDir)
    .filter(f => /\.(mp3|aac|m4a|opus|flac|wav)$/i.test(f))
    .sort()
    .map(f => path.join(fullDir, f))
}

function buildConcatList(files, chId) {
  const listPath = path.join('/tmp', `concat_${chId}.txt`)
  const repeated = Array(999).fill(files).flat()
  const content  = repeated.map(f => `file '${f}'`).join('\n')
  fs.writeFileSync(listPath, content, 'utf8')
  return listPath
}

// ─── بناء videoInput للصور ──────────────────────────────────────────────────
function buildVideoInput(imgFile) {
  const img     = path.join(__dirname, imgFile)
  const isVideo = /\.(mp4|mkv|avi)$/i.test(imgFile)
  if (!fs.existsSync(img)) {
    return '-f lavfi -i color=black:s=1280x720:r=25'
  }
  if (isVideo) {
    return `-thread_queue_size 1024 -stream_loop -1 -re -i "${img}"`
  }
  // صورة ثابتة — بدون -re لتجنب الشاشة السوداء
  return `-thread_queue_size 1024 -loop 1 -i "${img}"`
}

// ─── بناء أمر ffmpeg ─────────────────────────────────────────────────────────
function buildFFmpegCmd(src, dest, chId) {

  // بث مباشر
  if (src.type === 'stream') {
    const img = path.join(__dirname, src.img)
    const audioInputOpts = [
      '-thread_queue_size 4096',
      '-reconnect 1',
      '-reconnect_streamed 1',
      '-reconnect_at_eof 1',
      '-reconnect_delay_max 5',
      '-rw_timeout 15000000',
      '-probesize 5M',
      '-analyzeduration 5M'
    ].join(' ')

    if (!fs.existsSync(img)) {
      return [
        'ffmpeg -y -hide_banner -loglevel warning',
        '-f lavfi -i color=black:s=1280x720:r=25',
        audioInputOpts,
        `-i "${src.url}"`,
        '-map 0:v:0 -map 1:a:0',
        '-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p',
        '-b:v 800k -maxrate 1000k -bufsize 2000k -g 50',
        '-c:a aac -b:a 128k -ar 44100 -ac 2',
        '-max_muxing_queue_size 1024',
        '-shortest',
        `-f flv "${dest}"`
      ].join(' ')
    }

    const isVideo    = /\.(mp4|mkv|avi)$/i.test(src.img)
    const videoInput = isVideo
      ? `-thread_queue_size 1024 -stream_loop -1 -re -i "${img}"`
      : `-thread_queue_size 1024 -loop 1 -i "${img}"`

    return [
      'ffmpeg -y -hide_banner -loglevel warning',
      videoInput,
      audioInputOpts,
      `-i "${src.url}"`,
      '-map 0:v:0 -map 1:a:0',
      '-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p',
      '-vf scale=1280:720,fps=25',
      '-b:v 800k -minrate 800k -maxrate 800k -bufsize 1600k -g 50',
      '-c:a aac -b:a 128k -ar 44100 -ac 2',
      '-async 1 -vsync 1',
      '-max_muxing_queue_size 1024',
      `-f flv "${dest}"`
    ].join(' ')
  }

  // ملفات محلية
  if (src.type === 'files') {
    const files      = getAudioFiles(src.dir)
    const videoInput = buildVideoInput(src.img)

    if (files.length === 0) {
      console.log(`⚠️ ${chId}: مفيش ملفات صوت في ${src.dir} — بث صامت`)
      return [
        'ffmpeg -y -hide_banner -loglevel warning',
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
      'ffmpeg -y -hide_banner -loglevel warning',
      videoInput,
      '-thread_queue_size 4096',
      `-f concat -safe 0 -i "${listPath}"`,
      '-map 0:v:0 -map 1:a:0',
      '-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p',
      '-vf scale=1280:720,fps=25',
      '-b:v 800k -minrate 800k -maxrate 800k -bufsize 1600k -g 50',
      '-c:a aac -b:a 128k -ar 44100 -ac 2',
      '-async 1 -vsync 1',
      '-max_muxing_queue_size 1024',
      `-f flv "${dest}"`
    ].join(' ')
  }

  // سور أونلاين من mp3quran.net — سورة واحدة في كل مرة
  if (src.type === 'online') {
    if (!currentSurah[chId]) currentSurah[chId] = 1
    const num        = String(currentSurah[chId]).padStart(3, '0')
    const url        = `${src.base}${num}.mp3`
    const videoInput = buildVideoInput(src.img)

    return [
      'ffmpeg -y -hide_banner -loglevel warning',
      videoInput,
      '-thread_queue_size 4096',
      '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5',
      `-i "${url}"`,
      '-map 0:v:0 -map 1:a:0',
      '-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p',
      '-vf scale=1280:720,fps=25',
      '-b:v 800k -minrate 800k -maxrate 800k -bufsize 1600k -g 50',
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
  if (!retries[ch.id]) retries[ch.id] = 0

  // إعادة ضبط السورة لو تغير المصدر
  if (!currentSurah[ch.id]) currentSurah[ch.id] = 1

  let cmd
  try {
    cmd = buildFFmpegCmd(src, dest, ch.id)
  } catch(err) {
    console.log(`❌ ${ch.id} خطأ في بناء الأمر: ${err.message}`)
    return
  }

  console.log(`▶️ ${ch.id} [${src.name}] سورة ${currentSurah[ch.id] || '-'}`)
  const proc = exec(cmd, { shell: '/bin/bash', maxBuffer: 1024 * 1024 * 10 })

  proc.stderr?.on('data', d => {
    const msg = d.toString().trim()
    if (msg) console.log(`⚠️ ${ch.id}: ${msg.substring(0, 300)}`)
  })

  proc.on('exit', (code, signal) => {
    delete procs[ch.id]

    if (code !== 0 && signal !== 'SIGKILL') {
      retries[ch.id]++
      const delay = Math.min(retries[ch.id] * 5000, 30000)
      console.log(`🔄 ${ch.id} خرج بكود ${code} — محاولة ${retries[ch.id]}/${MAX_RETRY} بعد ${delay/1000}ث`)
      if (retries[ch.id] <= MAX_RETRY) {
        setTimeout(() => startStream(ch, ch.source), delay)
      } else {
        retries[ch.id] = 0
        setTimeout(() => startStream(ch, ch.source), 5 * 60 * 1000)
        notifyAdmin(`❌ قناة ${ch.id} فشلت ${MAX_RETRY} مرات\nجاري إعادة المحاولة بعد 5 دقائق`)
      }
    } else {
      retries[ch.id] = 0
      if (src.type === 'online') {
        // روتيت للسورة الجاية
        currentSurah[ch.id] = (currentSurah[ch.id] % 114) + 1
        console.log(`🔁 ${ch.id} → السورة ${currentSurah[ch.id]}`)
        setTimeout(() => startStream(ch, ch.source), 1000)
      } else if (src.type === 'files') {
        console.log(`🔁 ${ch.id} خلصت الملفات، بيعيد من الأول...`)
        setTimeout(() => startStream(ch, ch.source), 2000)
      }
    }
  })

  procs[ch.id] = proc
  console.log(`🟢 ${ch.id} → ${src.name}`)
}

function startAll() {
  CHANNELS.forEach((ch, i) => {
    setTimeout(() => startStream(ch, ch.source), i * 3000)
  })
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
    .catch(err => console.log('⚠️ Notify error:', err.message))
}

function getStatus() {
  let txt = `📊 *الحالة:*\n\n`
  CHANNELS.forEach(ch => {
    const src    = SOURCES[ch.source]?.name || '—'
    const surah  = SOURCES[ch.source]?.type === 'online' ? ` (سورة ${currentSurah[ch.id] || 1})` : ''
    txt += procs[ch.id] ? `🟢 ${ch.id} — ${src}${surah}\n` : `🔴 ${ch.id} — متوقفة\n`
  })
  txt += `\n⏰ وقت التشغيل: ${Math.floor(process.uptime() / 60)} دقيقة`
  return txt
}

// ─── تشغيل ───────────────────────────────────────────────────────────────────
startAll()

setInterval(() => {
  console.log('🔄 Auto-refresh للقنوات المباشرة...')
  CHANNELS.forEach((ch, i) => {
    if (SOURCES[ch.source]?.type === 'stream') {
      setTimeout(() => startStream(ch, ch.source), i * 3000)
    }
  })
}, 2 * 60 * 60 * 1000)

setTimeout(() => {
  let msg = `✅ *بدأ البث*\n\n`
  CHANNELS.forEach(ch => {
    msg += `📡 ${ch.id}: ${SOURCES[ch.source]?.name || '—'}\n`
  })
  msg += `\n*/status* — الحالة`
  msg += `\n*/set ch1 qatami* — تغيير مصدر`
  msg += `\n*/list* — قائمة المصادر`
  notifyAdmin(msg)
}, 10000)

// ─── أوامر البوت ──────────────────────────────────────────────────────────────
bot.command('set', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  const parts = ctx.message.text.split(' ')
  const chId  = parts[1]
  const src   = parts[2]
  if (!chId || !src || !SOURCES[src]) {
    const srcList = Object.keys(SOURCES).join(' | ')
    return ctx.reply(`الاستخدام: /set ch1 mecca\nالمصادر: ${srcList}`)
  }
  const ch = CHANNELS.find(c => c.id === chId)
  if (!ch) return ctx.reply(`❌ القناة ${chId} غير موجودة`)
  currentSurah[chId] = 1
  startStream(ch, src)
  await ctx.reply(`✅ ${chId} → ${SOURCES[src].name}`)
})

bot.command('mecca',      async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'mecca'));      await ctx.reply(`🕋 كل القنوات → ${SOURCES.mecca.name}`)      })
bot.command('cairo',      async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'cairo'));      await ctx.reply(`📻 كل القنوات → ${SOURCES.cairo.name}`)      })
bot.command('dosari',     async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'dosari'));     await ctx.reply(`🎙️ كل القنوات → ${SOURCES.dosari.name}`)     })
bot.command('abdulbasit', async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'abdulbasit')); await ctx.reply(`🎙️ كل القنوات → ${SOURCES.abdulbasit.name}`) })
bot.command('minshawi',   async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'minshawi'));   await ctx.reply(`🎙️ كل القنوات → ${SOURCES.minshawi.name}`)   })
bot.command('qatami',     async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'qatami'));     await ctx.reply(`🎙️ كل القنوات → ${SOURCES.qatami.name}`)     })
bot.command('hussary',    async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'hussary'));    await ctx.reply(`🎙️ كل القنوات → ${SOURCES.hussary.name}`)    })
bot.command('muaiqly',    async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'muaiqly'));    await ctx.reply(`🎙️ كل القنوات → ${SOURCES.muaiqly.name}`)    })
bot.command('alafasy',    async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'alafasy'));    await ctx.reply(`🎙️ كل القنوات → ${SOURCES.alafasy.name}`)    })
bot.command('restart',    async ctx => { if (ctx.from.id !== ADMIN_ID) return; startAll(); await ctx.reply('🔄 جاري إعادة التشغيل...') })
bot.command('stop',       async ctx => { if (ctx.from.id !== ADMIN_ID) return; stopAll();  await ctx.reply('⏹ تم الإيقاف') })

bot.command('status', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  await ctx.replyWithMarkdown(getStatus())
})

bot.command('list', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  let msg = `📋 *المصادر المتاحة:*\n\n`
  for (const [key, src] of Object.entries(SOURCES)) {
    if (src.type === 'files') {
      const files = getAudioFiles(src.dir)
      msg += `• \`${key}\` — ${src.name} (${files.length} ملف محلي)\n`
    } else if (src.type === 'online') {
      msg += `• \`${key}\` — ${src.name} (114 سورة أونلاين)\n`
    } else {
      msg += `• \`${key}\` — ${src.name} (بث مباشر)\n`
    }
  }
  await ctx.replyWithMarkdown(msg)
})

bot.launch({ dropPendingUpdates: true })
  .catch(err => console.log('⚠️ Bot launch error:', err.message))

console.log('🤖 Bot running!')

process.once('SIGINT',  () => { stopAll(); bot.stop(); process.exit(0) })
process.once('SIGTERM', () => { stopAll(); bot.stop(); process.exit(0) })
