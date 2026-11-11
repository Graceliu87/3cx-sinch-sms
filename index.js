require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '1mb' }));

const {
  PORT = 3000,
  SINCH_PROJECT_ID,
  SINCH_APP_ID,
  SINCH_KEY_ID,
  SINCH_KEY_SECRET,
  SINCH_NUMBER,
  SINCH_REGION = 'eu',
  THREE_CX_WEBHOOK_URL,
  THREE_CX_API_KEY
} = process.env;

// ========== 工具函数 ==========
function basicAuth() {
  return 'Basic ' + Buffer.from(`${SINCH_KEY_ID}:${SINCH_KEY_SECRET}`).toString('base64');
}

function nowISO() {
  return new Date().toISOString();
}

// ========== 3CX → Sinch（发送短信）==========
app.post('/3cx/send', async (req, res) => {
  try {
    // 验证 3CX 的 API Key
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (token !== THREE_CX_API_KEY) {
      console.log('Unauthorized request from 3CX');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { from, to, text } = req.body;
    console.log('收到 3CX 发送请求:', { from, to, text });

    if (!to || !text) {
      return res.status(400).json({ error: 'Missing to or text' });
    }

    // 调用 Sinch Conversation API
    const sinchUrl = `https://${SINCH_REGION}.conversation.api.sinch.com/v1/projects/${SINCH_PROJECT_ID}/messages:send`;

    const payload = {
      app_id: SINCH_APP_ID,
      recipient: {
        identified_by: {
          channel_identities: [
            {
              channel: 'SMS',
              identity: to
            }
          ]
        }
      },
      message: {
        text_message: {
          text: text
        }
      },
      channel_properties: {
        SMS_SENDER: SINCH_NUMBER   // 免费测试号码必须加这个
      }
    };

    const response = await axios.post(sinchUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: basicAuth()
      }
    });

    console.log('Sinch 发送成功:', response.data);

    // 3CX 期望简单成功响应
    res.status(200).json({
      id: response.data.message_id || response.data.id || Date.now().toString(),
      status: 'sent'
    });
  } catch (err) {
    console.error('发送失败:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Failed to send SMS',
      detail: err.response?.data || err.message
    });
  }
});

// ========== Sinch → 3CX（接收短信）==========
app.post('/sinch/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('收到 Sinch Webhook:', JSON.stringify(body, null, 2));

    // 只处理 MESSAGE_INBOUND
    if (body.type !== 'MESSAGE_INBOUND' && body.event !== 'MESSAGE_INBOUND') {
      // 也兼容其他可能的字段名
      if (!body.message || !body.message.contact_message) {
        return res.status(200).send('OK');
      }
    }

    // 解析入站消息（Conversation API 格式）
    const message = body.message || body;
    const contactMessage = message.contact_message || message;
    const text = contactMessage?.text_message?.text || contactMessage?.text || '';
    const fromNumber = message.channel_identity?.identity ||
                       body.channel_identity?.identity ||
                       body.from || '';
    const toNumber = SINCH_NUMBER;
    const messageId = message.id || body.message_id || Date.now().toString();

    if (!text || !fromNumber) {
      console.log('无效的入站消息，忽略');
      return res.status(200).send('OK');
    }

    // 转换成 3CX 期望的格式
    const threeCxPayload = {
      data: {
        event_type: 'message.received',
        id: messageId,
        occurred_at: nowISO(),
        payload: {
          id: messageId,
          direction: 'inbound',
          from: {
            phone_number: fromNumber,
            status: 'webhook_delivered'
          },
          to: [
            {
              phone_number: toNumber,
              status: 'webhook_delivered'
            }
          ],
          text: text,
          received_at: nowISO(),
          type: 'SMS',
          record_type: 'message'
        },
        record_type: 'event'
      },
      meta: {
        attempt: 1,
        delivered_to: THREE_CX_WEBHOOK_URL
      }
    };

    // 转发给 3CX
    await axios.post(THREE_CX_WEBHOOK_URL, threeCxPayload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    console.log('已成功转发到 3CX');
    res.status(200).send('OK');
  } catch (err) {
    console.error('转发到 3CX 失败:', err.response?.data || err.message);
    // 仍然返回 200，避免 Sinch 重试过多
    res.status(200).send('OK');
  }
});

// 健康检查
app.get('/', (req, res) => {
  res.send('3CX ↔ Sinch SMS Proxy is running');
});

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
