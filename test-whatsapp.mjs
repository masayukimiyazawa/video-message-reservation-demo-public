import 'dotenv/config';
import { Vonage } from '@vonage/server-sdk';
import { readFileSync } from 'fs';

// Load credentials from .env
const credentials = {
  apiKey: process.env.VONAGE_API_KEY,
  apiSecret: process.env.VONAGE_API_SECRET,
  applicationId: process.env.VONAGE_APPLICATION_ID,
  privateKey: process.env.VONAGE_PRIVATE_KEY_PATH,
};

const vonage = new Vonage(credentials, {
  apiHost: process.env.VONAGE_MESSAGES_API_HOST || 'https://messages-sandbox.nexmo.com'
});

async function sendTestMessage() {
  const from = process.env.VONAGE_WHATSAPP_FROM;
  const to = process.argv[2]; // Recipient number as argument

  if (!to) {
    console.error('Usage: node test-whatsapp.mjs <recipient_number>');
    console.error('Example: node test-whatsapp.mjs 819012345678');
    process.exit(1);
  }

  console.log('Sending test WhatsApp message...');
  console.log('From:', process.env.VONAGE_WHATSAPP_FROM);
  console.log('To:', to);

  try {
    const response = await vonage.messages.send({
      channel: 'whatsapp',
      message_type: 'text',
      to: to,
      from: process.env.VONAGE_WHATSAPP_FROM,
      text: `Test message from Vonage Video Reservation App at ${new Date().toLocaleString()}\n\nThis is a test of the WhatsApp integration.\nYour video join link would appear here in production.`
    });

    console.log('✅ Message sent successfully!');
    console.log('Response:', JSON.stringify(response, null, 2));
  } catch (error) {
    console.error('❌ Failed to send message:');
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

sendTestMessage();