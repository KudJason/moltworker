import { Hono } from 'hono';

type Bindings = {
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  MOLTBOT_URL: string;
  MOLTBOT_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Feishu Webhook endpoint
app.post('/webhook', async (c) => {
  const body = await c.req.json();

  // 1. Initial URL Verification Challenge from Feishu
  if (body.type === 'url_verification') {
    return c.json({ challenge: body.challenge });
  }

  // 2. Receive Chat Message Event
  // Feishu wraps events in a specific structure
  const eventType = body.header?.event_type;
  if (eventType === 'im.message.receive_v1') {
    const event = body.event;
    const messageId = event.message.message_id;
    const senderId = event.sender.sender_id.open_id;
    
    // Parse message content (Feishu sends it as a stringified JSON)
    let text = "";
    if (event.message.message_type === 'text') {
      try {
        const content = JSON.parse(event.message.content);
        text = content.text;
      } catch (e) {
        text = event.message.content;
      }
    }

    // Acknowledge Feishu immediately (Feishu requires response within 3 seconds)
    c.executionCtx.waitUntil(processAndRelayMessage(c.env, senderId, messageId, text));
    return c.json({ code: 0, msg: "success" });
  }

  return c.json({ code: 0, msg: "ignored" });
});

/**
 * Background task to:
 * 1. Send the message to Moltbot.
 * 2. Wait for Moltbot's reply.
 * 3. Send the reply back to Feishu via OpenAPI.
 */
async function processAndRelayMessage(env: Bindings, senderId: string, messageId: string, text: string) {
  try {
    // --------------------------------------------------------------------------------
    // STEP 1: Get Feishu Tenant Access Token
    // --------------------------------------------------------------------------------
    const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: env.FEISHU_APP_ID,
        app_secret: env.FEISHU_APP_SECRET
      })
    });
    const tokenData = await tokenRes.json();
    const tenantAccessToken = tokenData.tenant_access_token;

    // --------------------------------------------------------------------------------
    // STEP 2: Relay to Moltbot over WebSocket
    // OpenClaw websocket interface expects specific protobuf/json frames.
    // NOTE: This relies on the standard OpenClaw WebChat payload.
    // --------------------------------------------------------------------------------
    const moltUrl = new URL(env.MOLTBOT_URL);
    if (env.MOLTBOT_TOKEN) {
      moltUrl.searchParams.set('token', env.MOLTBOT_TOKEN);
    }
    
    const wsRes = await fetch(moltUrl.toString(), {
      headers: { "Upgrade": "websocket" }
    });
    const ws = wsRes.webSocket;
    
    if (!ws) {
      throw new Error("Failed to connect to Moltbot WebSocket");
    }
    
    ws.accept();
    
    // Format required by OpenClaw to process the message.
    // In production, you might need to adjust this depending on the OpenClaw Gateway version.
    const messagePayload = JSON.stringify({
      type: "chat",
      content: text,
      channel: "feishu",
      userId: senderId
    });
    
    ws.send(messagePayload);

    // Let's assume Moltbot replies immediately and we read the first response
    // For a robust implementation, you need a message listener that correlates IDs.
    let assistantReply = "I received your message, but the Moltbot response parser needs implementation!";
    
    // We wait asynchronously for a message
    await new Promise<void>((resolve) => {
      ws.addEventListener('message', (event) => {
        try {
          const rawData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
          // Simplified: you will need to parse OpenClaw's output format here
          // e.g., const parsed = JSON.parse(rawData);
          // assistantReply = parsed.text;
          assistantReply = "Moltbot: " + rawData;
        } catch (e) {
          console.error("Parse error", e);
        }
        resolve();
      });
      // Safety timeout
      setTimeout(() => resolve(), 10000);
    });

    ws.close();

    // --------------------------------------------------------------------------------
    // STEP 3: Reply to the sender in Feishu
    // --------------------------------------------------------------------------------
    await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${tenantAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        msg_type: "text",
        content: JSON.stringify({ text: assistantReply })
      })
    });

  } catch (error) {
    console.error("Failed to relay message", error);
  }
}

export default app;
