import { io } from 'socket.io-client';
import { API_BASE } from './api';

const SOCKET_URL = API_BASE;

class SocketService {
  constructor() {
    this.socket = null;
    this.listeners = new Map();
  }

  connect(token) {
    if (this.socket?.connected) return;

    this.socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });

    this.setupEventListeners();
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  setupEventListeners() {
    this.socket.on('connect', () => {});

    this.socket.on('disconnect', () => {});

    this.socket.on('error', (error) => {
      console.error('Socket error:', error);
    });

    this.socket.on('new_message', (data) => {
      this.emit('message', data);
    });

    this.socket.on('new_chat', (data) => {
      this.emit('new_chat', data);
    });

    this.socket.on('new_chat_in_queue', (data) => {
      this.emit('queue_update', data);
    });

    this.socket.on('agent_assigned', (data) => {
      this.emit('agent_assigned', data);
    });

    this.socket.on('chat_closed', (data) => {
      this.emit('chat_closed', data);
    });

    this.socket.on('chat_event', (data) => {
      this.emit('chat_event', data);
    });

    this.socket.on('user_typing', (data) => {
      this.emit('typing', data);
    });

    this.socket.on('user_status', (data) => {
      this.emit('user_status', data);
    });

    this.socket.on('new_log', (data) => {
      this.emit('new_log', data);
    });

    this.socket.on('whatsapp_error', (data) => {
      this.emit('whatsapp_error', data);
    });

    this.socket.on('whatsapp_account_alert', (data) => {
      this.emit('whatsapp_account_alert', data);
    });

    this.socket.on('campaign_created', (data) => {
      this.emit('campaign_update', data);
    });

    this.socket.on('campaign_update', (data) => {
      this.emit('campaign_update', data);
    });

    this.socket.on('admin_ip_alert', (data) => {
      this.emit('admin_ip_alert', data);
    });

    // Ligacoes do WhatsApp (VoiceCallDock). Evento fora desta lista nunca chega
    // na tela, mesmo que o servidor mande.
    ['voice_call_ringing', 'voice_call_ringing_stop', 'voice_call_ended'].forEach((evento) => {
      this.socket.on(evento, (data) => this.emit(evento, data));
    });
  }

  authenticate(token) {
    this.socket.emit('authenticate', token);
  }

  joinQueue(queueName) {
    this.socket.emit('join_queue', queueName);
  }

  subscribeTenant(tenantId) {
    if (!tenantId || !this.socket) return;
    this.socket.emit('subscribe_tenant', tenantId);
  }

  leaveQueue(queueName) {
    this.socket.emit('leave_queue', queueName);
  }

  sendMessage(chatId, message) {
    this.socket.emit('chat_message', { chatId, message });
  }

  sendTyping(chatId, isTyping) {
    this.socket.emit('chat_typing', { chatId, isTyping });
  }

  sendHeartbeat() {
    this.socket.emit('heartbeat');
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => callback(data));
    }
  }
}

export const socketService = new SocketService();
