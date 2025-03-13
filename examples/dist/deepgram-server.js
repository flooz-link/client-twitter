"use strict";
/**
 * Deepgram WebSocket Transcription Server Example
 *
 * This server receives audio from clients via WebSockets,
 * sends it to Deepgram for real-time transcription,
 * and returns the transcription results back to the client.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var express_1 = __importDefault(require("express"));
var http_1 = __importDefault(require("http"));
var ws_1 = require("ws");
var dotenv_1 = __importDefault(require("dotenv"));
var url_1 = require("url");
var path_1 = require("path");
var sdk_1 = require("@deepgram/sdk");
// Get the directory name of the current module (ES modules don't have __dirname)
var __filename = (0, url_1.fileURLToPath)(import.meta.url);
var __dirname = (0, path_1.dirname)(__filename);
// Load environment variables from .env file
dotenv_1.default.config();
// Create Express app
var app = (0, express_1.default)();
// Serve static files from the public directory
app.use(express_1.default.static((0, path_1.join)(__dirname, 'public')));
// Create HTTP server
var server = http_1.default.createServer(app);
var wss = new ws_1.WebSocketServer({ server: server });
// Initialize Deepgram
var deepgramApiKey = process.env.DEEPGRAM_API_KEY || '';
console.log('Initializing Deepgram with API key:', deepgramApiKey ? 'API key found' : 'No API key found');
var deepgramClient = (0, sdk_1.createClient)(deepgramApiKey);
// Keep alive interval for Deepgram connections
var keepAlive = null;
/**
 * Helper function to process audio data before sending to Deepgram
 * This extracts PCM data from WebM or other formats
 */
function processAudioData(data) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            // Check if the data is in WebM format (starts with "1a 45 df a3")
            if (data.length > 4 &&
                data[0] === 0x1a &&
                data[1] === 0x45 &&
                data[2] === 0xdf &&
                data[3] === 0xa3) {
                console.log('Detected WebM format, extracting audio data');
                // For WebM, we need to extract the audio data
                // This is a simplified approach - in a production app, you'd use a proper WebM parser
                // For now, we'll just return the raw data and let Deepgram try to handle it
                return [2 /*return*/, data];
            }
            // Check if the data is in WAV format (starts with "RIFF" header)
            if (data.length > 44 &&
                data.toString('ascii', 0, 4) === 'RIFF' &&
                data.toString('ascii', 8, 12) === 'WAVE') {
                console.log('Detected WAV format, extracting PCM data');
                // Skip the WAV header (44 bytes) and return only the PCM data
                return [2 /*return*/, data.slice(44)];
            }
            // If not in a recognized format, return as is
            return [2 /*return*/, data];
        });
    });
}
/**
 * Set up a new Deepgram connection for a client
 */
var setupDeepgram = function (ws) {
    // Create a Deepgram live transcription socket with proper configuration
    var deepgramLive = deepgramClient.listen.live({
        language: 'en',
        punctuate: true,
        smart_format: true,
        model: 'nova-3',
        encoding: 'linear16', // Changed back to linear16 which is definitely supported
        sample_rate: 48000,
        channels: 1,
        interim_results: true,
        utterance_end_ms: 1000,
        vad_events: true,
        endpointing: 800,
    });
    console.log('Deepgram socket created with configuration:', {
        encoding: 'linear16',
        sample_rate: 48000,
        channels: 1,
        model: 'nova-3',
    });
    // Set up keep-alive to maintain the connection
    if (keepAlive)
        clearInterval(keepAlive);
    keepAlive = setInterval(function () {
        console.log('deepgram: keepalive');
        deepgramLive.keepAlive();
    }, 10 * 1000);
    // Set up event listeners for the Deepgram socket
    deepgramLive.addListener(sdk_1.LiveTranscriptionEvents.Open, function () {
        console.log('deepgram: connected successfully');
        // Send connection status to client
        ws.send(JSON.stringify({ status: 'connected', ready: true }, null, 2));
    });
    deepgramLive.addListener(sdk_1.LiveTranscriptionEvents.Error, function (error) {
        console.error('deepgram: error', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
        }, null, 2));
    });
    deepgramLive.addListener(sdk_1.LiveTranscriptionEvents.Close, function () {
        console.log('deepgram: connection closed');
        clearInterval(keepAlive);
        deepgramLive.finish();
        ws.send(JSON.stringify({ status: 'disconnected' }, null, 2));
    });
    deepgramLive.addListener(sdk_1.LiveTranscriptionEvents.Metadata, function (metadata) {
        console.log('deepgram: received metadata', metadata);
        ws.send(JSON.stringify({ type: 'metadata', metadata: metadata }, null, 2));
    });
    deepgramLive.addListener(sdk_1.LiveTranscriptionEvents.Transcript, function (data) {
        var _a, _b, _c, _d, _e;
        var transcript = (_c = (_b = (_a = data.channel) === null || _a === void 0 ? void 0 : _a.alternatives) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.transcript;
        // Log detailed information about the transcript
        console.log('[DEBUG] Deepgram transcript event received:', JSON.stringify({
            transcript: transcript,
            is_final: data.is_final,
            channel_alternatives: (_e = (_d = data.channel) === null || _d === void 0 ? void 0 : _d.alternatives) === null || _e === void 0 ? void 0 : _e.map(function (alt) {
                var _a;
                return ({
                    transcript_length: ((_a = alt.transcript) === null || _a === void 0 ? void 0 : _a.length) || 0,
                });
            }),
        }, null, 2));
        if (!transcript || transcript.trim() === '') {
            console.log('[DEBUG] Empty transcript detected');
            return;
        }
        console.log("deepgram: transcript: \"".concat(transcript, "\" (final: ").concat(data.is_final, ")"));
        // Send the transcript to the client
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'transcript',
                transcript: transcript,
                is_final: data.is_final,
            }, null, 2));
        }
    });
    return deepgramLive;
};
// Handle WebSocket connections
wss.on('connection', function (ws) {
    console.log('socket: client connected');
    // Create a new Deepgram connection for this client
    var deepgramLive = setupDeepgram(ws);
    // Handle messages from client (audio data)
    ws.on('message', function (message) { return __awaiter(void 0, void 0, void 0, function () {
        var processedData, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 4, , 5]);
                    console.log('socket: received audio data from client');
                    if (!(deepgramLive.getReadyState() === sdk_1.SOCKET_STATES.open)) return [3 /*break*/, 2];
                    return [4 /*yield*/, processAudioData(message)];
                case 1:
                    processedData = _a.sent();
                    // Send the processed audio data to Deepgram
                    deepgramLive.send(processedData);
                    console.log('socket: processed data sent to deepgram');
                    // Send a confirmation to the client
                    ws.send(JSON.stringify({ status: 'processing_audio' }, null, 2));
                    return [3 /*break*/, 3];
                case 2:
                    if (deepgramLive.getReadyState() >= 2) {
                        // CLOSING or CLOSED
                        console.log('socket: Deepgram connection is not open, reconnecting...');
                        // Clean up the old connection
                        deepgramLive.finish();
                        deepgramLive.removeAllListeners();
                        // Create a new connection
                        deepgramLive = setupDeepgram(ws);
                        // Let the client know we're reconnecting
                        ws.send(JSON.stringify({ status: 'reconnecting' }, null, 2));
                    }
                    else {
                        console.log('socket: Deepgram connection is not ready yet');
                        ws.send(JSON.stringify({ status: 'waiting_for_connection' }, null, 2));
                    }
                    _a.label = 3;
                case 3: return [3 /*break*/, 5];
                case 4:
                    error_1 = _a.sent();
                    console.error('Error processing audio data:', error_1);
                    ws.send(JSON.stringify({
                        status: 'error',
                        message: error_1 instanceof Error ? error_1.message : String(error_1),
                    }, null, 2));
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    }); });
    // Handle WebSocket close
    ws.on('close', function () {
        console.log('socket: client disconnected');
        // Clean up Deepgram connection when client disconnects
        if (deepgramLive) {
            deepgramLive.finish();
            deepgramLive.removeAllListeners();
            deepgramLive = null;
        }
    });
    // Send ready message to client
    ws.send(JSON.stringify({ status: 'ready' }, null, 2));
});
// Start the server
var PORT = process.env.PORT || 3000;
server.listen(PORT, function () {
    var address = server.address();
    console.log("http://localhost:".concat(address.port));
});
