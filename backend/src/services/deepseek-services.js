const axios = require('axios');
const { createWorker } = require('tesseract.js');
const sharp = require('sharp');
const constants = require('../config/constants');

class DeepSeekService {
  constructor() {
    // Validate API key
    if (!constants.DEEPSEEK_API_KEY || constants.DEEPSEEK_API_KEY === 'sk-54c73**********1a40') {
      console.error('❌ ERROR: DeepSeek API key not configured!');
      console.error('Please update the API key in src/config/constants.js');
      process.exit(1);
    }
    
    this.apiKey = constants.DEEPSEEK_API_KEY;
    this.baseURL = constants.DEEPSEEK_API_URL;
    
    // Create axios instance with production settings
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: constants.DEEPSEEK_TIMEOUT,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'TradingAnalyzer-Production/1.0.0',
        'Accept': 'application/json'
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    
    this.worker = null;
    this.requestCount = 0;
  }

  async testConnection() {
    try {
      const response = await this.client.get('/models', {
        timeout: 10000,
        validateStatus: (status) => status < 500
      });
      
      const isConnected = response.status === 200;
      const models = response.data?.data || [];
      
      return {
        ok: isConnected,
        message: isConnected ? '✅ DeepSeek API is operational' : '⚠️ API connection issue',
        modelsCount: models.length,
        timestamp: new Date().toISOString(),
        requestId: ++this.requestCount
      };
    } catch (error) {
      console.error('DeepSeek Connection Test Failed:', {
        message: error.message,
        code: error.code,
        timestamp: new Date().toISOString()
      });
      
      return {
        ok: false,
        message: `API connection failed: ${error.message}`,
        timestamp: new Date().toISOString(),
        requestId: ++this.requestCount
      };
    }
  }

  async analyzeTradingChart({ imageBuffer, symbol, timeframe, tradeType, extraNotes }) {
    const requestId = ++this.requestCount;
    const startTime = Date.now();
    
    console.log(`📊 [${requestId}] Starting analysis: ${symbol} | ${timeframe} | ${tradeType}`);
    
    try {
      // Validate inputs
      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error('Empty image buffer');
      }
      
      if (!constants.TRADING_PAIRS.includes(symbol)) {
        throw new Error(`Invalid symbol: ${symbol}`);
      }
      
      // Step 1: Preprocess image
      const processedImage = await this.preprocessImage(imageBuffer);
      
      // Step 2: Extract OCR data (with timeout)
      const ocrData = await this.extractChartDataWithOCR(processedImage);
      
      // Step 3: Analyze with AI
      const analysisResult = await this.analyzeWithAI(
        ocrData, 
        symbol, 
        timeframe, 
        tradeType, 
        extraNotes,
        requestId
      );
      
      const processingTime = Date.now() - startTime;
      
      console.log(`✅ [${requestId}] Analysis completed in ${processingTime}ms`);
      
      return {
        ...analysisResult,
        metadata: {
          requestId: requestId,
          processingTime: `${processingTime}ms`,
          apiProvider: 'DeepSeek',
          symbol: symbol,
          timeframe: timeframe,
          tradeType: tradeType,
          timestamp: new Date().toISOString(),
          version: '1.0.0'
        }
      };
      
    } catch (error) {
      const errorTime = Date.now() - startTime;
      console.error(`❌ [${requestId}] Analysis failed after ${errorTime}ms:`, error.message);
      
      return this.getFallbackAnalysis(symbol, timeframe, tradeType, error, requestId);
    }
  }

  async preprocessImage(imageBuffer) {
    try {
      // Get image info first
      const imageInfo = await sharp(imageBuffer).metadata();
      
      // Resize if too large (keep aspect ratio)
      let processed = sharp(imageBuffer);
      
      if (imageInfo.width > 2000 || imageInfo.height > 2000) {
        processed = processed.resize(2000, 2000, {
          fit: 'inside',
          withoutEnlargement: true
        });
      }
      
      // Enhance for OCR
      processed = processed
        .grayscale()
        .normalise() // British spelling for sharp
        .sharpen({ sigma: 1 })
        .median(1); // Reduce noise
      
      return await processed.toBuffer();
      
    } catch (error) {
      console.warn('Image preprocessing failed, using original:', error.message);
      return imageBuffer;
    }
  }

  async extractChartDataWithOCR(imageBuffer) {
    let worker = null;
    
    try {
      worker = await createWorker(constants.OCR_LANGUAGE);
      
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789.$%:,-+ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz /()[]',
        preserve_interword_spaces: '1',
        tessedit_pageseg_mode: '6', // Assume uniform block of text
      });
      
      const { data: { text } } = await worker.recognize(
        imageBuffer,
        { 
          rectangle: { top: 0, left: 0, width: 1000, height: 1000 },
          rotateAuto: true 
        }
      );
      
      await worker.terminate();
      worker = null;
      
      return this.parseOCRText(text);
      
    } catch (error) {
      if (worker) {
        try { await worker.terminate(); } catch {}
      }
      
      console.warn('OCR extraction failed:', error.message);
      return { 
        rawText: '', 
        extractedData: {
          priceLevels: [],
          indicators: {},
          labels: [],
          hasData: false
        }
      };
    }
  }

  parseOCRText(text) {
    const data = {
      rawText: text.substring(0, 1500), // Limit stored text
      extractedData: {
        priceLevels: [],
        indicators: {},
        labels: [],
        hasData: false
      }
    };
    
    try {
      // Extract prices with various formats
      const pricePatterns = [
        /(\d{1,6}[.,]\d{2,5})/g,                    // 12345.67, 1.23456
        /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/g,       // 1,234.56, 1.234,56
        /([$€£¥]\s*(\d+[.,]\d+))/gi                 // $1.234,56
      ];
      
      let allPrices = [];
      
      pricePatterns.forEach(pattern => {
        const matches = text.match(pattern) || [];
        matches.forEach(match => {
          // Clean and convert to number
          const clean = match.replace(/[$,€£¥\s]/g, '');
          const normalized = clean.replace(',', '.');
          const num = parseFloat(normalized);
          
          if (!isNaN(num) && num > 0) {
            // Round to reasonable precision
            const precision = num < 10 ? 5 : num < 1000 ? 4 : 2;
            const rounded = parseFloat(num.toFixed(precision));
            allPrices.push(rounded);
          }
        });
      });
      
      // Remove duplicates and sort
      data.extractedData.priceLevels = [...new Set(allPrices)]
        .sort((a, b) => a - b)
        .slice(0, 15); // Limit to 15 prices
      
      // Extract RSI
      const rsiPatterns = [
        /RSI[\s:=]*(\d{1,3}(?:[.,]\d{1,2})?)/i,
        /Relative Strength Index[\s:=]*(\d{1,3}(?:[.,]\d{1,2})?)/i
      ];
      
      for (const pattern of rsiPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          const value = parseFloat(match[1].replace(',', '.'));
          if (!isNaN(value) && value >= 0 && value <= 100) {
            data.extractedData.indicators.RSI = value;
            break;
          }
        }
      }
      
      // Extract MACD
      const macdPattern = /MACD[\s:=]*([-]?\d{1,6}(?:[.,]\d{1,5})?)/i;
      const macdMatch = text.match(macdPattern);
      if (macdMatch && macdMatch[1]) {
        const value = parseFloat(macdMatch[1].replace(',', '.'));
        if (!isNaN(value)) {
          data.extractedData.indicators.MACD = value;
        }
      }
      
      // Extract Moving Averages
      const maPattern = /(MA|SMA|EMA)[\s:=]*(\d{1,6}(?:[.,]\d{1,5})?)/gi;
      let maMatch;
      while ((maMatch = maPattern.exec(text)) !== null) {
        const type = maMatch[1].toUpperCase();
        const value = parseFloat(maMatch[2].replace(',', '.'));
        if (!isNaN(value)) {
          data.extractedData.indicators[type] = value;
        }
      }
      
      // Check if we have any data
      data.extractedData.hasData = 
        data.extractedData.priceLevels.length > 0 ||
        Object.keys(data.extractedData.indicators).length > 0;
      
    } catch (error) {
      console.warn('OCR parsing error:', error.message);
    }
    
    return data;
  }

  async analyzeWithAI(ocrData, symbol, timeframe, tradeType, extraNotes, requestId) {
    const prompt = this.generateTradingPrompt(ocrData, symbol, timeframe, tradeType, extraNotes);
    
    try {
      console.log(`🤖 [${requestId}] Sending request to DeepSeek API...`);
      
      const response = await this.client.post('/chat/completions', {
        model: constants.DEEPSEEK_MODEL,
        messages: [
          { 
            role: 'system',
            content: 'You are a professional trading analyst with 15+ years experience in technical analysis.'
          },
          { 
            role: 'user', 
            content: prompt 
          }
        ],
        max_tokens: 2500,
        temperature: 0.1,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: 0.1,
        response_format: { type: 'json_object' }
      });
      
      console.log(`✅ [${requestId}] Received response from DeepSeek API`);
      
      return this.parseAIResponse(response.data, requestId);
      
    } catch (error) {
      console.error(`❌ [${requestId}] DeepSeek API Error:`, {
        message: error.message,
        status: error.response?.status,
        code: error.code
      });
      
      throw new Error(`AI service error: ${error.message}`);
    }
  }

  generateTradingPrompt(ocrData, symbol, timeframe, tradeType, extraNotes) {
    const { priceLevels, indicators, hasData } = ocrData.extractedData;
    
    const currentTime = new Date().toISOString();
    const dataQuality = hasData ? 'GOOD' : 'POOR';
    
    return `🔍 **TRADING CHART ANALYSIS REQUEST**

📊 **MARKET DATA:**
- Symbol: ${symbol}
- Timeframe: ${timeframe}
- Strategy: ${tradeType.toUpperCase()}
- Analysis Time: ${currentTime}
- Data Quality: ${dataQuality}

📈 **EXTRACTED CHART DATA:**
${hasData ? `
PRICE LEVELS (sorted):
${priceLevels.map((p, i) => `${i+1}. ${p}`).join('\n')}

TECHNICAL INDICATORS:
${Object.entries(indicators).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

USER NOTES:
${extraNotes || 'None provided'}
` : '⚠️ NO DATA EXTRACTED - Chart may be unclear or contain no readable text'}

🎯 **ANALYSIS REQUIREMENTS:**

1. **TREND ANALYSIS:**
   - Primary trend direction
   - Trend strength and structure
   - Momentum assessment

2. **KEY LEVELS:**
   - Support levels (use available price data)
   - Resistance levels (use available price data)
   - Pivot points if identifiable

3. **PATTERN RECOGNITION:**
   - Chart patterns (triangles, flags, H&S, etc.)
   - Candlestick patterns
   - Breakout/breakdown signals

4. **RISK ASSESSMENT:**
   - Market volatility
   - Signal reliability
   - Risk/Reward potential

📉 **TRADING DECISION CRITERIA:**

✅ **BUY SIGNAL (LONG):**
   - Bullish pattern confirmation
   - Support bounce with volume
   - Positive momentum alignment
   - Risk/Reward ≥ 1:1.5
   - Clear entry/exit levels

✅ **SELL SIGNAL (SHORT):**
   - Bearish pattern confirmation
   - Resistance rejection
   - Negative momentum alignment
   - Risk/Reward ≥ 1:1.5
   - Clear entry/exit levels

🔄 **HOLD SIGNAL:**
   - Sideways/consolidation
   - No clear pattern
   - Low confidence signal
   - High uncertainty
   - Waiting for confirmation

⚠️ **CONSERVATIVE APPROACH REQUIRED:**
   - Better to miss a trade than take a bad one
   - If data is insufficient → HOLD
   - If confidence < 70% → HOLD
   - Always prioritize capital preservation

💰 **RISK MANAGEMENT:**
   - Calculate precise price levels
   - Suggest realistic stop loss
   - Provide 2 take profit targets
   - Assess position size suitability
   - Define invalidation conditions

📋 **OUTPUT FORMAT - STRICT JSON ONLY:**

{
  "vision_summary": {
    "trend_structure": "bullish/bearish/sideways/uncertain",
    "trend_confidence": "high/medium/low",
    "support_zone": {
      "level": "specific_price_or_N/A",
      "description": "brief_description",
      "confidence": "high/medium/low"
    },
    "resistance_zone": {
      "level": "specific_price_or_N/A",
      "description": "brief_description",
      "confidence": "high/medium/low"
    },
    "rsi": {
      "approx_value": "number_or_estimated_range_or_N/A",
      "status": "overbought/oversold/neutral/unknown",
      "divergence": true/false
    },
    "macd": {
      "cross": "bullish/bearish/neutral/unknown",
      "histogram": "rising/falling/neutral/unknown",
      "momentum": "strong/moderate/weak/unknown"
    },
    "key_notes": "concise_market_observations_max_3_points"
  },
  "decision": {
    "action": "BUY/SELL/HOLD",
    "entry": "exact_price_or_N/A",
    "sl": "exact_stop_loss_or_N/A",
    "tp1": "first_take_profit_or_N/A",
    "tp2": "second_take_profit_or_N/A",
    "probability": "0-100%",
    "risk_reward": "ratio_e.g._1:1.5_or_N/A",
    "reason": "detailed_technical_explanation_min_3_points",
    "invalid_if": "clear_invalidation_conditions"
  },
  "risk_assessment": {
    "level": "low/medium/high",
    "recommended_position": "small/medium/full",
    "timeframe_suitability": "excellent/good/fair/poor"
  }
}

🎯 **FINAL INSTRUCTIONS:**
1. ${hasData ? 'Use available price data for calculations' : 'Acknowledge data limitations'}
2. Be conservative - err on side of caution
3. Provide realistic price levels
4. Include clear risk warnings
5. Return ONLY valid JSON, no additional text
6. Add "${constants.MESSAGES.DISCLAIMER}" to reasoning`;
  }

  parseAIResponse(apiResponse, requestId) {
    try {
      const content = apiResponse.choices[0].message.content;
      const usage = apiResponse.usage || {};
      
      // Clean response
      const cleanedContent = content
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/gi, '')
        .replace(/^json\s*/i, '')
        .trim();
      
      // Parse JSON
      const parsedData = JSON.parse(cleanedContent);
      
      // Validate structure
      if (!parsedData.decision || !parsedData.vision_summary) {
        throw new Error('Invalid response structure from AI');
      }
      
      // Add disclaimer and metadata
      parsedData.disclaimer = constants.MESSAGES.DISCLAIMER;
      parsedData.api_usage = {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      };
      
      return parsedData;
      
    } catch (error) {
      console.error(`[${requestId}] Failed to parse AI response:`, error.message);
      return this.getFallbackAnalysis('Unknown', 'Unknown', 'Unknown', error, requestId);
    }
  }

  getFallbackAnalysis(symbol, timeframe, tradeType, error, requestId) {
    return {
      vision_summary: {
        trend_structure: "Analysis failed",
        trend_confidence: "low",
        support_zone: {
          level: "N/A",
          description: "Technical analysis incomplete",
          confidence: "low"
        },
        resistance_zone: {
          level: "N/A",
          description: "Technical analysis incomplete",
          confidence: "low"
        },
        rsi: {
          approx_value: "N/A",
          status: "unknown",
          divergence: false
        },
        macd: {
          cross: "unknown",
          histogram: "unknown",
          momentum: "unknown"
        },
        key_notes: "Unable to complete technical analysis. Please ensure chart image is clear, well-lit, and contains visible price/indicator data."
      },
      decision: {
        action: "HOLD",
        entry: "N/A",
        sl: "N/A",
        tp1: "N/A",
        tp2: "N/A",
        probability: "0%",
        risk_reward: "N/A",
        reason: `Technical analysis failed: ${error?.message || 'Insufficient or unclear chart data'}. Please upload a clearer screenshot with visible price levels.`,
        invalid_if: "N/A"
      },
      risk_assessment: {
        level: "high",
        recommended_position: "none",
        timeframe_suitability: "poor"
      },
      error: {
        message: error?.message || 'Analysis failed',
        requestId: requestId,
        timestamp: new Date().toISOString()
      }
    };
  }
}

module.exports = DeepSeekService;