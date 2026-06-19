require('dotenv').config()
const { Telegraf } = require('telegraf')
const { exec }    = require('child_process')
const path        = require('path')
const fs          = require('fs')

const bot      = new Telegraf(process.env.BOT_TOKEN)
const ADMIN_ID = Number(process.env.ADMIN_ID)

const SOURCES = {
  mecca:  { name: '🕋 الحرم المكي',                    url: 'http://n07.radiojar.com/0tpy1h0kxtzuv', img: 'mecca.mp4'  },
  madina: { name: '🕌 الحرم المدني',                   url: 'http://n07.radiojar.com/8s5u5tpdtwzuv', img: 'madina.mp4' },
  // تنبيه: cairo حالياً بنفس آيدي الستريم بتاع madina (8s5u5tpdtwzuv)
  // لازم تتأكد من الرابط الصحيح لإذاعة القرآن من القاهرة وتحطه هنا
  cairo:  { name: '📻 إذاعة القرآن الكريم من القاهرة', url: 'https://stream.radiojar.com/8s5u5tpdtwzuv', img: 'cairo.mp4' }
}

const CHANNELS = [
  { id: 'ch1', rtmp: process.env.CHANNEL_1_RTMP, key: process.env.CHANNEL_1_KEY, source: process.env.CHANNEL_1_SOURCE || 'mecca' },
  { id: 'ch2', rtmp: process.env.CHANNEL_2_RTMP, key: process.env.CHANNEL_2_KEY, source: process.env.CHANNEL_2_SOURCE || 'mecca' },
  { id: 'ch3', rtmp: process.env.CHANNEL_3_RTMP, key: process.env.CHANNEL_3_KEY, source: process.env.CHANNEL_3_SOURCE || 'mecca' },
  { id: 'ch4', rtmp: process.env.CHANNEL_4_RTMP, key: process.env.CHANNEL_4_KEY, source: process.env.CHANNEL_4_SOURCE || 'mecca' },
  { id: 'ch5', rtmp: process.env.CHANNEL_5_RTMP, key: process.env.CHANNEL_5_KEY, source: process.env.CHANNEL_5_SOURCE || 'mecca' },
  { id: 'ch6', rtmp: process.env.CHANNEL_6_RTMP, key: process.env.CHANNEL_6_KEY, source: process.env.CHANNEL_6_SOURCE || 'mecca' },
].filter(ch => ch.rtmp && ch.key)

const procs   = {}
const retries = {}
const MAX_RETRY = 5

function buildFFmpegCmd(src, img, dest) {
  // خيارات ثابتة لمدخل الصوت (الراديو اللايف):
  // - reconnect: يصمد لو الاتصال انقطع لحظياً
  // - rw_timeout / probesize / analyzeduration: يمنع تعليق ffmpeg أو فشله
  //   في التعرف على الصوت من أول مرة
  // - thread_queue_size: يمنع كراش بسبب بطء الشبكة
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
    console.log(`❌ Video not found: ${img}`)
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

  return [
    'ffmpeg -y -hide_banner -loglevel warning',
    '-thread_queue_size 1024',
    `-stream_loop -1 -re -i "${img}"`,
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

function startStream(ch, sourceKey) {
  const key  = sourceKey || ch.source || 'mecca'
  const src  = SOURCES[key] || SOURCES.mecca
  const dest = `${ch.rtmp}/${ch.key}`
  const img  = path.join(__dirname, src.img)

  console.log(`📁 ${ch.id} video: ${img} → exists: ${fs.existsSync(img)}`)

  if (procs[ch.id]) {
    try { procs[ch.id].kill('SIGKILL') } catch(e) {}
    delete procs[ch.id]
  }

  ch.source = key
  if (!retries[ch.id]) retries[ch.id] = 0

  const cmd  = buildFFmpegCmd(src, img, dest)
  console.log(`▶️ ${ch.id} cmd: ${cmd}`)
  const proc = exec(cmd, { shell: '/bin/bash', maxBuffer: 1024 * 1024 * 10 })

  // نطبع كل رسائل stderr (مش بس اللي فيها كلمة error) عشان نشوف السبب الحقيقي للفشل
  proc.stderr?.on('data', d => {
    const msg = d.toString().trim()
    if (msg) console.log(`⚠️ ${ch.id}: ${msg.substring(0, 300)}`)
  })

  proc.on('exit', (code, signal) => {
    delete procs[ch.id]
    if (code !== 0) {
      retries[ch.id]++
      const delay = Math.min(retries[ch.id] * 5000, 30000)
      console.log(`🔄 ${ch.id} خرج بكود ${code} (إشارة ${signal}) — محاولة ${retries[ch.id]}/${MAX_RETRY} بعد ${delay/1000} ثانية`)
      if (retries[ch.id] <= MAX_RETRY) {
        setTimeout(() => startStream(ch, ch.source), delay)
      } else {
        retries[ch.id] = 0
        setTimeout(() => startStream(ch, ch.source), 5 * 60 * 1000)
        notifyAdmin(`❌ قناة ${ch.id} فشلت ${MAX_RETRY} مرات\nجاري إعادة المحاولة بعد 5 دقائق`)
      }
    } else {
      retries[ch.id] = 0
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
    const src = SOURCES[ch.source]?.name || '—'
    txt += procs[ch.id] ? `🟢 ${ch.id} — ${src}\n` : `🔴 ${ch.id} — متوقفة\n`
  })
  txt += `\n⏰ وقت التشغيل: ${Math.floor(process.uptime() / 60)} دقيقة`
  return txt
}

startAll()

setInterval(() => {
  console.log('🔄 Auto-refresh...')
  startAll()
}, 2 * 60 * 60 * 1000)

setTimeout(() => {
  let msg = `✅ *بدأ البث*\n\n`
  CHANNELS.forEach(ch => {
    msg += `📡 ${ch.id}: ${SOURCES[ch.source]?.name || '—'}\n`
  })
  msg += `\n*/status* — الحالة\n*/set ch1 cairo* — تغيير مصدر`
  notifyAdmin(msg)
}, 10000)

bot.command('set', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  const parts = ctx.message.text.split(' ')
  const chId  = parts[1]
  const src   = parts[2]
  if (!chId || !src || !SOURCES[src]) {
    return ctx.reply('الاستخدام: /set ch1 mecca\nالمصادر: mecca | madina | cairo')
  }
  const ch = CHANNELS.find(c => c.id === chId)
  if (!ch) return ctx.reply(`❌ القناة ${chId} غير موجودة`)
  startStream(ch, src)
  await ctx.reply(`✅ ${chId} → ${SOURCES[src].name}`)
})

bot.command('mecca',   async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'mecca'));  await ctx.reply(`🕋 كل القنوات → ${SOURCES.mecca.name}`)  })
bot.command('madina',  async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'madina')); await ctx.reply(`🕌 كل القنوات → ${SOURCES.madina.name}`) })
bot.command('cairo',   async ctx => { if (ctx.from.id !== ADMIN_ID) return; CHANNELS.forEach(ch => startStream(ch, 'cairo'));  await ctx.reply(`📻 كل القنوات → ${SOURCES.cairo.name}`)  })
bot.command('restart', async ctx => { if (ctx.from.id !== ADMIN_ID) return; startAll(); await ctx.reply('🔄 جاري إعادة التشغيل...') })
bot.command('stop',    async ctx => { if (ctx.from.id !== ADMIN_ID) return; stopAll();  await ctx.reply('⏹ تم الإيقاف') })

bot.command('status', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  await ctx.replyWithMarkdown(getStatus())
})

bot.launch({ dropPendingUpdates: true })
  .catch(err => console.log('⚠️ Bot launch error:', err.message))

console.log('🤖 Bot running!')

process.once('SIGINT',  () => { stopAll(); bot.stop(); process.exit(0) })
process.once('SIGTERM', () => { stopAll(); bot.stop(); process.exit(0) })
