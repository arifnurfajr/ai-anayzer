module.exports = {
  // ⚠️ GANTI DENGAN API KEY DEEPSEEK ANDA ⚠️
  DEEPSEEK_API_KEY: 'sk-54c73**********1a40',
  
  // Server Configuration
  PORT: process.env.PORT || 3000,  // Gunakan env PORT jika ada (untuk hosting)
  NODE_ENV: 'production',
  
  // CORS - Allow all origins for production (atau spesifik domain)
  CORS_ORIGIN: '*',  // Untuk production, bisa diganti dengan domain spesifik
  
  // Rate Limiting - Lebih ketat untuk production
  RATE_LIMIT_WINDOW_MS: 900000,    // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: 50,     // 50 requests per window (naikkan untuk production)
  
  // File Upload - Production limits
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB (naikkan untuk production)
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'],
  
  // Trading Constants
  TRADING_PAIRS: ['XAUUSD', 'EURUSD', 'BTCUSD', 'GBPUSD', 'USDJPY', 'ETHUSD', 'US30', 'NAS100'],
  TIMEFRAMES: ['M1', 'M5', 'M15', 'H1', 'H4', 'D1', 'W1', 'MN'],
  TRADE_TYPES: ['scalping', 'intraday', 'swing', 'position'],
  
  // Response Messages
  MESSAGES: {
    NO_IMAGE: 'No chart image provided',
    INVALID_FILE_TYPE: 'Invalid file type. Only JPEG, PNG, JPG, and WEBP are allowed.',
    FILE_TOO_LARGE: 'File too large. Maximum size is 10MB.',
    RATE_LIMIT_EXCEEDED: 'Too many requests. Please try again later.',
    ANALYSIS_FAILED: 'Analysis failed. Please try again or contact support.',
    SERVER_ERROR: 'Internal server error. Please try again later.',
    DISCLAIMER: '⚠️ This is AI-generated analysis for educational purposes only. Trading involves substantial risk of loss. Past performance is not indicative of future results.'
  },
  
  // DeepSeek API Configuration
  DEEPSEEK_API_URL: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-chat',
  DEEPSEEK_TIMEOUT: 45000, // 45 seconds
  
  // OCR Configuration
  OCR_LANGUAGE: 'eng',
  OCR_TIMEOUT: 30000,
  
  // Logging
  LOG_REQUESTS: true,
  LOG_ERRORS: true
};