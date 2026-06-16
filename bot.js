require('dotenv').config()
const { Telegraf } = require('telegraf')
const { exec }    = require('child_process')
const path        = require('path')
const fs          = require('fs')

const bot      = new Telegraf(process.env.BOT_TOKEN)
const ADMIN_ID = Number(process.env.ADMIN_ID)

const SOURCES = {
  mecca:  { name: '🕋 الحرم المكي',                    url: 'http://n07.radiojar.com/0tpy1h0kxtzuv',     img: 'mecca.png'  },
  madina: { name: '🕌 الحرم المدني',                   url: 'http://stream.radiojar.com/8s5u5tpdtwzuv',  img: 'madina.png' },
  cairo:  { name: '📻 إذاعة القرآن الكريم من القاهرة', url: 'https://stream.radiojar.com/8s5u5tpdtwzuv', img: 'cairo.png'  }
}

const CHANNELS = [
  { id: 'ch1', rtmp: process.env.CHANNEL_1_RTMP, key: process.env.CHANNEL_1_KEY, source: process.env.CHANNEL_1_SOURCE || 'mecca' },
  { id: 'ch2', rtmp: process.env.CHANNEL_2_RTMP, key: process.env.CHANNEL_2_KEY, source: process.env.CHANNEL_2_SOURCE || 'mecca' },
  { id: 'ch3', rtmp: process.env.CHANNEL_3_RTMP, key: process.env.CHANNEL_3_KEY, source: process.env.CHANNEL_3_SOURCE || 'mecca' },
  { id: 'ch4', rtmp: process.env.CHANNEL_4_RTMP, key: process.env.CHANNEL_4_KEY, source: process.env.CHANNEL_4_SOURCE || 'mecca' },
  { id: 'ch5', rtmp: process.env.CHANNEL_5_RTMP, key: process.env.CHANNEL_5_KEY, source: process.env.CHANNEL_5_SOURCE || 'mecca' },
  { id: 'ch6', rtmp: process.env.CHANNEL_6_RTMP, key: process.env.CHANNEL_6_KEY, source: process.env.CHANNEL_6_SOURCE || 'mecca' },
].filter(ch => ch.rtmp && ch.key)

const procs       = {}
const retries     = {}
const lastRestart = {}
const MAX_RETRY   = 5

function buildFFmpegCmd(src, dest) {
  const img      = path.join(process.cwd(), src.img)
  const imgExists = fs.existsSync(img)

  console.log(`🖼️ img: ${img} → exists: ${imgExists}`)

  if (!imgExists) {
    console.log(`⚠️ Image not found, using black background`)
    return [
      'ffmpeg -y',
      `-f lavfi -i color=black:s=1280x720:r=25`,
      `-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -re`,
      `-i "${src.url}"`,
      `-map 0:v -map 1:a`,
      `-c:v libx264 -preset ultrafast`,
      `-vf format=yuv420p,scale=1280:720`,
      `-r 25 -g 50`,
      `-b:v 500k -maxrate 500k -bufsize 1000k`,
      `-c:a aac -b:a 128k -ar 44100 -ac 2`,
      `-f flv "${dest}"`
    ].join(' ')
  }

  return [
    'ffmpeg -y',
    `-loop 1 -i "${img}"`,
    `-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -re`,
    `-i "${src.url}"`,
    `-map 0:v:0 -map 1:a:0`,
    `-c:v libx264 -preset ultrafast -tune stillimage`,
    `-vf format=yuv420p,scale=1280:720`,
    `-r 25 -g 50`,
    `-b:v 500k -maxrate 500k -bufsize 1000k`,
    `-c:a aac -b:a 128k -ar 44100 -ac 2`,
    `-fflags +genpts+discardcorrupt`,
    `-f flv "${dest}"`
  ].join(' ')
}

function startStream(ch, sourceKey) {
  const key = sourceKey || ch.source || 'mecca'
  const src = SOURCES[key] || SOURCES.mecca
  const dest = `${ch.rtmp}/${ch.key}`

  const now = Date.now()
  if (lastRestart[ch.id] && now - lastRestart[ch.id] < 3000) {
    console.log(`⏳ ${ch.id} restart too fast, waiting...`)
    setTimeout(() => startStream(ch, key), 3000)
    return
  }
  lastRestart[ch.id] = now

  if (procs[ch.id]) {
    try { procs[ch.id].kill('SIGKILL') } catch(e) {}
    delete procs[ch.id]
  }

  ch.source = key
  if (retries[ch.id] === undefined) retries[ch.id] = 0

  console.log(`🟢 [${ch.id}] → ${src.name} | img: ${src.img}`)

  const cmd  = buildFFmpegCmd(src, dest)
  const proc = exec(cmd, { shell: '/bin/bash' })
  procs[ch.id] = proc

  proc.stderr?.on('data', d => {
    const msg = d.toString().trim()
    if (/error|fail|invalid|refused/i.test(msg)) {
      console.log(`⚠️ [${ch.id}] ${msg.substring(0, 150)}`)
    }
  })

  proc.on('exit', (code, signal) => {
    delete procs[ch.id]

    if (signal === 'SIGKILL') {
      console.log(`🛑 [${ch.id}] stopped manually`)
      return
    }

    if (code !== 0) {
      retries[ch.id]++
      const delay = Math.min(retries[ch.id] * 5000, 30000)
      console.log(`🔄 [${ch.id}] retry ${retries[ch.id]}/${MAX_RETRY} in ${delay / 1000}s`)

      if (retries[ch.id] <= MAX_RETRY) {
        setTimeout(() => startStream(ch, ch.source), delay)
      } else {
        retries[ch.id] = 0
        notifyAdmin(`❌ قناة *${ch.id}* فشلت ${MAX_RETRY} مرات\nجاري إعادة المحاولة بعد 5 دقائق`)
        setTimeout(() => startStream(ch, ch.source), 5 * 60 * 1000)
      }
    } else {
      retries[ch.id] = 0
      console.log(`✅ [${ch.id}] exited cleanly, restarting...`)
      setTimeout(() => startStream(ch, ch.source), 2000)
    }
  })

  proc.on('error', err => {
    console.log(`❌ [${ch.id}] exec error: ${err.message}`)
  })
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
  const upMin = Math.floor(process.uptime() / 60)
  let txt = `📊 *الحالة:*\n\n`
  CHANNELS.forEach(ch => {
    const src = SOURCES[ch.source]
    const ret = retries[ch.id] ? ` (retry: ${retries[ch.id]})` : ''
    txt += procs[ch.id]
      ? `🟢 ${ch.id} — ${src?.name || '—'} | 🖼️ ${src?.img || '—'}${ret}\n`
      : `🔴 ${ch.id} — متوقفة${ret}\n`
  })
  txt += `\n⏰ وقت التشغيل: ${upMin} دقيقة`
  return txt
}

// ── Bot Commands ──────────────────────────────────────────────────────────────

bot.command('set', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  const [, chId, src] = ctx.message.text.split(' ')
  if (!chId || !src || !SOURCES[src])
    return ctx.reply('الاستخدام: /set ch1 mecca\nالمصادر: mecca | madina | cairo')
  const ch = CHANNELS.find(c => c.id === chId)
  if (!ch) return ctx.reply(`❌ القناة ${chId} غير موجودة`)
  startStream(ch, src)
  await ctx.reply(`✅ ${chId} → ${SOURCES[src].name}\n🖼️ الصورة: ${SOURCES[src].img}`)
})

bot.command('mecca', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  CHANNELS.forEach(ch => startStream(ch, 'mecca'))
  await ctx.reply(`🕋 كل القنوات → ${SOURCES.mecca.name}\n🖼️ الصورة: ${SOURCES.mecca.img}`)
})

bot.command('madina', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  CHANNELS.forEach(ch => startStream(ch, 'madina'))
  await ctx.reply(`🕌 كل القنوات → ${SOURCES.madina.name}\n🖼️ الصورة: ${SOURCES.madina.img}`)
})

bot.command('cairo', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  CHANNELS.forEach(ch => startStream(ch, 'cairo'))
  await ctx.reply(`📻 كل القنوات → ${SOURCES.cairo.name}\n🖼️ الصورة: ${SOURCES.cairo.img}`)
})

bot.command('stop', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  stopAll()
  await ctx.reply('⏹ تم الإيقاف')
})

bot.command('restart', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  startAll()
  await ctx.reply('🔄 جاري إعادة التشغيل...')
})

bot.command('status', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return
  await ctx.replyWithMarkdown(getStatus())
})

// ── Start ─────────────────────────────────────────────────────────────────────

startAll()

setInterval(() => {
  console.log('🔄 Auto-refresh...')
  startAll()
}, 2 * 60 * 60 * 1000)

setTimeout(() => {
  let msg = `✅ *بدأ البث*\n\n`
  CHANNELS.forEach(ch => {
    const src = SOURCES[ch.source]
    msg += `📡 ${ch.id}: ${src?.name || '—'} | 🖼️ ${src?.img || '—'}\n`
  })
  msg += `\n*/status* — الحالة\n*/set ch1 cairo* — تغيير مصدر\n*/mecca* — كل القنوات للمكة`
  notifyAdmin(msg)
}, 10000)

bot.launch({ dropPendingUpdates: true })
  .catch(err => console.log('⚠️ Bot launch error:', err.message))

console.log('🤖 Bot running!')

process.once('SIGINT',  () => { stopAll(); bot.stop(); process.exit(0) })
process.once('SIGTERM', () => { stopAll(); bot.stop(); process.exit(0) })
