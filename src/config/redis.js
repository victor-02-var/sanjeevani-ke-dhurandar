import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

export const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));
redisClient.on('connect', () => console.log('🔴 Connected to Redis Server'));

// Self-connecting IIFE for startup
(async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
})();