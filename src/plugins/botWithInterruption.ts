class BotWithInterruption {
    private isSpeaking = false;
    private audioBuffer: Int16Array[] = [];
    private bufferSize = 5; // Analyze last 5 frames
    private energyThreshold = 10000; // Adjust based on testing
    private frameCountThreshold = 3; // Need 3 high-energy frames
  
    // Called whenever new audio data arrives
    onAudioData(samples: Int16Array) {
      if (this.isSpeaking) {
        this.checkForInterruption(samples);
      }
    }
  
    // Add audio to buffer and check for interruption
    private checkForInterruption(samples: Int16Array) {
      this.audioBuffer.push(samples);
      if (this.audioBuffer.length > this.bufferSize) {
        this.audioBuffer.shift(); // Remove oldest frame
      }
  
      let highEnergyCount = 0;
      for (const frame of this.audioBuffer) {
        const energy = this.calculateEnergy(frame);
        if (energy > this.energyThreshold) {
          highEnergyCount++;
          if (highEnergyCount >= this.frameCountThreshold) {
            this.stopSpeaking();
            break;
          }
        } else {
          highEnergyCount = 0; // Reset if no speech detected
        }
      }
    }
  
    // Calculate average energy of an audio frame
    private calculateEnergy(samples: Int16Array): number {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += Math.abs(samples[i]);
      }
      return sum / samples.length;
    }
  
    // Stop the bot's speech
    private stopSpeaking() {
      console.log("Interruption detected, stopping speech");
      this.isSpeaking = false;
      // Add code to abort TTS (e.g., abortController.abort())
      // Clear any speech queue
    }
  
    // Start speaking (for demonstration)
    startSpeaking() {
      this.isSpeaking = true;
      console.log("Bot is speaking...");
    }
  }
  
  // Usage
  const bot = new BotWithInterruption();
  bot.startSpeaking();
  // Simulate audio input with samples
  bot.onAudioData(new Int16Array([5000, 6000, 7000])); // Low energy
  bot.onAudioData(new Int16Array([15000, 16000, 17000])); // High energy
  bot.onAudioData(new Int16Array([18000, 19000, 20000])); // Triggers stop