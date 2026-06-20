const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalBlock } = goals
const {
    Client, GatewayIntentBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js')
const express = require('express')

// ===================== CẤU HÌNH =====================
const MINECRAFT_HOST = 'kingmc.vn'
const MINECRAFT_PORT = 25565

const DISCORD_TOKEN    = process.env.DISCORD_TOKEN    || 'TOKEN_DISCORD_BOT_CỦA_BẠN'
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || 'ID_KÊNH_DISCORD_CỦA_BẠN'

const TARGET = { x: 7, y: 42, z: 59 }
// ====================================================

let minecraftBot     = null
let loginSuccess     = false
let moved            = false
let discordChannel   = null

let savedUsername    = null
let savedPassword    = null
let savedMode        = null
let scheduledLogout  = false

// ================== WEB SERVER (giữ Render không sleep) ==================
const app = express()
app.get('/', (req, res) => res.send('✅ Bot đang chạy!'))
app.listen(process.env.PORT || 3000, () =>
    console.log(`🌐 Web server chạy cổng ${process.env.PORT || 3000}`)
)

// ================== DISCORD CLIENT ==================
const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
})

discord.once('ready', () => {
    console.log(`✅ Discord bot: ${discord.user.tag}`)
    discordChannel = discord.channels.cache.get(DISCORD_CHANNEL_ID)
    if (!discordChannel) console.warn('⚠️ Không tìm thấy kênh Discord!')
})

// ── Lệnh chat ────────────────────────────────────────
discord.on('messageCreate', async (msg) => {
    if (msg.author.bot) return
    if (msg.channel.id !== DISCORD_CHANNEL_ID) return

    const raw = msg.content.trim()
    const cmd = raw.toLowerCase()

    // !start → hiện 2 nút
    if (cmd === '!start') {
        if (minecraftBot) return msg.reply('⚠️ Bot đang chạy rồi!')

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('btn_dn')
                .setLabel('🔑 Đăng nhập (/dn)')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('btn_dk')
                .setLabel('📝 Đăng ký (/dk)')
                .setStyle(ButtonStyle.Success)
        )
        return msg.reply({ content: '🟢 Chọn phương thức:', components: [row] })
    }

    // !tpa <tên>
    if (cmd.startsWith('!tpa ')) {
        if (!minecraftBot) return msg.reply('❌ Bot chưa chạy. Dùng `!start` trước.')
        const player = raw.slice(5).trim()
        if (!player) return msg.reply('❌ VD: `!tpa Steve`')
        minecraftBot.chat(`/tpa ${player}`)
        return msg.reply(`📨 Đã gửi \`/tpa ${player}\``)
    }

    // !tatchat
    if (cmd === '!tatchat') {
        if (!minecraftBot) return msg.reply('❌ Bot chưa chạy. Dùng `!start` trước.')
        minecraftBot.chat('/tatchat')
        return msg.reply('📨 Đã gửi `/tatchat`')
    }

    // !stop
    if (cmd === '!stop') {
        if (!minecraftBot) return msg.reply('⚠️ Bot chưa chạy.')
        scheduledLogout = true
        minecraftBot.end()
        minecraftBot = null
        loginSuccess  = false
        moved         = false
        savedUsername = null
        savedPassword = null
        return msg.reply('🔴 Đã ngắt kết nối.')
    }

    // !help
    if (cmd === '!help') {
        return msg.reply(
            '📋 **Lệnh:**\n' +
            '`!start` — Khởi động bot (chọn dn/dk)\n' +
            '`!tpa <tên>` — Teleport tới người chơi\n' +
            '`!tatchat` — Gửi /tatchat\n' +
            '`!stop` — Dừng bot\n' +
            '`!help` — Danh sách lệnh'
        )
    }
})

// ── Button & Modal ────────────────────────────────────
discord.on('interactionCreate', async (interaction) => {

    if (interaction.isButton()) {
        if (!['btn_dn', 'btn_dk'].includes(interaction.customId)) return

        const mode = interaction.customId === 'btn_dn' ? 'dn' : 'dk'

        const modal = new ModalBuilder()
            .setCustomId(`modal_${mode}`)
            .setTitle(mode === 'dn' ? '🔑 Đăng nhập Minecraft' : '📝 Đăng ký Minecraft')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('input_username')
                        .setLabel('Tên người dùng (username)')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('VD: Steve123')
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('input_password')
                        .setLabel('Mật khẩu')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('Nhập mật khẩu')
                        .setRequired(true)
                )
            )

        return interaction.showModal(modal)
    }

    if (interaction.isModalSubmit()) {
        if (!interaction.customId.startsWith('modal_')) return

        const mode     = interaction.customId === 'modal_dn' ? 'dn' : 'dk'
        const username = interaction.fields.getTextInputValue('input_username').trim()
        const password = interaction.fields.getTextInputValue('input_password').trim()

        savedUsername   = username
        savedPassword   = password
        savedMode       = mode
        scheduledLogout = false

        await interaction.reply(`⏳ Đang kết nối **${username}** với chế độ \`/${mode}\`...`)
        startMinecraftBot(username, password, mode)
    }
})

// ================== MINECRAFT BOT ==================
function startMinecraftBot(username, password, mode) {
    username = username || savedUsername
    password = password || savedPassword
    mode     = mode     || savedMode

    if (!username || !password) {
        sendToDiscord('❌ Không có thông tin login. Dùng `!start` để bắt đầu.')
        return
    }

    loginSuccess = false
    moved        = false

    minecraftBot = mineflayer.createBot({
        host: MINECRAFT_HOST,
        port: MINECRAFT_PORT,
        username: username,
        hideErrors: true,
        checkTimeoutInterval: 60000
    })

    minecraftBot.loadPlugin(pathfinder)

    // Spawn
    minecraftBot.once('spawn', () => {
        const pos = minecraftBot.entity.position
        console.log('✅ Spawn:', pos)
        sendToDiscord(
            `✅ **Bot đã vào game!**\n` +
            `👤 \`${username}\` | Chế độ: \`/${mode}\`\n` +
            `⏳ Tự động gửi \`/${mode}\` sau 3 giây...`
        )

        setTimeout(() => {
            if (!minecraftBot?.entity) return
            if (mode === 'dn') {
                minecraftBot.chat(`/dn ${password}`)
            } else {
                minecraftBot.chat(`/dk ${password} ${password}`)
            }
        }, 3000)
    })

    // Chỉ lắng nghe thông báo quan trọng
    minecraftBot.on('message', (msg) => {
        const text = msg.toString()
        console.log('[MSG]:', text)

        const ok =
            text.includes('SẢNH ➞ Đăng nhập thành công') ||
            text.includes('SẢNH ➞ Đăng ký thành công')

        if (!loginSuccess && ok) {
            loginSuccess = true
            sendToDiscord('✅ **Đăng nhập thành công!** Đang vào KingSMP...')

            setTimeout(() => {
                if (!minecraftBot?.entity) return
                if (!moved) {
                    moved = true
                    moveToTarget(TARGET.x, TARGET.y, TARGET.z)
                }
            }, 8000)
        }
    })

    // Đến đích
    minecraftBot.on('goal_reached', () => {
        sendToDiscord(`✅ Đã vào **KingSMP**!`)
        setTimeout(() => rightClickNPC(TARGET.x, TARGET.y, TARGET.z), 1000)
    })

    // Bị kick
    minecraftBot.on('kicked', (reason) => {
        sendToDiscord(`❌ Bị kick!\n\`\`\`${JSON.stringify(reason, null, 2)}\`\`\``)
    })

    // Lỗi
    minecraftBot.on('error', (err) => {
        if (err?.message?.includes('Chunk size')) return
        console.log('❌ Error:', err?.message || err)
    })

    // Mất kết nối → tự reconnect nếu không phải lịch
    minecraftBot.on('end', (reason) => {
        console.log('🔌 End:', reason)
        minecraftBot = null

        if (!scheduledLogout && savedUsername && savedPassword) {
            sendToDiscord(`🔌 Mất kết nối. 🔄 Reconnect sau 10 giây...`)
            setTimeout(() => {
                sendToDiscord('🔄 Đang kết nối lại...')
                startMinecraftBot()
            }, 10000)
        }
    })
}

// ================== HELPERS ==================
function moveToTarget(x, y, z) {
    try {
        const movements = new Movements(minecraftBot)
        minecraftBot.pathfinder.setMovements(movements)
        minecraftBot.pathfinder.setGoal(new GoalBlock(x, y, z))
        console.log(`🚶 Đi tới (${x}, ${y}, ${z})`)
    } catch (err) {
        sendToDiscord(`❌ Pathfinder lỗi: ${err.message}`)
    }
}

function rightClickNPC(x, y, z) {
    const npc = minecraftBot.nearestEntity(e => {
        if (!e.position) return false
        const dx = e.position.x - x
        const dy = e.position.y - y
        const dz = e.position.z - z
        return Math.sqrt(dx*dx + dy*dy + dz*dz) < 5
    })

    if (!npc) {
        console.log('❌ Không tìm thấy NPC')
        return
    }

    minecraftBot.lookAt(npc.position.offset(0, npc.height || 1.6, 0), true)
    setTimeout(() => {
        try {
            minecraftBot.activateEntity(npc)
            console.log('✅ Click NPC thành công')
        } catch (err) {
            console.log('❌ Click NPC lỗi:', err.message)
        }
    }, 500)
}

function sendToDiscord(text) {
    discordChannel?.send(text).catch(err => console.error('Discord error:', err))
}

// ================== TỰ ĐỘNG ĐĂNG XUẤT / ĐĂNG NHẬP ==================
let lastLogoutFired = -1
let lastLoginFired  = -1

setInterval(() => {
    const now = new Date()
    const h   = now.getHours()
    const m   = now.getMinutes()
    const day = now.getDate()

    // 4:15 sáng → đăng xuất
    if (h === 4 && m === 15 && lastLogoutFired !== day) {
        lastLogoutFired = day
        if (minecraftBot) {
            console.log('⏰ 4:15 AM — Tự động đăng xuất')
            sendToDiscord('⏰ **4:15 AM** — Tự động đăng xuất. Sẽ login lại lúc **5:00 AM**.')
            scheduledLogout = true
            minecraftBot.end()
            minecraftBot = null
            loginSuccess  = false
            moved         = false
        }
    }

    // 5:00 sáng → đăng nhập lại
    if (h === 5 && m === 0 && lastLoginFired !== day) {
        lastLoginFired = day
        if (!minecraftBot && savedUsername && savedPassword) {
            console.log('⏰ 5:00 AM — Tự động đăng nhập lại')
            sendToDiscord('⏰ **5:00 AM** — Tự động đăng nhập lại.')
            scheduledLogout = false
            startMinecraftBot()
        }
    }
}, 30 * 1000)

// ================== START ==================
discord.login(DISCORD_TOKEN)
console.log('🚀 Bot đang khởi động...')
