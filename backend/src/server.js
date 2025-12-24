const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const DeepSeekService = require('./services/deepseek-service');
const constants = require('./config/constants');

// Initialize Express
const app = express();

// ========== SECURITY MIDDLEWARE ==========
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:"]
    }
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Compression
app.use(compression());

// CORS Configuration
const corsOptions = {
  origin: constants.CORS_ORIGIN === '*' ? '*' : constants.CORS_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Pre-flight requests

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ========== RATE LIMITING ==========
const limiter = rateLimit({
  windowMs: constants.RATE_LIMIT_WINDOW_MS,
  max: constants.RATE_LIMIT_MAX_REQUESTS,
  message: {
    error: constants.MESSAGES.RATE_LIMIT_EXCEEDED,
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfter: Math.ceil(constants.RATE_LIMIT_WINDOW_MS / 60000) + ' minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  }
});

// ========== REQUEST LOGGING ==========
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  
  if (constants.LOG_REQUESTS) {
    console.log(`📥 [${requestId}] ${req.method} ${req.path} - IP: ${req.ip}`);
  }
  
  // Add request ID to request object
  req.requestId = requestId;
  
  // Log completion
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    if (constants.LOG_REQUESTS) {
      console.log(`📤 [${requestId}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    }
  });
  
  next();
});

// ========== FILE UPLOAD CONFIGURATION ==========
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: constants.MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (constants.ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(constants.MESSAGES.INVALID_FILE_TYPE));
    }
  }
});

// ========== INITIALIZE SERVICES ==========
console.log('🚀 Initializing Trading Chart Analyzer API...');
console.log(`📊 Environment: ${constants.NODE_ENV}`);
console.log(`🔑 API Key: ${constants.DEEPSEEK_API_KEY ? '✅ Configured' : '❌ NOT CONFIGURED!'}`);

if (!constants.DEEPSEEK_API_KEY || constants.DEEPSEEK_API_KEY.includes('********')) {
  console.error('❌ CRITICAL: Please update your DeepSeek API key in src/config/constants.js');
  console.error('❌ The application will not work without a valid API key!');
  process.exit(1);
}

const deepseekService = new DeepSeekService();

// ========== API ENDPOINTS ==========

// Health Check
app.get('/api/health', async (req, res) => {
  try {
    const apiStatus = await deepseekService.testConnection();
    
    res.json({
      status: 'healthy',
      service: 'Trading Chart Analyzer API',
      version: '1.0.0',
      environment: constants.NODE_ENV,
      timestamp: new Date().toISOString(),
      requestId: req.requestId,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      api: {
        deepseek: apiStatus
      },
      endpoints: {
        analyze: 'POST /api/analyze',
        health: 'GET /api/health',
        test: 'GET /api/test-keys'
      },
      limits: {
        fileSize: `${constants.MAX_FILE_SIZE / 1024 / 1024}MB`,
        rateLimit: `${constants.RATE_LIMIT_MAX_REQUESTS} requests per ${constants.RATE_LIMIT_WINDOW_MS / 60000} minutes`
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
      requestId: req.requestId
    });
  }
});

// Test Keys Endpoint
app.get('/api/test-keys', async (req, res) => {
  try {
    const apiTest = await deepseekService.testConnection();
    
    res.json({
      deepseek: {
        ok: apiTest.ok,
        message: apiTest.message,
        visionSupported: false,
        timestamp: new Date().toISOString()
      },
      requestId: req.requestId
    });
  } catch (error) {
    console.error(`[${req.requestId}] API Test Error:`, error);
    
    res.status(500).json({
      deepseek: {
        ok: false,
        message: error.message || 'API connection failed',
        visionSupported: false
      },
      error: 'API connection test failed',
      requestId: req.requestId,
      timestamp: new Date().toISOString()
    });
  }
});

// Main Analysis Endpoint
app.post('/api/analyze', limiter, upload.single('chart'), async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Validate file
    if (!req.file) {
      return res.status(400).json({
        error: constants.MESSAGES.NO_IMAGE,
        code: 'NO_IMAGE',
        requestId: req.requestId,
        timestamp: new Date().toISOString()
      });
    }
    
    // Validate file size
    if (req.file.size > constants.MAX_FILE_SIZE) {
      return res.status(413).json({
        error: constants.MESSAGES.FILE_TOO_LARGE,
        code: 'FILE_TOO_LARGE',
        maxSize: `${constants.MAX_FILE_SIZE / 1024 / 1024}MB`,
        requestId: req.requestId
      });
    }

    // Extract and validate parameters
    const symbol = (req.body.symbol || 'XAUUSD').toUpperCase().trim();
    const timeframe = (req.body.timeframe || 'H1').toUpperCase().trim();
    const tradeType = (req.body.tradeType || 'intraday').toLowerCase().trim();
    const extraNotes = (req.body.extraNotes || '').substring(0, 500).trim();

    // Validate trading parameters
    if (!constants.TRADING_PAIRS.includes(symbol)) {
      return res.status(400).json({
        error: `Invalid symbol. Allowed: ${constants.TRADING_PAIRS.join(', ')}`,
        code: 'INVALID_SYMBOL',
        requestId: req.requestId
      });
    }

    if (!constants.TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({
        error: `Invalid timeframe. Allowed: ${constants.TIMEFRAMES.join(', ')}`,
        code: 'INVALID_TIMEFRAME',
        requestId: req.requestId
      });
    }

    if (!constants.TRADE_TYPES.includes(tradeType)) {
      return res.status(400).json({
        error: `Invalid trade type. Allowed: ${constants.TRADE_TYPES.join(', ')}`,
        code: 'INVALID_TRADE_TYPE',
        requestId: req.requestId
      });
    }

    console.log(`📥 [${req.requestId}] Analysis request: ${symbol} | ${timeframe} | ${tradeType} | Size: ${(req.file.size / 1024).toFixed(1)}KB`);

    // Process analysis
    const analysis = await deepseekService.analyzeTradingChart({
      imageBuffer: req.file.buffer,
      symbol: symbol,
      timeframe: timeframe,
      tradeType: tradeType,
      extraNotes: extraNotes
    });

    // Add request metadata
    const processingTime = Date.now() - startTime;
    
    analysis.metadata = {
      ...analysis.metadata,
      symbol: symbol,
      timeframe: timeframe,
      tradeType: tradeType,
      fileSize: `${(req.file.size / 1024).toFixed(1)} KB`,
      fileType: req.file.mimetype,
      processingTime: `${processingTime}ms`,
      disclaimer: constants.MESSAGES.DISCLAIMER,
      requestId: req.requestId,
      timestamp: new Date().toISOString()
    };

    // Success response
    res.json(analysis);

  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.error(`❌ [${req.requestId}] Analysis error after ${errorTime}ms:`, {
      error: error.message,
      stack: constants.NODE_ENV === 'development' ? error.stack : undefined,
      body: req.body,
      file: req.file ? {
        size: req.file.size,
        type: req.file.mimetype,
        originalname: req.file.originalname
      } : 'No file'
    });
    
    const statusCode = error.message.includes('Invalid') ? 400 : 500;
    
    res.status(statusCode).json({
      error: error.message || constants.MESSAGES.ANALYSIS_FAILED,
      code: 'ANALYSIS_ERROR',
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      processingTime: `${errorTime}ms`,
      decision: {
        action: 'HOLD',
        reason: 'Technical error during analysis. Please try again with a clearer chart image.',
        entry: 'N/A',
        sl: 'N/A',
        tp1: 'N/A',
        tp2: 'N/A'
      }
    });
  }
});

// ========== ERROR HANDLING ==========

// Multer error handling
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error(`[${req.requestId || 'NO_ID'}] Multer Error:`, err.code, err.message);
    
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: constants.MESSAGES.FILE_TOO_LARGE,
        code: 'FILE_TOO_LARGE',
        maxSize: `${constants.MAX_FILE_SIZE / 1024 / 1024}MB`,
        requestId: req.requestId,
        timestamp: new Date().toISOString()
      });
    }
    
    return res.status(400).json({
      error: 'File upload error',
      code: 'UPLOAD_ERROR',
      details: err.message,
      requestId: req.requestId
    });
  }
  
  next(err);
});

// General error handler
app.use((err, req, res, next) => {
  console.error(`🔥 [${req.requestId || 'NO_ID'}] Unhandled error:`, {
    message: err.message,
    stack: constants.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  res.status(500).json({
    error: constants.MESSAGES.SERVER_ERROR,
    code: 'INTERNAL_ERROR',
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
    ...(constants.NODE_ENV === 'development' && { debug: err.message })
  });
});

// 404 Handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'NOT_FOUND',
    path: req.originalUrl,
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
    availableEndpoints: {
      'POST /api/analyze': 'Analyze trading chart',
      'GET /api/health': 'Health check',
      'GET /api/test-keys': 'Test API connection'
    }
  });
});

// ========== START SERVER ==========
const PORT = constants.PORT;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  🚀 ===============================================
  🎯 TRADING CHART ANALYZER API v1.0.0
  📡 Server: http://0.0.0.0:${PORT}
  🌍 Environment: ${constants.NODE_ENV}
  ⏰ Started: ${new Date().toISOString()}
  🔗 Health: http://localhost:${PORT}/api/health
  📊 Rate Limit: ${constants.RATE_LIMIT_MAX_REQUESTS} req/${constants.RATE_LIMIT_WINDOW_MS/60000}min
  📁 Upload: Max ${constants.MAX_FILE_SIZE/1024/1024}MB (${constants.ALLOWED_IMAGE_TYPES.join(', ')})
  ===============================================
  
  ✅ Backend ready for production!
  ✅ Frontend can connect to: http://YOUR_SERVER_IP:${PORT}
  ⚠️  Don't forget to update frontend API URL!
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down...');
  process.exit(0);
});

module.exports = app;