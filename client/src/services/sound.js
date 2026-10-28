class SoundService {
  constructor() {
    this.enabled = localStorage.getItem('soundEnabled') !== 'false';
    this.volume = parseFloat(localStorage.getItem('soundVolume')) || 0.5;
    this.audioContext = null;
    this.sounds = {};
  }

  async init() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    localStorage.setItem('soundEnabled', enabled);
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    localStorage.setItem('soundVolume', this.volume);
  }

  async play(type) {
    if (!this.enabled) return;

    await this.init();

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    switch (type) {
      case 'new_message':
        oscillator.frequency.setValueAtTime(800, this.audioContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(400, this.audioContext.currentTime + 0.1);
        gainNode.gain.setValueAtTime(this.volume * 0.3, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.2);
        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + 0.2);
        break;

      case 'new_chat':
        oscillator.frequency.setValueAtTime(600, this.audioContext.currentTime);
        oscillator.frequency.setValueAtTime(900, this.audioContext.currentTime + 0.1);
        oscillator.frequency.setValueAtTime(600, this.audioContext.currentTime + 0.2);
        gainNode.gain.setValueAtTime(this.volume * 0.3, this.audioContext.currentTime);
        gainNode.gain.setValueAtTime(this.volume * 0.3, this.audioContext.currentTime + 0.1);
        gainNode.gain.setValueAtTime(this.volume * 0.3, this.audioContext.currentTime + 0.2);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.3);
        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + 0.3);
        break;

      case 'typing':
        oscillator.frequency.setValueAtTime(1200, this.audioContext.currentTime);
        gainNode.gain.setValueAtTime(this.volume * 0.1, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.05);
        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + 0.05);
        break;

      case 'notification':
        oscillator.frequency.setValueAtTime(1000, this.audioContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(500, this.audioContext.currentTime + 0.15);
        gainNode.gain.setValueAtTime(this.volume * 0.25, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.15);
        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + 0.15);
        break;

      case 'success':
        oscillator.frequency.setValueAtTime(523.25, this.audioContext.currentTime);
        oscillator.frequency.setValueAtTime(659.25, this.audioContext.currentTime + 0.1);
        oscillator.frequency.setValueAtTime(783.99, this.audioContext.currentTime + 0.2);
        gainNode.gain.setValueAtTime(this.volume * 0.3, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.3);
        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + 0.3);
        break;

      case 'error':
        oscillator.type = 'sawtooth';
        oscillator.frequency.setValueAtTime(200, this.audioContext.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(100, this.audioContext.currentTime + 0.2);
        gainNode.gain.setValueAtTime(this.volume * 0.2, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.2);
        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + 0.2);
        break;

      default:
        oscillator.frequency.setValueAtTime(440, this.audioContext.currentTime);
        gainNode.gain.setValueAtTime(this.volume * 0.2, this.audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
        oscillator.start(this.audioContext.currentTime);
        oscillator.stop(this.audioContext.currentTime + 0.1);
    }
  }

  async playCustom(frequency, duration, volume = this.volume) {
    if (!this.enabled) return;

    await this.init();

    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
    gainNode.gain.setValueAtTime(volume * 0.3, this.audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration);

    oscillator.start(this.audioContext.currentTime);
    oscillator.stop(this.audioContext.currentTime + duration);
  }
}

export const soundService = new SoundService();
