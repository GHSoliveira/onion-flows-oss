/**
 * Environment configuration
 */
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });

export const config = {
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '8h',
  PORT: process.env.PORT || 3001,
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://localhost:27017/chatbot',
  DB_ADAPTER: process.env.DB_ADAPTER || 'mongo',
  SUPABASE_URL: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
};
