require("dotenv").config();
const axios = require("axios");
const QRCode = require('qrcode');
const fs = require('fs');

// Environment variables with fallbacks
const config = {
  QPAY_MODE: process.env.QPAY_MODE || "production",
  QPAY_PRODUCTION_URL: process.env.QPAY_URL || "https://merchant.qpay.mn/v2",
  QPAY_SANDBOX_URL: process.env.QPAY_TEST_URL || "https://merchant-sandbox.qpay.mn/v2",
  QPAY_USERNAME: process.env.QPAY_USERNAME || "GRAND_IT",
  QPAY_PASSWORD: process.env.QPAY_PASSWORD || "gY8ljnov",
  QPAY_TEMPLATE: process.env.QPAY_TEMPLATE || "GRAND_IT_INVOICE",
  QPAY_CALLBACK_URL: process.env.QPAY_CALLBACK_URL || "http://localhost:3000/qpay/callback",
  API_KEY: process.env.API_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbGllbnRfaWQiOiJmZDNiYzQ3ZC0xNjAwLTQwYzUtYWFhOC0zNTZmNDMzNmEyODQiLCJzZXNzaW9uX2lkIjoiUWhfWW8wRTdxUUl3R21yM3dwaGlMZ3pRMnNuRjNtNDAiLCJpYXQiOjE3NTMzNDY0NDUsImV4cCI6MzUwNjc3OTI5MH0.J-e6O6B6XxqV9p6LRrQ53SlWpjllJWSRryKVxVxgIzE"
};

const BASE_URL = config.QPAY_MODE === "production" ? config.QPAY_PRODUCTION_URL : config.QPAY_SANDBOX_URL;

/**
 * 🔐 Access Token авах
 */
async function getAccessToken() {
  try {
    const resp = await axios.post(`${BASE_URL}/auth/token`, null, {
      auth: {
        username: config.QPAY_USERNAME,
        password: config.QPAY_PASSWORD
      }
    });
    return { success: true, ...resp.data };
  } catch (error) {
    return handleError("getAccessToken", error);
  }
}

/**
 * 🔄 Token refresh хийх
 */
async function refreshToken(refresh_token) {
  try {
    const resp = await axios.post(`${BASE_URL}/auth/refresh`, { refresh_token });
    return { success: true, ...resp.data };
  } catch (error) {
    return handleError("refreshToken", error);
  }
}

/**
 * 🧾 Нэхэмжлэл үүсгэх (энгийн хувилбар)
 * @param {string} token
 * @param {number} amount
 * @param {string} orderId
 * @param {string} userId
 * @param {string} invoiceDescription
 */
async function createInvoice(token, amount, orderId, userId, invoiceDescription) {
  const payload = {
    invoice_code: config.QPAY_TEMPLATE,
    sender_invoice_no: `INV_${orderId}`,
    invoice_receiver_code: userId || 'terminal',
    invoice_description: invoiceDescription,
    amount: amount,
    callback_url: config.QPAY_CALLBACK_URL
  };

  try {
    const resp = await axios.post(`${BASE_URL}/invoice`, payload, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return { success: true, ...resp.data };
  } catch (error) {
    return handleError("createInvoice", error);
  }
}

/**
 * 📄 Нэхэмжлэлийн мэдээлэл авах
 */
async function getInvoice(token, invoiceId) {
  try {
    const resp = await axios.get(`${BASE_URL}/invoice/${invoiceId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return { success: true, ...resp.data };
  } catch (error) {
    return handleError("getInvoice", error);
  }
}

/**
 * 🚫 Нэхэмжлэл цуцлах
 */
async function cancelInvoice(token, invoiceId) {
  try {
    const resp = await axios.delete(`${BASE_URL}/invoice/${invoiceId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return { success: true, ...resp.data };
  } catch (error) {
    return handleError("cancelInvoice", error);
  }
}

/**
 * ✅ Төлбөр шалгах
 */
async function checkPayment(token, invoiceId) {
  try {
    // Load mock data for testing
    let mockData = {};
    try {
      mockData = JSON.parse(fs.readFileSync('./mock.json', 'utf8'));
    } catch (error) {
      console.warn('⚠️ Warning: Could not load mock.json file, falling back to real API');
    }

    // Check dynamic_payments first (from webhook simulation)
    const dynamicPayments = mockData.dynamic_payments || {};
    if (dynamicPayments[invoiceId]) {
      console.log(`🧪 Using dynamic mock data for payment check: ${invoiceId}`);
      const payment = dynamicPayments[invoiceId];
      return {
        success: true,
        count: 1,
        paid_amount: payment.payment_amount,
        rows: [{
          ...payment,
          payment_id: `mock_payment_${Date.now()}`,
          created_at: payment.payment_date || new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]
      };
    }

    // Check static webhooks as fallback
    const mockWebhooks = mockData.webhooks || {};
    const mockPayment = Object.values(mockWebhooks).find(webhook => 
      webhook.object_id === invoiceId
    );

    if (mockPayment) {
      console.log(`🧪 Using static mock data for payment check: ${invoiceId}`);
      return {
        success: true,
        count: 1,
        paid_amount: mockPayment.payment_amount,
        rows: [{
          ...mockPayment,
          payment_id: `mock_payment_${Date.now()}`,
          created_at: mockPayment.payment_date || new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]
      };
    }

    // Fall back to real API call if no mock data found
    console.log(`🌐 Making real API call for payment check: ${invoiceId}`);
    const resp = await axios.post(`${BASE_URL}/payment/check`, {
      object_type: "INVOICE",
      object_id: invoiceId,
      offset: {
        "page_number": 1,
        "page_limit": 100
      }
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return { success: true, ...resp.data };
  } catch (error) {
    return handleError("checkPayment", error);
  }
}

/**
 * 📋 Төлбөрийн жагсаалт
 */
async function listPayments(token, query = {}) {
  try {
    const resp = await axios.post(`${BASE_URL}/payment/list`, query, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return { success: true, ...resp.data };
  } catch (error) {
    return handleError("listPayments", error);
  }
}

/**
 * 📱 QR код зураг файл үүсгэх
 * @param {string} qrText - QR кодын текст
 * @param {string} invoiceId - Нэхэмжлэлийн ID
 * @param {object} options - QR кодын тохиргоо
 */
async function generateQRImage(qrText, invoiceId, options = {}) {
  const defaultOptions = {
    width: 300,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  };

  const qrOptions = { ...defaultOptions, ...options };
  
  try {
    // Create qr-images directory if it doesn't exist
    const dir = './qr-images';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }

    // Generate filename
    const filename = `qr-${invoiceId}.png`;
    const filepath = `${dir}/${filename}`;

    // Generate QR code image
    await QRCode.toFile(filepath, qrText, qrOptions);
    
    console.log(`✅ QR код зураг хадгалагдлаа: ${filepath}`);
    return {
      success: true,
      filename,
      filepath,
      url: `/qr-images/${filename}`
    };
  } catch (error) {
    return handleError("generateQRImage", error);
  }
}

/**
 * 📱 QR код data URL үүсгэх (веб дэлгэцэнд харуулахад)
 * @param {string} qrText - QR кодын текст
 * @param {object} options - QR кодын тохиргоо
 */
async function generateQRDataURL(qrText, options = {}) {
  const defaultOptions = {
    width: 300,
    margin: 2,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  };

  const qrOptions = { ...defaultOptions, ...options };
  
  try {
    const dataURL = await QRCode.toDataURL(qrText, qrOptions);
    return { success: true, dataURL };
  } catch (error) {
    return handleError("generateQRDataURL", error);
  }
}

/**
 * 🚀 Нэхэмжлэл үүсгээд QR код зураг авах (бүрэн функц)
 * @param {number} amount - Мөнгөн дүн
 * @param {string} orderId - Захиалгын дугаар
 * @param {string} userId - Хэрэглэгчийн ID
 * @param {string} invoiceDescription - Нэхэмжлэлийн тайлбар
 */
async function createInvoiceWithQR(amount, orderId, userId, invoiceDescription) {
  try {
    // 1. Access token авах
    console.log('🔐 QPay-тай холбогдож байна...');
    const authResult = await getAccessToken();
    if (!authResult.success) {
      throw new Error('Authentication failed: ' + authResult.error);
    }

    // 2. Нэхэмжлэл үүсгэх
    console.log('📄 Нэхэмжлэл үүсгэж байна...');
    const invoiceResult = await createInvoice(
      authResult.access_token,
      amount,
      orderId,
      userId,
      invoiceDescription
    );
    
    if (!invoiceResult.success) {
      throw new Error('Invoice creation failed: ' + invoiceResult.error);
    }

    // 3. QR код зураг үүсгэх
    console.log('📱 QR код зураг үүсгэж байна...');
    const qrImageResult = await generateQRImage(invoiceResult.qr_text, invoiceResult.invoice_id);
    const qrDataResult = await generateQRDataURL(invoiceResult.qr_text);

    // 4. Үр дүнг буцаах
    return {
      success: true,
      invoice: invoiceResult,
      qr_image: qrImageResult,
      qr_data_url: qrDataResult.success ? qrDataResult.dataURL : null,
      access_token: authResult.access_token
    };

  } catch (error) {
    return handleError("createInvoiceWithQR", error);
  }
}

/**
 * 🛑 Алдааг барьж авах
 */
function handleError(fnName, error) {
  console.error(`❌ Error in ${fnName}:`, error?.response?.data || error.message);
  return {
    success: false,
    error: error?.response?.data || error.message || "Unknown error",
    source: fnName
  };
}

module.exports = {
  getAccessToken,
  refreshToken,
  createInvoice,
  getInvoice,
  cancelInvoice,
  checkPayment,
  listPayments,
  generateQRImage,
  generateQRDataURL,
  createInvoiceWithQR,
  config,
  BASE_URL
}; 