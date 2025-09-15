// Quick Deepgram Diagnostic Script
// Save this as deepgram-test.js and run with: node deepgram-test.js

const { createClient } = require('@deepgram/sdk');
require('dotenv').config();

async function testDeepgramConnection() {
    console.log('🔍 Deepgram Connection Diagnostic\n');
    
    // 1. Check environment
    const apiKey = process.env.DEEPGRAM_API_KEY;
    console.log('1. Environment Check:');
    console.log(`   API Key Present: ${!!apiKey}`);
    console.log(`   API Key Length: ${apiKey?.length || 'N/A'}`);
    console.log(`   API Key Preview: ${apiKey ? apiKey.substring(0, 8) + '...' : 'MISSING'}\n`);
    
    if (!apiKey) {
        console.error('❌ DEEPGRAM_API_KEY not found in environment variables');
        console.log('💡 Create a .env file with: DEEPGRAM_API_KEY=your_key_here');
        return;
    }
    
    // 2. Test client creation
    console.log('2. Client Creation:');
    let client;
    try {
        client = createClient(apiKey);
        console.log('   ✅ Deepgram client created successfully\n');
    } catch (error) {
        console.error('   ❌ Failed to create Deepgram client:', error.message);
        return;
    }
    
    // 3. Test simple API call (get models)
    console.log('3. API Authentication Test:');
    try {
        const models = await client.manage.getProjectModels(process.env.DEEPGRAM_PROJECT_ID || 'default');
        console.log('   ✅ API authentication successful');
        console.log(`   Available models: ${models?.length || 0}\n`);
    } catch (error) {
        console.error('   ❌ API authentication failed:', error.message);
        if (error.message.includes('401')) {
            console.log('   💡 This suggests your API key is invalid');
        }
        console.log('');
    }
    
    // 4. Test WebSocket connection
    console.log('4. WebSocket Connection Test:');
    try {
        const connection = client.listen.live({
            model: 'nova-2-general', // Try a different model
            language: 'en-US',
            encoding: 'linear16',
            sample_rate: 16000,
            channels: 1,
            smart_format: true,
            interim_results: false, // Simplified for testing
            vad_events: false
        });
        
        connection.on('open', () => {
            console.log('   ✅ WebSocket connection opened successfully');
            console.log('   🎉 Your Deepgram setup is working!\n');
            
            // Send a small test audio buffer (silence)
            const silenceBuffer = Buffer.alloc(1600, 0); // 100ms of silence
            connection.send(silenceBuffer);
            
            // Close after test
            setTimeout(() => {
                connection.finish();
                console.log('   ✅ Test completed successfully');
                process.exit(0);
            }, 2000);
        });
        
        connection.on('error', (error) => {
            console.error('   ❌ WebSocket connection failed:', error.message);
            console.log('   🔧 Suggested fixes:');
            console.log('      - Verify your API key is correct');
            console.log('      - Check if you have active credits');
            console.log('      - Try a different model (nova-2-general, base, enhanced)');
            console.log('      - Contact Deepgram support if issue persists\n');
            process.exit(1);
        });
        
        connection.on('close', () => {
            console.log('   🔌 Connection closed');
        });
        
    } catch (error) {
        console.error('   ❌ Failed to create WebSocket connection:', error.message);
        process.exit(1);
    }
}

// Run the diagnostic
testDeepgramConnection().catch(console.error);