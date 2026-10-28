import { configureStore } from '@reduxjs/toolkit';

const initialState = {
  theme: localStorage.getItem('theme') || 'light',
  sidebarOpen: true,
  notifications: [],
};

const uiSlice = {
  name: 'ui',
  initialState,
  reducers: {
    setTheme: (state, action) => {
      state.theme = action.payload;
      localStorage.setItem('theme', action.payload);
    },
    toggleTheme: (state) => {
      const newTheme = state.theme === 'light' ? 'dark' : 'light';
      state.theme = newTheme;
      localStorage.setItem('theme', newTheme);
    },
    setSidebarOpen: (state, action) => {
      state.sidebarOpen = action.payload;
    },
    toggleSidebar: (state) => {
      state.sidebarOpen = !state.sidebarOpen;
    },
    addNotification: (state, action) => {
      state.notifications.push({
        id: Date.now(),
        ...action.payload,
        timestamp: new Date().toISOString()
      });
    },
    removeNotification: (state, action) => {
      state.notifications = state.notifications.filter(n => n.id !== action.payload);
    },
    clearNotifications: (state) => {
      state.notifications = [];
    }
  }
};

const authSlice = {
  name: 'auth',
  initialState: {
    user: JSON.parse(localStorage.getItem('user') || 'null'),
    token: localStorage.getItem('token') || null,
    isAuthenticated: !!localStorage.getItem('token'),
  },
  reducers: {
    setUser: (state, action) => {
      state.user = action.payload.user;
      state.token = action.payload.token;
      state.isAuthenticated = true;
      localStorage.setItem('user', JSON.stringify(action.payload.user));
      localStorage.setItem('token', action.payload.token);
    },
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.isAuthenticated = false;
      localStorage.removeItem('user');
      localStorage.removeItem('token');
    }
  }
};

const chatSlice = {
  name: 'chat',
  initialState: {
    currentChat: null,
    messages: [],
    typing: false,
    activeChats: [],
    waitingChats: [],
  },
  reducers: {
    setCurrentChat: (state, action) => {
      state.currentChat = action.payload;
    },
    addMessage: (state, action) => {
      if (state.currentChat && state.currentChat.id === action.payload.chatId) {
        state.messages.push(action.payload.message);
      }
    },
    setTyping: (state, action) => {
      state.typing = action.payload;
    },
    setActiveChats: (state, action) => {
      state.activeChats = action.payload;
    },
    setWaitingChats: (state, action) => {
      state.waitingChats = action.payload;
    }
  }
};

const rootReducer = {
  reducer: {
    ui: uiSlice,
    auth: authSlice,
    chat: chatSlice
  }
};

export const createAppStore = () => configureStore(rootReducer);
