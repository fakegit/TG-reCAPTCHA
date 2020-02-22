const crypto = require('crypto')
const express = require('express')
const bodyparser = require('body-parser')
const morgan = require('morgan')
const telegrambot = require('node-telegram-bot-api')
const Recaptcha = require('express-recaptcha').RecaptchaV2
const config = require('./config.json')

const secretKey = crypto.createHash('sha256').update(config.token).digest()
const pollingOption = {
  interval: 0,
  params: { timeout: 60 }
}
const unban = {
  can_send_messages: true,
  can_send_media_messages: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: true,
  can_invite_users: true,
  can_pin_messages: true
}

const bot = new telegrambot(config.token, { polling: config.webhook ? false : pollingOption })
const app = express()
var recaptcha = new Recaptcha(config.recaptcha.site_key, config.recaptcha.secret_key, { checkremoteip: true, callback: 'cb' })

recaptcha._api.host = 'www.recaptcha.net'
app.set('view engine', 'pug')
app.set('trust proxy', true)
app.use(morgan('combined'))
app.use(bodyparser.json())

if (config.webhook) {
  app.post(`/bot${config.token}`, (req, res) => {
    res.sendStatus(200)
    bot.processUpdate(req.body)
  })

  bot.setWebHook(`${config.url}/bot${config.token}`)
}

app.get('/', (_, res) => res.send('Hello world!'))
app.get('/verify/:token', recaptcha.middleware.render, (req, res) => {
  if (req.query.hash) {
    const token = parserToken(req.params.token)
    const now = getUnixtime()

    if (now - req.query.auth_date > 10 || now - token.date > 60) {
      res.status(403).send("Token expired, please update and try again.")
      return
    }

    if (!checkVaild(req.query)) {
      res.status(403).send("Auth failed, please try again.")
      return
    }

    if (!parserToken(req.params.token).users.includes(parseInt(req.query.id))) {
      res.status(400).send("User not match token")
      return
    }

    res.render('verify', { captcha: res.recaptcha })
    return
  }

  // todo generate auth token whitout login
  res.status(401).send('Need login')
})
app.post('/verify/:token', recaptcha.middleware.verify, (req, res) => {
  if (req.query.hash && checkVaild(req.query, req.query.hash)) {
    if (!req.recaptcha.error) {
      const data = parserToken(req.params.token)

      if (getUnixtime() - data.date > 60) {
        res.status(410).send('Token expired')
        return
      }

      // unban & response
      bot.restrictChatMember(data.chat, req.query.id, unban)
      res.send()

      // update or delete message
      const users = data.users.filter(i => i !== parseInt(req.query.id))
      if (users.length === 0) {
        bot.deleteMessage(data.chat, data.id)
      } else {
        bot.editMessageReplyMarkup(genKeyboard(genToken(data.chat, data.id, users)), { chat_id: data.chat, message_id: data.id })
      }
    } else {
      res.status(400).send('reCAPTCHA vailed failed.')
    }
  }
})

app.listen(config.port, config.bind, () => console.log(`app listening on port ${config.port}!`))

bot.on('new_chat_members', async msg => {
  const members = msg.new_chat_members.filter(i => !i.is_bot).filter(i => !i.is_bot)

  if (members.length === 0) return

  let message = bot.sendMessage(msg.chat.id, 'Generating token...', { reply_to_message_id: msg.message_id })

  await Promise.allSettled(members.map(i => bot.restrictChatMember(msg.chat.id, i.id, { can_send_messages: false })))

  message = await message

  const token = genToken(msg.chat.id, message.message_id, members.map(i => i.id))

  bot.editMessageText("reCAPTCHA", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reply_markup: genKeyboard(token)
  })
})

bot.on('callback_query', async callback => {
  const data = parserToken(callback.message.reply_markup.inline_keyboard[0][0].url.split('/').slice(-1)[0])

  // Wrokaround 35ba5c2
  if (data.users[0].user) {
    data.users = data.users.map(i => i.user.id)
  }

  const unvailedUsers = (await Promise.all(data.users.map(i => bot.getChatMember(data.chat, i)))).filter(i => i.status === 'restricted').map(i => i.user.id)

  if (unvailedUsers.length === 0) {
    bot.deleteMessage(data.chat, data.id)
    bot.answerCallbackQuery(callback.id)
  } else if (unvailedUsers.includes(callback.from.id)) {
    bot.editMessageReplyMarkup(genKeyboard(genToken(data.chat, data.id, unvailedUsers)), { chat_id: data.chat, message_id: data.id })
    bot.answerCallbackQuery(callback.id, { cache_time: 30, text: 'Token updated' })
  } else {
    bot.answerCallbackQuery(callback.id, { cache_time: 300 })
  }
})

function checkVaild(input) {
  const data = Object.keys(input).sort().reduce((acc, key, index) => {
    if (key === 'hash') return acc
    if (index !== 0) acc += '\n'
    return acc + `${key}=${input[key]}`
  }, '')

  return input.hash === crypto.createHmac('sha256', secretKey).update(data).digest('hex')
}

function parserToken(input) {
  const rawdata = Buffer.from(input, 'base64').toString().split(' ')

  if (rawdata[0] === crypto.createHmac('sha256', secretKey).update(rawdata[1]).digest('hex')) {
    return JSON.parse(rawdata[1])
  }
}

function genToken(chat, id, users) {
  const data = JSON.stringify({ chat, id, users, date: getUnixtime() })
  const hash = crypto.createHmac('sha256', secretKey).update(data).digest('hex')
  return Buffer.from(`${hash} ${data}`).toString('base64')
}

function getUnixtime() {
  return Date.now() / 1000 | 0
}

function genKeyboard(token) {
  return {
    inline_keyboard: [
      [{ text: "I'm not a robot", login_url: { url: `${config.url}/verify/${token}` } }],
      [{ text: "Update token", callback_data: "update" }]
    ]
  }
}