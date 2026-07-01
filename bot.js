require('dotenv').config()
const { Telegraf } = require('telegraf')
const { exec, execSync, spawn } = require('child_process')
const path = require('path')
const fs   = require('fs')

const bot      = new Telegraf(process.env.BOT_TOKEN)
const ADMIN_ID = Number(process.env.ADMIN_ID)

const ALL = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,
  25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,
  50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,
  75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,
  100,101,102,103,104,105,106,107,108,109,110,111,112,113,114]

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
    img:  'dosari.png',
    surahs: ALL
  },
  abdulbasit: {
    name: '🎙️ عبد الباسط عبد الصمد',
    type: 'online',
    base: 'https://server7.mp3quran.net/basit/',
    img:  'abdulbasit.png',
    surahs: ALL
  },
  minshawi: {
    name: '🎙️ محمد صديق المنشاوي',
    type: 'online',
    base: 'https://server10.mp3quran.net/minsh/',
    img:  'minshawi.png',
    surahs: ALL
  },
  qatami: {
    name: '🎙️ ناصر القطامي',
    type: 'online',
    base: 'https://server8.mp3quran.net/qtm/',
    img:  'qatami.png',
    surahs: ALL
  },
  hussary: {
    name: '🎙️ محمود خليل الحصري',
    type: 'online',
    base: 'https://server13.mp3quran.net/husr/',
    img:  'hussary.png',
    surahs: ALL
  },
  muaiqly: {
    name: '🎙️ ماهر المعيقلي',
    type: 'online',
    base: 'https://server12.mp3quran.net/maher/',
    img:  'muaiqly.png',
    surahs: ALL
  },
  alafasy: {
    name: '🎙️ مشاري راشد العفاسي',
    type: 'online',
    base: 'https://server8.mp3quran.net/afs/',
    img:  'alafasy.png',
    surahs: ALL
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

const procs    = {}
const retries  = {}
const MAX_RETRY = 5
const CONCURRENCY = 4
const UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
const REF = 'https://www.mp3quran.net/'

// ─── صور ────────────────────────────────────────────────────────────────────
function findImg(imgFile) {
  for (const name of [imgFile, imgFile[0].toUpperCase() + imgFile.slice(1)]) {
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

// ─── كاش السور الفاشلة (404 / غير متاحة) ────────────────────────────────────
const badSurahsFile  = key => `/tmp/bad_surahs_${key}.json`
const badSurahsCache = {}

function loadBadSurahs(key) {
  if (badSurahsCache[key]) return badSurahsCache[key]
  try { badSurahsCache[key] = JSON.parse(fs.readFileSync(badSurahsFile(key), 'utf8')) }
  catch (e) { badSurahsCache[key] = [] }
  return badSurahsCache[key]
}

function markBadSurah(key, num) {
  const list = loadBadSurahs(key)
  if (!list.includes(num)) {
    list.push(num)
    try { fs.writeFileSync(badSurahsFile(key), JSON.stringify(list)) } catch (e) {}
  }
}

// ─── تحميل سورة واحدة ────────────────────────────────────────────────────────
function downloadOne(base, num, dest, sourceKey) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return true
  const url = `${base}${String(num).padStart(3, '0')}.mp3`
  try {
    execSync(
      `curl -fsSL -A "${UA}" -H "Referer: ${REF}" "${url}" -o "${dest}" --max-time 30 --retry 1`,
      { timeout: 35000, stdio: 'pipe' }
    )
    const ok = fs.existsSync(dest) && fs.statSync(dest).size > 1000
    if (!ok) {
      markBadSurah(sourceKey, num)
      if (fs.existsSync(dest)) { try { fs.unlinkSync(dest) } catch (_) {} }
    }
    return ok
  } catch (e) {
    if (fs.existsSync(dest)) { try { fs.unlinkSync(dest) } catch (_) {} }
    markBadSurah(sourceKey, num)
    return false
  }
}

// ─── تحميل القرآن كامل لقارئ معيّن (كاش مشترك بين كل القنوات) ───────────────
async function downloadFullQuran(sourceKey, src, chId) {
  const bad      = new Set(loadBadSurahs(sourceKey))
  const need     = ALL.filter(n => !bad.has(n))
  const cacheDir = `/tmp/qcache_${sourceKey}`
  fs.mkdirSync(cacheDir, { recursive: true })

  const todo = need.filter(n => {
    const f = `${cacheDir}/${String(n).padStart(3, '0')}.mp3`
    return !(fs.existsSync(f) && fs.statSync(f).size > 1000)
  })

  console.log(`⏬ ${chId}: تحميل ${todo.length} سورة متبقية لـ ${sourceKey}...`)

  let idx = 0, done = 0
  await new Promise(resolve => {
    if (todo.length === 0) return resolve()
    const runNext = () => {
      if (idx >= todo.length) { if (done >= todo.length) resolve(); return }
      const n    = todo[idx++]
      const file = `${cacheDir}/${String(n).padStart(3, '0')}.mp3`
      downloadOne(src.base, n, file, sourceKey)
      done++
      if (done >= todo.length) resolve()
      else runNext()
    }
    for (let i = 0; i < CONCURRENCY; i++) runNext()
  })

  console.log(`✅ ${chId}: اكتمل تحميل ${sourceKey}`)
  return cacheDir
}

function buildLocalPlaylist(cacheDir, playlist, sourceKey) {
  const bad = new Set(loadBadSurahs(sourceKey))
  const valid = ALL.filter(n => !bad.has(n)).filter(n => {
    const f = `${cacheDir}/${String(n).padStart(3, '0')}.mp3`
    return fs.existsSync(f) && fs.statSync(f).size > 1000
  })
  // كرر القائمة عدة مرات عشان تغطي ساعات بث طويلة بدون ما ينتهي الـ concat ويوقف ffmpeg
  const bigList = Array(5).fill(valid).flat()
  const lines   = bigList.map(n => `file '${cacheDir}/${String(n).padStart(3, '0')}.mp3'`).join('\n')
  fs.writeFileSync(playlist, lines, 'utf8')
  return valid.length
}

// ─── بناء أمر ffmpeg ─────────────────────────────────────────────────────────
async function buildFFmpegCmd(src, dest, chId, sourceKey) {

  if (src.type === 'stream') {
    const img        = findImg(src.img)
    const isVideo    = /\.(mp4|mkv|avi)$/i.test(src.img)
    const videoInput = !img
      ? '-f lavfi -i color=black:s=1280x720:r=25'
      : isVideo
        ? `-thread_queue_size 1024 -stream_loop -1 -re -i "${img}"`
        : `-thread_queue_size 1024 -loop 1 -i "${img}"`

    return [
      'ffmpeg -y -hide_banner -loglevel error',
      videoInput,
      '-thread_queue_size 4096',
      '-reconnect 1 -reconnect_streamed 1 -reconnect_at_eof 1 -reconnect_delay_max 10',
      `-rw_timeout 20000000 -probesize 10M -analyzeduration 10M`,
      `-i "${src.url}"`,
      '-map 0:v:0 -map 1:a:0',
      '-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p',
      '-vf scale=1280:720,fps=25',
      '-b:v 500k -maxrate 600k -bufsize 2000k -g 50',
      '-c:a aac -b:a 128k -ar 44100 -ac 2',
      '-max_muxing_queue_size 4096',
      '-flvflags no_duration_filesize',
      `-f flv "${dest}"`
    ].join(' ')
  }

  if (src.type === 'online') {
    const cacheDir = await downloadFullQuran(sourceKey, src, chId)
    const playlist = `/tmp/playlist_${chId}.txt`
    const count    = buildLocalPlaylist(cacheDir, playlist, sourceKey)
    if (count === 0) throw new Error('لا توجد سور صالحة للتشغيل')

    const videoInput = buildVideoInput(src.img)

    return [
      'ffmpeg -y -hide_banner -loglevel error',
      '-re',
      videoInput,
      '-thread_queue_size 8192',
      `-protocol_whitelist file,http,https,tcp,tls,crypto`,
      `-f concat -safe 0 -i "${playlist}"`,
      '-map 0:v:0 -map 1:a:0',
      '-c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p',
      '-vf scale=1280:720,fps=25',
      '-b:v 500k -maxrate 600k -bufsize 3000k -g 50',
      '-c:a aac -b:a 128k -ar 44100 -ac 2',
      '-async 1 -vsync 1',
      '-max_muxing_queue_size 4096',
      '-flvflags no_duration_filesize',
      `-f flv "${dest}"`
    ].join(' ')
  }

  throw new Error(`نوع مصدر غير معروف: ${src.type}`)
}

// ─── إدارة البث ──────────────────────────────────────────────────────────────
async function startStream(ch, sourceKey) {
  const key  = sourceKey || ch.source || 'mecca'
  const src  = SOURCES[key] || SOURCES.mecca
  const dest = `${ch.rtmp}/${ch.key}`

  if (procs[ch.id]) {
    try { procs[ch.id].kill('SIGKILL') } catch (e) {}
    delete procs[ch.id]
  }

  ch.source      = key
  retries[ch.id] = retries[ch.id] || 0

  let cmd
  try   { cmd = await buildFFmpegCmd(src, dest, ch.id, key) }
  catch (err) { console.log(`❌ ${ch.id}: ${err.message}`); return }

  console.log(`▶️  ${ch.id} → ${src.name}`)
  const proc = exec(cmd, { shell: '/bin/bash', maxBuffer: 1024 * 1024 * 10 })

  proc.stderr?.on('data', d => {
    const msg = d.toString().trim()
    if (msg) console.log(`⚠️  ${ch.id}: ${msg.substring(0, 200)}`)
  })

  proc.on('exit', (code, signal) => {
    delete procs[ch.id]
    if (signal === 'SIGKILL') return

    if (code !== 0) {
      retries[ch.id]++
      const delay = Math.min(retries[ch.id] * 5000, 30000)
      console.log(`🔄 ${ch.id} كود ${code} — محاولة ${retries[ch.id]}/${MAX_RETRY} بعد ${delay / 1000}ث`)
      if (retries[ch.id] <= MAX_RETRY) {
        setTimeout(() => startStream(ch, ch.source), delay)
      } else {
        retries[ch.id] = 0
        notifyAdmin(`❌ قناة ${ch.id} فشلت ${MAX_RETRY} مرات`)
        setTimeout(() => startStream(ch, ch.source), 5 * 60 * 1000)
      }
    } else {
      retries[ch.id] = 0
      setTimeout(() => startStream(ch, ch.source), 1000)
    }
  })

  procs[ch.id] = proc
  console.log(`🟢 ${ch.id} → ${src.name}`)
}

function startAll() {
  CHANNELS.forEach((ch, i) => setTimeout(() => startStream(ch, ch.source), i * 5000))
}

function stopAll() {
  CHANNELS.forEach(ch => {
    if (procs[ch.id]) {
      try { procs[ch.id].kill('SIGKILL') } catch (e) {}
      delete procs[ch.id]
    }
  })
}

function notifyAdmin(msg) {
  bot.telegram.sendMessage(ADMIN_ID, msg, { parse_mode: 'Markdown' })
    .catch(e => console.log('⚠️  Notify:', e.message))
}

function getStatus() {
  let txt = `📊 *الحالة:*\n\n`
  CHANNELS.forEach(ch => {
    const name = SOURCES[ch.source]?.name || '—'
    txt += procs[ch.id] ? `🟢 ${ch.id} — ${name}\n` : `🔴 ${ch.id} — متوقفة\n`
  })
  txt += `\n⏰ ${Math.floor(process.uptime() / 60)} دقيقة`
  return txt
}

// ─── تشغيل ───────────────────────────────────────────────────────────────────
startAll()

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
}, 15000)

// ─── أوامر البوت ─────────────────────────────────────────────────────────────
bot.command('set', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  const [, chId, srcKey] = ctx.message.text.split(' ')
  if (!chId || !srcKey || !SOURCES[srcKey])
    return ctx.reply(`الاستخدام: /set ch1 mecca\nالمصادر: ${Object.keys(SOURCES).join(' | ')}`)
  const ch = CHANNELS.find(c => c.id === chId)
  if (!ch) return ctx.reply(`❌ القناة ${chId} غير موجودة`)
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
    const t = src.type === 'stream' ? 'بث مباشر' : '114 سورة'
    msg += `• \`${key}\` — ${src.name} (${t})\n`
  }
  await ctx.replyWithMarkdown(msg)
})

bot.command('badlist', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  let msg = `⚠️ *السور غير المتاحة لكل قارئ:*\n\n`
  for (const key of Object.keys(SOURCES)) {
    if (SOURCES[key].type !== 'online') continue
    const bad = loadBadSurahs(key)
    msg += `• \`${key}\`: ${bad.length ? bad.join(', ') : 'لا يوجد'}\n`
  }
  await ctx.replyWithMarkdown(msg)
})

bot.launch({ dropPendingUpdates: true })
  .catch(e => console.log('⚠️  Bot launch error:', e.message))

console.log('🤖 Bot running!')

process.once('SIGINT',  () => { stopAll(); bot.stop(); process.exit(0) })
process.once('SIGTERM', () => { stopAll(); bot.stop(); process.exit(0) })
