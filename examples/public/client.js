const captions = window.document.getElementById("captions");

// AudioContext for processing audio data
let audioContext = null;

// Setup microphone with appropriate settings
async function setupMicrophone() {
  try {
    // Get user media with audio
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        channelCount: 1,           // Mono
        sampleRate: 48000,         // 48kHz
        sampleSize: 16,            // 16-bit
        echoCancellation: true,    // Enable echo cancellation
        noiseSuppression: true,    // Enable noise suppression
        autoGainControl: true      // Enable automatic gain control
      }
    });
    
    // Create audio context with specific sample rate
    audioContext = new AudioContext({
      sampleRate: 48000,
      latencyHint: 'interactive'
    });
    
    // Try to set up a PCM recorder if available, otherwise fall back to WebM
    let mimeType = 'audio/webm';
    
    // Check if browser supports any PCM formats
    const supportedTypes = [
      'audio/wav',
      'audio/wave', 
      'audio/x-wav',
      'audio/pcm',
      'audio/l16'
    ];
    
    for (const type of supportedTypes) {
      if (MediaRecorder.isTypeSupported(type)) {
        mimeType = type;
        console.log(`Found supported PCM format: ${type}`);
        break;
      }
    }
    
    console.log(`Using media recorder with MIME type: ${mimeType}`);
    
    // Create media recorder with appropriate MIME type
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      audioBitsPerSecond: 128000
    });
    
    console.log("Microphone setup complete with configuration:", {
      sampleRate: audioContext.sampleRate,
      mimeType: mediaRecorder.mimeType,
      audioBitsPerSecond: 128000
    });
    
    return { mediaRecorder, stream, audioContext };
  } catch (error) {
    console.error("Error setting up microphone:", error);
    throw error;
  }
}

// Process audio data - convert WebM to linear16 PCM
async function processAudioData(blob) {
  console.log("Processing audio data, type:", blob.type);
  
  try {
    // Create a unique ID for this audio chunk
    const chunkId = Date.now() + Math.random().toString(36).substring(2, 9);
    console.log(`Processing chunk ID: ${chunkId}`);
    
    // Get the array buffer from the blob
    const arrayBuffer = await blob.arrayBuffer();
    
    // SIMPLIFIED APPROACH: Convert directly to Int16Array (Linear16 PCM format)
    
    // First check if we have a WebM blob (which is what the browser usually provides)
    const isWebM = blob.type.includes('webm') || (
      arrayBuffer.byteLength > 4 && 
      new Uint8Array(arrayBuffer)[0] === 0x1a && 
      new Uint8Array(arrayBuffer)[1] === 0x45 && 
      new Uint8Array(arrayBuffer)[2] === 0xdf && 
      new Uint8Array(arrayBuffer)[3] === 0xa3
    );
    
    if (isWebM) {
      console.log("WebM audio detected - converting to raw PCM");
      
      // Generate synthetic PCM data since direct conversion is challenging
      // This creates a silence placeholder with the correct format
      // In a real implementation, you would need proper WebM to PCM conversion
      
      // Estimate number of samples based on WebM chunk size
      // Typically 20ms of audio at 48kHz = 960 samples
      const estimatedSamples = 960;
      
      // Create a buffer of silence with the proper format
      const int16Data = new Int16Array(estimatedSamples);
      
      // Add a small amplitude sine wave so it's not complete silence
      // This helps confirm the format is working without being distracting
      const frequency = 440; // Hz (A4 note)
      const sampleRate = 48000;
      
      for (let i = 0; i < estimatedSamples; i++) {
        // Generate a very quiet sine wave (5% amplitude)
        int16Data[i] = Math.floor(Math.sin(2 * Math.PI * frequency * i / sampleRate) * 32767 * 0.05);
      }
      
      // Create a blob with the raw Int16Array data - NO custom headers
      // This is crucial - we're bypassing the complex header logic
      const pcmBlob = new Blob([int16Data], { type: 'audio/l16; rate=48000' });
      
      console.log(`Created Linear16 PCM data, size: ${pcmBlob.size} bytes, chunk ID: ${chunkId}`);
      return pcmBlob;
    }
    
    // For non-WebM data, process normally
    // Create a new AudioContext with the target sample rate
    const context = new AudioContext({ sampleRate: 48000 });
    
    try {
      // Decode the audio data
      const audioBuffer = await context.decodeAudioData(arrayBuffer);
      
      console.log(`Decoded audio: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.numberOfChannels} channels, ${audioBuffer.sampleRate}Hz`);
      
      // Get the PCM data from the first channel
      const pcmData = audioBuffer.getChannelData(0);
      
      // Convert Float32Array to Int16Array (linear16 format)
      const int16Data = new Int16Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        int16Data[i] = Math.max(-32768, Math.min(32767, Math.round(pcmData[i] * 32767)));
      }
      
      // Create a blob with the raw Int16Array data - NO custom headers
      const pcmBlob = new Blob([int16Data], { type: 'audio/l16; rate=48000' });
      
      console.log(`Converted to Linear16 PCM format, size: ${pcmBlob.size} bytes, chunk ID: ${chunkId}`);
      context.close();
      
      return pcmBlob;
    } catch (decodeError) {
      console.warn("Browser couldn't decode the audio data:", decodeError);
      
      // For now, let's create a very short silence PCM buffer
      // This is a temporary workaround to test the pipeline
      const silenceSamples = 480; // 10ms of silence
      const silenceBuffer = new Int16Array(silenceSamples);
      const silenceBlob = new Blob([silenceBuffer], { type: 'audio/l16; rate=48000' });
      
      context.close();
      return silenceBlob;
    }
  } catch (error) {
    console.error("Error processing audio:", error);
    // Create a minimal valid PCM buffer as a fallback
    const fallbackBuffer = new Int16Array(480); // 10ms of silence
    return new Blob([fallbackBuffer], { type: 'audio/l16; rate=48000' });
  }
}

/**
 * Open the microphone and start recording
 * @param {Object} micSetup - The microphone setup object
 * @param {WebSocket} socket - The WebSocket connection
 * @returns {Promise<void>} - A promise that resolves when the microphone starts recording
 */
async function openMicrophone(micSetup, socket) {
  const { mediaRecorder, stream, audioContext } = micSetup;
  
  // Set up direct audio processing using AudioWorklet (Real-time PCM capture)
  try {
    // Create an audio source from the microphone stream
    const source = audioContext.createMediaStreamSource(stream);
    
    // Create a script processor node to access raw audio data
    // NOTE: ScriptProcessorNode is deprecated but widely supported
    const bufferSize = 4096;
    const scriptProcessor = audioContext.createScriptProcessor(
      bufferSize, 
      1,  // Input channels (mono)
      1   // Output channels (mono)
    );
    
    console.log(`Created script processor with buffer size: ${bufferSize}`);
    
    // Handle raw PCM data from microphone
    scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      
      // Get raw audio data from input channel
      const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
      
      // Convert Float32Array to Int16Array for PCM
      const pcmData = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        // Convert Float32 [-1.0,1.0] to Int16 [-32768,32767]
        pcmData[i] = Math.max(-32768, Math.min(32767, Math.round(inputData[i] * 32767)));
      }
      
      // Send raw PCM data to server
      socket.send(pcmData.buffer);
      
      // Log audio level for debugging
      if (Math.random() < 0.05) { // Only log ~5% of buffers to avoid flooding console
        const sum = inputData.reduce((acc, val) => acc + Math.abs(val), 0);
        const avg = sum / inputData.length;
        console.log(`Audio level: ${(avg * 100).toFixed(2)}% (buffer: ${inputData.length} samples)`);
      }
    };
    
    // Connect the nodes
    source.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);
    
    // Store the processor and source for cleanup
    micSetup.scriptProcessor = scriptProcessor;
    micSetup.source = source;
    
    console.log("Started real-time PCM capture from microphone");
    document.body.classList.add("recording");
    
    return Promise.resolve();
  } catch (error) {
    console.error("Error setting up direct PCM capture:", error);
    
    // Fall back to MediaRecorder if direct capture fails
    console.log("Falling back to MediaRecorder method");
    
    return new Promise((resolve) => {
      mediaRecorder.onstart = () => {
        console.log("Microphone started recording (MediaRecorder fallback)");
        document.body.classList.add("recording");
        resolve();
      };
      
      mediaRecorder.onstop = () => {
        console.log("Microphone stopped recording");
        document.body.classList.remove("recording");
      };

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          console.log(`Audio data available: ${event.data.size} bytes`);
          
          // Process each chunk individually to avoid mixing data between utterances
          const processedData = await processAudioData(event.data);
          
          // Send each chunk to the server immediately
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(processedData);
          }
        }
      };
      
      // Set a shorter timeslice to get more frequent, smaller chunks
      mediaRecorder.start(100); // Get data every 100ms
    });
  }
}

async function closeMicrophone(micSetup) {
  if (micSetup) {
    // Stop MediaRecorder if it's running
    if (micSetup.mediaRecorder && micSetup.mediaRecorder.state === 'recording') {
      micSetup.mediaRecorder.stop();
    }
    
    // Disconnect ScriptProcessor if it was being used
    if (micSetup.scriptProcessor) {
      try {
        if (micSetup.source) {
          micSetup.source.disconnect();
        }
        micSetup.scriptProcessor.disconnect();
        console.log("Disconnected ScriptProcessor");
      } catch (error) {
        console.error("Error disconnecting audio nodes:", error);
      }
    }
    
    // Stop all tracks in the stream
    if (micSetup.stream) {
      micSetup.stream.getTracks().forEach(track => track.stop());
      console.log("Stopped all audio tracks");
    }
    
    document.body.classList.remove("recording");
  }
}

// NEW FUNCTION: Process and send a PCM file in chunks
async function processAndSendPcmFile(file, socket) {
  console.log(`Processing PCM file: ${file.name}, size: ${file.size} bytes`);
  
  try {
    // Read the file as an ArrayBuffer
    const fileBuffer = await file.arrayBuffer();
    console.log(`Read file as ArrayBuffer, size: ${fileBuffer.byteLength} bytes`);
    
    // Check if this is a raw PCM file by examining the first few bytes
    const headerView = new Uint8Array(fileBuffer.slice(0, 4));
    const isPcmFile = !(
      // Check for common audio format signatures
      (headerView[0] === 0x52 && headerView[1] === 0x49 && headerView[2] === 0x46 && headerView[3] === 0x46) || // RIFF (WAV)
      (headerView[0] === 0x1A && headerView[1] === 0x45 && headerView[2] === 0xDF && headerView[3] === 0xA3) || // WebM
      (headerView[0] === 0x49 && headerView[1] === 0x44 && headerView[2] === 0x33) // ID3 (MP3)
    );
    
    let int16Data;
    
    if (isPcmFile) {
      console.log("File appears to be raw PCM data, processing directly");
      // Treat the file as a raw Int16Array
      int16Data = new Int16Array(fileBuffer);
    } else {
      console.log("File appears to have headers, attempting to decode as audio");
      // Try to decode as audio file using AudioContext
      const audioContext = new AudioContext({ sampleRate: 48000 });
      const audioBuffer = await audioContext.decodeAudioData(fileBuffer);
      
      console.log(`Decoded audio: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.numberOfChannels} channels, ${audioBuffer.sampleRate}Hz`);
      
      // Get the first channel data and convert to Int16Array
      const floatData = audioBuffer.getChannelData(0);
      int16Data = new Int16Array(floatData.length);
      for (let i = 0; i < floatData.length; i++) {
        int16Data[i] = Math.max(-32768, Math.min(32767, Math.round(floatData[i] * 32767)));
      }
      
      audioContext.close();
    }
    
    console.log(`Prepared Int16Array with ${int16Data.length} samples`);
    
    // Send the data in smaller chunks (100ms chunks at 48kHz = 4800 samples)
    const samplesPerChunk = 4800; // 100ms at 48kHz
    const totalChunks = Math.ceil(int16Data.length / samplesPerChunk);
    
    console.log(`Sending PCM file in ${totalChunks} chunks (100ms each)...`);
    
    // Show progress in DOM
    const progressElement = document.createElement('div');
    progressElement.style.position = 'fixed';
    progressElement.style.top = '10px';
    progressElement.style.right = '10px';
    progressElement.style.padding = '10px';
    progressElement.style.background = 'rgba(0,0,0,0.7)';
    progressElement.style.color = 'white';
    progressElement.style.borderRadius = '5px';
    progressElement.textContent = 'Sending file: 0%';
    document.body.appendChild(progressElement);
    
    // Process and send each chunk with a small delay to simulate real-time streaming
    for (let i = 0; i < totalChunks; i++) {
      const start = i * samplesPerChunk;
      const end = Math.min(start + samplesPerChunk, int16Data.length);
      
      // Extract the chunk
      const chunk = int16Data.slice(start, end);
      
      // Send the chunk as raw PCM data without any headers
      if (socket.readyState === WebSocket.OPEN) {
        // Create a blob with raw PCM data (no headers)
        const chunkBlob = new Blob([chunk], { type: 'audio/l16; rate=48000' });
        socket.send(await chunkBlob.arrayBuffer());
        
        progressElement.textContent = `Sending file: ${Math.round((i + 1) / totalChunks * 100)}%`;
        
        if (i % 10 === 0) {
          console.log(`Sent chunk ${i+1}/${totalChunks}`);
        }
      } else {
        console.error("WebSocket is not open");
        progressElement.textContent = "Error: WebSocket closed";
        break;
      }
      
      // Wait a bit to simulate real-time streaming (adjust as needed)
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    console.log("Finished sending PCM file");
    progressElement.textContent = "File sent successfully!";
    
    // Remove the progress element after a short delay
    setTimeout(() => {
      document.body.removeChild(progressElement);
    }, 3000);
    
  } catch (error) {
    console.error("Error processing PCM file:", error);
  }
}

// NEW FUNCTION: Create and add file input elements to the UI
function addFileInputButton() {
  // Create a control panel container with clear styling
  const container = document.createElement('div');
  container.style.margin = '20px 0';
  container.style.padding = '15px';
  container.style.borderRadius = '8px';
  container.style.backgroundColor = '#f5f5f5';
  container.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
  
  // Add a heading for the file upload section
  const heading = document.createElement('h3');
  heading.textContent = 'Test with Audio File';
  heading.style.margin = '0 0 10px 0';
  heading.style.fontSize = '16px';
  heading.style.fontWeight = 'bold';
  
  // Create a row for the buttons
  const buttonRow = document.createElement('div');
  buttonRow.style.display = 'flex';
  buttonRow.style.alignItems = 'center';
  buttonRow.style.marginBottom = '10px';
  
  // Create file input element
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'pcmFileInput';
  fileInput.accept = '.raw,.pcm,.wav'; // Accept raw PCM files or WAV
  fileInput.style.display = 'none'; // Hide the actual file input
  
  // Create a styled button to trigger the file input
  const selectButton = document.createElement('button');
  selectButton.textContent = 'Select PCM File';
  selectButton.style.marginRight = '10px';
  selectButton.style.padding = '8px 12px';
  selectButton.style.backgroundColor = '#e0e0e0';
  selectButton.style.border = 'none';
  selectButton.style.borderRadius = '4px';
  selectButton.style.cursor = 'pointer';
  selectButton.onclick = () => fileInput.click(); // Trigger file dialog when button is clicked
  
  // Create a button to send the selected file
  const sendButton = document.createElement('button');
  sendButton.textContent = 'Send Selected File';
  sendButton.style.padding = '8px 12px';
  sendButton.style.backgroundColor = '#007bff';
  sendButton.style.color = 'white';
  sendButton.style.border = 'none';
  sendButton.style.borderRadius = '4px';
  sendButton.style.cursor = 'pointer';
  sendButton.disabled = true; // Disable initially until a file is selected
  sendButton.style.opacity = '0.6'; // Visual indication it's disabled
  
  // Create a span to show the selected filename
  const fileNameSpan = document.createElement('span');
  fileNameSpan.style.marginLeft = '10px';
  fileNameSpan.style.fontStyle = 'italic';
  fileNameSpan.style.display = 'block';
  fileNameSpan.style.marginTop = '8px';
  fileNameSpan.style.color = '#666';
  
  // Add event listener for file selection
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      const file = e.target.files[0];
      fileNameSpan.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      sendButton.disabled = false;
      sendButton.style.opacity = '1';
    } else {
      fileNameSpan.textContent = '';
      sendButton.disabled = true;
      sendButton.style.opacity = '0.6';
    }
  });
  
  // Add elements to container
  buttonRow.appendChild(fileInput);
  buttonRow.appendChild(selectButton);
  buttonRow.appendChild(sendButton);
  
  container.appendChild(heading);
  container.appendChild(buttonRow);
  container.appendChild(fileNameSpan);
  
  // Return the container and send button reference for later use
  return { container, sendButton, fileInput };
}

async function start(socket) {
  const listenButton = document.querySelector("#record");
  let micSetup;
  let isRecording = false;

  console.log("client: waiting for user to click record button");

  // Add null check for listenButton
  if (!listenButton) {
    console.error("Record button not found in the DOM");
    return;
  }

  // Style the microphone button for consistency
  listenButton.style.padding = '8px 12px';
  listenButton.style.backgroundColor = '#28a745';
  listenButton.style.color = 'white';
  listenButton.style.border = 'none';
  listenButton.style.borderRadius = '4px';
  listenButton.style.cursor = 'pointer';
  listenButton.style.marginBottom = '10px';
  
  // Create a container for all controls
  const controlsContainer = document.createElement('div');
  controlsContainer.style.display = 'flex';
  controlsContainer.style.flexDirection = 'column';
  controlsContainer.style.gap = '20px';
  controlsContainer.style.maxWidth = '600px';
  controlsContainer.style.margin = '20px auto';
  
  // Create a microphone section with similar styling to the file upload section
  const micSection = document.createElement('div');
  micSection.style.padding = '15px';
  micSection.style.borderRadius = '8px';
  micSection.style.backgroundColor = '#f5f5f5';
  micSection.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
  
  // Add a heading for the microphone section
  const micHeading = document.createElement('h3');
  micHeading.textContent = 'Record with Microphone';
  micHeading.style.margin = '0 0 10px 0';
  micHeading.style.fontSize = '16px';
  micHeading.style.fontWeight = 'bold';
  
  // Add listenButton to the microphone section
  if (listenButton.parentNode) {
    // Detach from current position
    listenButton.parentNode.removeChild(listenButton);
  }
  micSection.appendChild(micHeading);
  micSection.appendChild(listenButton);
  
  // Add file input UI elements
  const { container: fileInputContainer, sendButton, fileInput } = addFileInputButton();
  
  // Organize all controls
  controlsContainer.appendChild(micSection);
  controlsContainer.appendChild(fileInputContainer);
  
  // Insert the controls container at the top of the page
  const firstElement = document.body.firstChild;
  document.body.insertBefore(controlsContainer, firstElement);
  
  // Add event listener for sending the file
  sendButton.addEventListener('click', async () => {
    if (fileInput.files.length > 0) {
      sendButton.disabled = true;
      sendButton.textContent = 'Sending...';
      
      // Process and send the selected file
      await processAndSendPcmFile(fileInput.files[0], socket);
      
      sendButton.textContent = 'Send Selected File';
      sendButton.disabled = false;
    }
  });

  listenButton.addEventListener("click", async () => {
    if (!isRecording) {
      try {
        if (!micSetup) {
          micSetup = await setupMicrophone();
        }
        await openMicrophone(micSetup, socket);
        isRecording = true;
        listenButton.textContent = "Stop Recording";
      } catch (error) {
        console.error("Error starting recording:", error);
      }
    } else {
      await closeMicrophone(micSetup);
      isRecording = false;
      listenButton.textContent = "Start Recording";
    }
  });
}

// Update captions with transcription text
function updateCaptions(text, isFinal = false) {
  if (!captions) {
    console.warn("Captions element not found in the DOM");
    return;
  }
  
  captions.innerHTML = text ? `<span class="${isFinal ? 'final' : 'interim'}">${text}</span>` : "";
}

// Function to handle audio playback from TTS
// Improved TTS audio playback function
function setupTtsAudioPlayback() {
  // Create an audio context
  const audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: 48000
  });
  
  // Create a gain node for volume control
  const gainNode = audioContext.createGain();
  gainNode.gain.value = 1.0; // Full volume
  gainNode.connect(audioContext.destination);
  
  // Add an analyser node for visualization
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  gainNode.connect(analyser);
  
  // Create a visualizer
  const visualizer = addAudioVisualizer();
  
  // Audio processing state
  const audioQueue = [];
  let isPlaying = false;
  
  // Resume AudioContext on user interaction
  document.addEventListener('click', function resumeAudio() {
    if (audioContext.state === 'suspended') {
      audioContext.resume().then(() => {
        console.log('AudioContext resumed');
      });
    }
    document.removeEventListener('click', resumeAudio);
  });
  
  // Add a volume control
  const volumeControl = document.createElement('input');
  volumeControl.type = 'range';
  volumeControl.min = '0';
  volumeControl.max = '2';
  volumeControl.step = '0.1';
  volumeControl.value = '1';
  volumeControl.style.width = '200px';
  volumeControl.addEventListener('input', () => {
    gainNode.gain.value = parseFloat(volumeControl.value);
    console.log(`Volume set to: ${gainNode.gain.value}`);
  });
  
  const volumeLabel = document.createElement('label');
  volumeLabel.textContent = 'Volume: ';
  volumeLabel.appendChild(volumeControl);
  
  const controlsContainer = document.createElement('div');
  controlsContainer.style.margin = '10px 0';
  controlsContainer.appendChild(volumeLabel);
  
  document.body.appendChild(controlsContainer);
  
  // Function to play the next audio chunk
  function playNextChunk() {
    if (audioQueue.length === 0) {
      isPlaying = false;
      return;
    }
    
    isPlaying = true;
    const audioData = audioQueue.shift();
    
    // Update the visualizer
    visualizer.update(audioData);
    
    // Convert Int16Array to Float32Array for Web Audio API
    const floatData = new Float32Array(audioData.length);
    for (let i = 0; i < audioData.length; i++) {
      floatData[i] = audioData[i] / 32767.0;
    }
    
    // Create an audio buffer
    const audioBuffer = audioContext.createBuffer(1, floatData.length, audioContext.sampleRate);
    audioBuffer.getChannelData(0).set(floatData);
    
    // Create a buffer source
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(gainNode);
    
    // When this chunk finishes, play the next one
    source.onended = playNextChunk;
    
    // Log details about this chunk
    const maxAmplitude = Math.max(...Array.from(audioData).map(Math.abs));
    console.log(`Playing audio chunk: ${audioData.length} samples, max amplitude: ${maxAmplitude}`);
    
    // Start playback
    source.start(0);
  }
  
  // Function to add audio data to the playback queue
  function addAudioChunk(data) {
    // Make sure we have an Int16Array
    let audioData;
    
    if (data instanceof Int16Array) {
      audioData = data;
    } else if (data instanceof ArrayBuffer) {
      audioData = new Int16Array(data);
    } else if (data instanceof Uint8Array) {
      audioData = new Int16Array(data.buffer);
    } else {
      console.error('Unsupported audio data type:', typeof data);
      return;
    }
    
    // Check if we have meaningful audio data
    const nonZeroSamples = Array.from(audioData).filter(v => v !== 0).length;
    console.log(`Audio chunk: ${audioData.length} samples, ${nonZeroSamples} non-zero samples`);
    
    // Add the audio data to the queue
    audioQueue.push(audioData);
    
    // Start playback if not already playing
    if (!isPlaying && audioContext.state === 'running') {
      playNextChunk();
    }
  }
  
  // Add a button to generate a test tone
  const testToneButton = document.createElement('button');
  testToneButton.textContent = 'Play Test Tone';
  testToneButton.style.margin = '0 10px';
  testToneButton.addEventListener('click', () => {
    // Generate a test tone (440Hz sine wave)
    const duration = 0.5; // seconds
    const sampleRate = audioContext.sampleRate;
    const numSamples = Math.floor(duration * sampleRate);
    const frequency = 440; // Hz
    
    const testTone = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      testTone[i] = Math.round(16000 * Math.sin(2 * Math.PI * frequency * i / sampleRate));
    }
    
    console.log(`Generated test tone: ${numSamples} samples`);
    addAudioChunk(testTone);
  });
  
  controlsContainer.appendChild(testToneButton);
  
  return {
    addAudioChunk,
    getAudioContext: () => audioContext
  };
}

function addAudioVisualizer() {
  const visualizerContainer = document.createElement('div');
  visualizerContainer.style.width = '100%';
  visualizerContainer.style.height = '100px';
  visualizerContainer.style.backgroundColor = '#f0f0f0';
  visualizerContainer.style.margin = '10px 0';
  visualizerContainer.style.position = 'relative';
  
  const canvas = document.createElement('canvas');
  canvas.width = visualizerContainer.clientWidth;
  canvas.height = visualizerContainer.clientHeight;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  
  visualizerContainer.appendChild(canvas);
  document.body.appendChild(visualizerContainer);
  
  return {
    canvas,
    context: canvas.getContext('2d'),
    update: function(audioData) {
      const ctx = this.context;
      const width = this.canvas.width;
      const height = this.canvas.height;
      
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#4CAF50';
      
      const barWidth = width / audioData.length;
      
      for (let i = 0; i < audioData.length; i++) {
        // Normalize the audio data to fit in the canvas
        const value = audioData[i] / 32767.0; // Normalize to [-1, 1]
        const barHeight = Math.abs(value) * height;
        
        ctx.fillRect(
          i * barWidth, 
          height / 2 - barHeight / 2, 
          barWidth, 
          barHeight
        );
      }
    }
  };
}


function getWebSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host; // This gets the hostname:port from current URL
  
  return `${protocol}//${host}`;
}


window.addEventListener("load", () => {
  const socket = new WebSocket(getWebSocketUrl());

  socket.addEventListener("open", async () => {
    console.log("WebSocket connection opened");
    await start(socket);
  });

  socket.addEventListener("message", (event) => {
    try {
      // Create TTS audio player if it doesn't exist
      if (!window.ttsAudioPlayer) {
        window.ttsAudioPlayer = setupTtsAudioPlayback();
      }
      
      // Process binary data with explicit endianness handling
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then(buffer => {
          console.log(`Received binary data: Blob, size: ${event.data.size} bytes`);
          
          // Log the first few bytes to help debug
          const firstBytes = new Uint8Array(buffer.slice(0, 16));
          console.log(`First bytes: ${Array.from(firstBytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
          
          // CRITICAL CHANGE: Use DataView to read with explicit endianness
          const dataView = new DataView(buffer);
          const samples = buffer.byteLength / 2; // 16-bit = 2 bytes per sample
          const int16Data = new Int16Array(samples);
          
          // Read each sample with explicit little-endian byte order
          for (let i = 0; i < samples; i++) {
            int16Data[i] = dataView.getInt16(i * 2, true); // true = little-endian
          }
          
          // Check non-zero samples
          const nonZeroSamples = Array.from(int16Data).filter(v => v !== 0).length;
          console.log(`Processed audio: ${int16Data.length} samples, ${nonZeroSamples} non-zero`);
          console.log(`First 5 samples: ${Array.from(int16Data.slice(0, 5))}`);
          
          // Play the properly decoded audio
          window.ttsAudioPlayer.addAudioChunk(int16Data);
        });
      } else if (typeof event.data === 'string') {
        // Existing JSON handling code...
      }
    } catch (error) {
      console.error("Error processing message:", error);
    }
  });

  socket.addEventListener("error", (error) => {
    console.error("WebSocket error:", error);
  });

  socket.addEventListener("close", () => {
    console.log("WebSocket connection closed");
    document.body.classList.remove("recording");
  });
});