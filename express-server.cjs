const express = require('express');
const crypto = require('crypto');
const qpay = require('./qpay-helper.cjs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/qr-images', express.static('qr-images'));

// Store for invoice tracking (in production, use a database)
const invoices = new Map();

// Store for processed webhook IDs to prevent duplicates
const processedWebhooks = new Set();

// Store for active payment monitoring intervals
const paymentMonitors = new Map();

// Store access token
let accessToken = null;
let tokenExpiry = null;

async function ensureAuthenticated() {
  // Check if token exists and is not expired
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }

  try {
    console.log('🔐 QPay-тай холбогдож байна...');
    const authResult = await qpay.getAccessToken();
    
    if (authResult.success) {
      accessToken = authResult.access_token;
      // Set token expiry (subtract 5 minutes for safety)
      tokenExpiry = Date.now() + (authResult.expires_in - 300) * 1000;
      console.log('✅ QPay амжилттай холбогдлоо');
      return accessToken;
    } else {
      throw new Error(authResult.error);
    }
  } catch (error) {
    console.error('❌ QPay холбогдох алдаа:', error.message);
    throw error;
  }
}

// Payment monitoring function
async function startPaymentMonitoring(invoiceId) {
  const TIMEOUT_MS = 60000; // 1 minute
  const CHECK_INTERVAL_MS = 3000; // Check every 3 seconds
  const startTime = Date.now();
  
  console.log(`🔍 Started payment monitoring for invoice: ${invoiceId}`);
  
  // Set up timeout to cancel after 1 minute
  const timeoutMonitor = setTimeout(async () => {
    console.log(`⏰ Payment timeout reached for invoice: ${invoiceId}`);
    await cancelExpiredInvoice(invoiceId);
  }, TIMEOUT_MS);
  
  // Set up interval to check payment status
  const intervalMonitor = setInterval(async () => {
    try {
      const elapsed = Date.now() - startTime;
      
      // Double-check if we've exceeded timeout
      if (elapsed >= TIMEOUT_MS) {
        console.log(`⏰ Payment timeout reached for invoice: ${invoiceId} (interval check)`);
        clearInterval(intervalMonitor);
        clearTimeout(timeoutMonitor);
        await cancelExpiredInvoice(invoiceId);
        return;
      }
      
      // Check payment status
      const token = await ensureAuthenticated();
      const paymentResult = await qpay.checkPayment(token, invoiceId);
      
      if (paymentResult.success && paymentResult.count > 0) {
        const payment = paymentResult.rows[0];
        if (payment.payment_status === 'PAID') {
          console.log(`✅ Payment confirmed for invoice: ${invoiceId}`);
          updateInvoiceStatus(invoiceId, 'paid', payment);
          clearInterval(intervalMonitor);
          clearTimeout(timeoutMonitor);
          stopPaymentMonitoring(invoiceId);
          return;
        }
      }
      
    } catch (error) {
      console.error(`❌ Error monitoring payment for ${invoiceId}:`, error.message);
    }
  }, CHECK_INTERVAL_MS);
  
  // Store both monitors
  paymentMonitors.set(invoiceId, { interval: intervalMonitor, timeout: timeoutMonitor });
}

function stopPaymentMonitoring(invoiceId) {
  const monitors = paymentMonitors.get(invoiceId);
  if (monitors) {
    if (monitors.interval) clearInterval(monitors.interval);
    if (monitors.timeout) clearTimeout(monitors.timeout);
    paymentMonitors.delete(invoiceId);
    console.log(`⏹️ Stopped payment monitoring for invoice: ${invoiceId}`);
  }
}

async function cancelExpiredInvoice(invoiceId) {
  try {
    if (invoices.has(invoiceId)) {
      const invoice = invoices.get(invoiceId);
      if (invoice.status === 'pending') {
        // Update local status
        invoice.status = 'cancelled';
        invoice.cancelled_reason = 'Payment timeout (1 minute)';
        invoice.cancelled_at = new Date();
        invoices.set(invoiceId, invoice);
        
        // Try to cancel on QPay side
        try {
          const token = await ensureAuthenticated();
          await qpay.cancelInvoice(token, invoiceId);
          console.log(`🚫 Invoice cancelled on QPay: ${invoiceId}`);
        } catch (cancelError) {
          console.warn(`⚠️ Could not cancel invoice on QPay side: ${cancelError.message}`);
        }
        
        console.log(`⏰ Invoice expired and cancelled: ${invoiceId}`);
      }
    }
    
    stopPaymentMonitoring(invoiceId);
  } catch (error) {
    console.error(`❌ Error cancelling expired invoice ${invoiceId}:`, error.message);
  }
}

function updateInvoiceStatus(invoiceId, status, paymentData = null) {
  if (invoices.has(invoiceId)) {
    const invoice = invoices.get(invoiceId);
    invoice.status = status;
    invoice.updated_at = new Date();
    
    if (paymentData) {
      invoice.payment_amount = paymentData.payment_amount;
      invoice.payment_date = paymentData.payment_date;
      invoice.transaction_id = paymentData.transaction_id;
    }
    
    invoices.set(invoiceId, invoice);
  }
}

// Routes

// Home page
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>QPay Integration Demo</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .container { max-width: 600px; }
          .form-group { margin: 15px 0; }
          label { display: block; margin-bottom: 5px; }
          input, textarea { width: 100%; padding: 8px; margin-bottom: 10px; }
          button { background: #007bff; color: white; padding: 10px 20px; border: none; cursor: pointer; }
          .result { margin-top: 20px; padding: 15px; background: #f8f9fa; border: 1px solid #dee2e6; }
          .qr-code { margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>QPay Invoice Demo</h1>
          
          <form id="invoiceForm">
            <div class="form-group">
              <label>Invoice Description:</label>
              <input type="text" id="description" value="Test Payment" required>
            </div>
            
            <div class="form-group">
              <label>Amount (MNT):</label>
              <input type="number" id="amount" value="1000" required min="1">
            </div>
            
            <div class="form-group">
              <label>Customer Code:</label>
              <input type="text" id="customerCode" value="terminal" required>
            </div>
            
            <button type="submit">Create Invoice</button>
          </form>
          
          <div id="result" class="result" style="display: none;"></div>
        </div>

        <script>
          document.getElementById('invoiceForm').onsubmit = async function(e) {
            e.preventDefault();
            
            const data = {
              description: document.getElementById('description').value,
              amount: parseInt(document.getElementById('amount').value),
              customerCode: document.getElementById('customerCode').value
            };
            
            try {
              const response = await fetch('/api/create-invoice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
              
              const result = await response.json();
              
              if (result.success) {
                document.getElementById('result').innerHTML = \`
                  <h3>✅ Invoice Created Successfully!</h3>
                  <p><strong>Invoice ID:</strong> \${result.invoice_id}</p>
                  <p><strong>Amount:</strong> \${result.amount} MNT</p>
                  <div class="qr-code">
                    <p><strong>📱 QR Code (Scan with your phone):</strong></p>
                    <img src="\${result.qr_data_url}" alt="QR Code" style="max-width: 250px; border: 2px solid #ddd; padding: 10px;">
                    <br>
                    <a href="\${result.qr_image_url}" download="qr-code.png" style="display: inline-block; margin: 10px 0; padding: 8px 16px; background: #28a745; color: white; text-decoration: none; border-radius: 4px;">📥 Download QR Image</a>
                    <a href="\${result.qr_image_url}" target="_blank" style="display: inline-block; margin: 10px 0; padding: 8px 16px; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">🖼️ View Full Size</a>
                  </div>
                  <p><strong>QR Text:</strong> <small>\${result.qr_text}</small></p>
                  <div>
                    <h4>📱 Bank Mobile Apps:</h4>
                    \${result.bank_urls.map(bank => \`
                      <p><a href="\${bank.link}" target="_blank" style="color: #007bff;">\${bank.description}</a></p>
                    \`).join('')}
                  </div>
                  <div id="paymentStatus_\${result.invoice_id}" style="margin-top: 15px; padding: 10px; border: 2px solid #ffc107; background: #fff3cd; border-radius: 5px;">
                    <p style="margin: 0; font-weight: bold;">⏳ Waiting for payment...</p>
                    <p style="margin: 5px 0 0 0;">Time remaining: <span id="countdown_\${result.invoice_id}" style="font-weight: bold; color: #d73527;">01:00</span></p>
                  </div>
                  <button onclick="checkPayment('\${result.invoice_id}')" style="margin-top: 10px; padding: 8px 16px; background: #17a2b8; color: white; border: none; border-radius: 4px; cursor: pointer;">🔍 Check Payment Status</button>
                \`;
                document.getElementById('result').style.display = 'block';
                
                // Start countdown timer and payment monitoring
                startPaymentMonitoring(result.invoice_id);
              } else {
                throw new Error(result.error);
              }
            } catch (error) {
              document.getElementById('result').innerHTML = \`
                <h3>❌ Error</h3>
                <p>\${error.message}</p>
              \`;
              document.getElementById('result').style.display = 'block';
            }
          };
          
          let paymentMonitors = {};
          
          async function checkPayment(invoiceId) {
            try {
              const response = await fetch(\`/api/payment-status/\${invoiceId}\`);
              const result = await response.json();
              
              if (result.count > 0) {
                const payment = result.rows[0];
                updatePaymentStatus(invoiceId, payment.payment_status, payment);
              } else {
                alert('No payment found for this invoice');
              }
            } catch (error) {
              alert('Error checking payment: ' + error.message);
            }
          }
          
          function startPaymentMonitoring(invoiceId) {
            // Start countdown timer
            startCountdown(invoiceId);
            
            // Check payment status every 3 seconds
            const monitor = setInterval(async () => {
              try {
                const response = await fetch(\`/api/invoice/\${invoiceId}\`);
                const result = await response.json();
                
                if (result.success) {
                  const invoice = result.invoice;
                  
                  // Update countdown
                  updateCountdown(invoiceId, invoice.time_remaining_ms);
                  
                  // Check if payment is complete
                  if (invoice.status === 'paid') {
                    updatePaymentStatus(invoiceId, 'PAID', invoice);
                    stopPaymentMonitoring(invoiceId);
                  } else if (invoice.status === 'cancelled' || invoice.is_expired) {
                    updatePaymentStatus(invoiceId, 'CANCELLED');
                    stopPaymentMonitoring(invoiceId);
                  }
                }
              } catch (error) {
                console.error('Error monitoring payment:', error);
              }
            }, 3000);
            
            paymentMonitors[invoiceId] = monitor;
            
            // Auto-stop after 70 seconds (buffer time)
            setTimeout(() => {
              stopPaymentMonitoring(invoiceId);
            }, 70000);
          }
          
          function stopPaymentMonitoring(invoiceId) {
            if (paymentMonitors[invoiceId]) {
              clearInterval(paymentMonitors[invoiceId]);
              delete paymentMonitors[invoiceId];
            }
          }
          
          function startCountdown(invoiceId) {
            const startTime = Date.now();
            const TIMEOUT_MS = 60000; // 60 seconds
            
            const countdown = setInterval(() => {
              const elapsed = Date.now() - startTime;
              const timeLeft = Math.max(0, Math.ceil((TIMEOUT_MS - elapsed) / 1000));
              updateCountdownDisplay(invoiceId, timeLeft);
              
              if (timeLeft <= 0) {
                clearInterval(countdown);
                updatePaymentStatus(invoiceId, 'CANCELLED');
              }
            }, 1000);
          }
          
          function updateCountdown(invoiceId, timeRemainingMs) {
            const seconds = Math.ceil(timeRemainingMs / 1000);
            updateCountdownDisplay(invoiceId, seconds);
          }
          
          function updateCountdownDisplay(invoiceId, seconds) {
            const countdownEl = document.getElementById(\`countdown_\${invoiceId}\`);
            if (countdownEl) {
              const minutes = Math.floor(seconds / 60);
              const secs = seconds % 60;
              const timeStr = \`\${minutes.toString().padStart(2, '0')}:\${secs.toString().padStart(2, '0')}\`;
              countdownEl.textContent = timeStr;
              
              // Change color based on time remaining
              if (seconds <= 10) {
                countdownEl.style.color = '#dc3545'; // Red
              } else if (seconds <= 30) {
                countdownEl.style.color = '#fd7e14'; // Orange
              } else {
                countdownEl.style.color = '#d73527'; // Default red
              }
            }
          }
          
          function updatePaymentStatus(invoiceId, status, paymentData = null) {
            const statusEl = document.getElementById(\`paymentStatus_\${invoiceId}\`);
            if (!statusEl) return;
            
            if (status === 'PAID') {
              statusEl.innerHTML = \`
                <p style="margin: 0; font-weight: bold; color: #28a745;">✅ Payment Successful!</p>
                <p style="margin: 5px 0 0 0; color: #28a745;">Amount: \${paymentData?.payment_amount || 'N/A'} MNT</p>
                <p style="margin: 5px 0 0 0; color: #28a745;">Transaction: \${paymentData?.transaction_id || 'N/A'}</p>
              \`;
              statusEl.style.borderColor = '#28a745';
              statusEl.style.backgroundColor = '#d4edda';
            } else if (status === 'CANCELLED') {
              statusEl.innerHTML = \`
                <p style="margin: 0; font-weight: bold; color: #dc3545;">❌ Payment Cancelled/Expired</p>
                <p style="margin: 5px 0 0 0; color: #dc3545;">Invoice expired after 1 minute</p>
              \`;
              statusEl.style.borderColor = '#dc3545';
              statusEl.style.backgroundColor = '#f8d7da';
            }
          }
        </script>
      </body>
    </html>
  `);
});

// API endpoint to create invoice
app.post('/api/create-invoice', async (req, res) => {
  try {
    const { description, amount, customerCode } = req.body;

    if (!description || !amount || !customerCode) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: description, amount, customerCode'
      });
    }

    // Ensure we have a valid token
    const token = await ensureAuthenticated();

    // Create unique order ID
    const orderId = Date.now().toString();
    
    // Create invoice using new helper function
    const invoiceResult = await qpay.createInvoice(
      token,
      amount,
      orderId,
      customerCode,
      description
    );

    if (!invoiceResult.success) {
      throw new Error(invoiceResult.error);
    }
    
    // Generate QR code image file
    const qrImageResult = await qpay.generateQRImage(invoiceResult.qr_text, invoiceResult.invoice_id);
    
    // Generate QR code data URL for web display
    const qrDataResult = await qpay.generateQRDataURL(invoiceResult.qr_text);
    
    // Store invoice for tracking
    invoices.set(invoiceResult.invoice_id, {
      order_id: orderId,
      customer_code: customerCode,
      description: description,
      amount: amount,
      invoice_id: invoiceResult.invoice_id,
      created_at: new Date(),
      status: 'pending',
      qr_image_path: qrImageResult.success ? qrImageResult.filepath : null
    });

    // Start payment monitoring
    startPaymentMonitoring(invoiceResult.invoice_id);

    res.json({
      success: true,
      invoice_id: invoiceResult.invoice_id,
      amount: amount,
      qr_text: invoiceResult.qr_text,
      qr_image: invoiceResult.qr_image,
      qr_image_url: qrImageResult.success ? qrImageResult.url : null,
      qr_data_url: qrDataResult.success ? qrDataResult.dataURL : null,
      bank_urls: invoiceResult.urls
    });

  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to check payment status
app.get('/api/payment-status/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    
    // Ensure we have a valid token
    const token = await ensureAuthenticated();
    
    const paymentResult = await qpay.checkPayment(token, invoiceId);
    
    if (!paymentResult.success) {
      throw new Error(paymentResult.error);
    }
    
    // Update local invoice status if payment found
    if (paymentResult.count > 0 && invoices.has(invoiceId)) {
      const invoice = invoices.get(invoiceId);
      invoice.status = paymentResult.rows[0].payment_status;
      invoice.payment_date = paymentResult.rows[0].payment_date;
      invoices.set(invoiceId, invoice);
    }
    
    res.json({
      success: true,
      count: paymentResult.count,
      paid_amount: paymentResult.paid_amount,
      rows: paymentResult.rows
    });
    
  } catch (error) {
    console.error('Error checking payment:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// QPay payment check endpoint (matching QPay API format)
app.post('/qpay/check', async (req, res) => {
  try {
    const { object_id } = req.body;
    
    if (!object_id) {
      return res.status(400).json({
        error: 'Missing required field: object_id'
      });
    }
    
    // Ensure we have a valid token
    const token = await ensureAuthenticated();
    
    const paymentResult = await qpay.checkPayment(token, object_id);
    
    if (!paymentResult.success) {
      throw new Error(paymentResult.error);
    }
    
    res.json({
      count: paymentResult.count,
      paid_amount: paymentResult.paid_amount || 0,
      rows: paymentResult.rows || []
    });
    
  } catch (error) {
    console.error('Error checking payment:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Webhook signature verification (if QPay provides webhook secret)
function verifyWebhookSignature(payload, signature, secret) {
  if (!secret || !signature) return true; // Skip verification if no secret configured
  
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
    
  return crypto.timingSafeEqual(
    Buffer.from(`sha256=${expectedSignature}`),
    Buffer.from(signature)
  );
}

// Validate webhook payload
function validateWebhookPayload(payload) {
  const required = ['object_id'];
  const missing = required.filter(field => !payload[field]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
  
  // Validate object_id format (UUID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(payload.object_id)) {
    throw new Error('Invalid object_id format');
  }
  
  // Validate payment status if provided
  if (payload.payment_status) {
    const validStatuses = ['PAID', 'CANCELLED', 'REFUNDED', 'PENDING'];
    if (!validStatuses.includes(payload.payment_status)) {
      throw new Error(`Invalid payment_status: ${payload.payment_status}`);
    }
  }
  
  return true;
}

// QPay callback endpoint (correct URL)
app.post('/qpay/callback', (req, res) => {
  try {
    const payload = req.body;
    const signature = req.headers['x-qpay-signature'];
    const webhookSecret = process.env.QPAY_WEBHOOK_SECRET;
    
    console.log('📩 QPay Callback received:', payload);
    
    // Generate unique webhook ID for idempotency
    const webhookId = crypto
      .createHash('sha256')
      .update(JSON.stringify(payload) + (payload.timestamp || Date.now()))
      .digest('hex');
    
    // Check for duplicate webhook
    if (processedWebhooks.has(webhookId)) {
      console.log(`⚠️ Duplicate webhook detected: ${webhookId}`);
      return res.status(200).json({ status: 'duplicate', message: 'Webhook already processed' });
    }
    
    // Validate payload structure
    validateWebhookPayload(payload);
    
    // Verify signature if secret is configured
    if (webhookSecret && !verifyWebhookSignature(payload, signature, webhookSecret)) {
      console.error('❌ Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    const { object_id, payment_amount, payment_date, transaction_id } = payload;
    
    // Validate payment amount against invoice amount
    let payment_status = payload.payment_status;
    if (!payment_status) {
      // If payment_amount exists and is greater than 0, check if it matches invoice amount
      if (payment_amount && payment_amount > 0) {
        // Check if we have this invoice in our local storage
        if (invoices.has(object_id)) {
          const invoice = invoices.get(object_id);
          const expectedAmount = invoice.amount;
          
          if (payment_amount === expectedAmount) {
            payment_status = "PAID";
            console.log(`✅ Payment amount matches invoice: ${payment_amount} MNT - Status set to PAID`);
          } else {
            payment_status = "CANCELLED";
            console.log(`❌ Payment amount mismatch! Expected: ${expectedAmount} MNT, Received: ${payment_amount} MNT - Status set to CANCELLED`);
          }
        } else {
          // If invoice not found locally, we can't validate, so accept the payment
          payment_status = "PAID";
          console.log(`⚠️ Invoice not found locally, accepting payment: ${payment_amount} MNT - Status set to PAID`);
        }
      } else {
        payment_status = "PENDING";
        console.log(`⏳ No payment amount detected - Status set to PENDING`);
      }
    }
    
    // Store webhook data in mock.json for PAID payments
    if (payment_status === "PAID") {
      const fs = require('fs');
      try {
        const mockData = JSON.parse(fs.readFileSync('./mock.json', 'utf8'));
        
        // Create paid invoice record for mock data
        const paidInvoice = {
          object_id: object_id,
          object_type: payload.object_type || "INVOICE",
          payment_status: payment_status,
          payment_amount: payment_amount,
          payment_date: payment_date,
          sender_invoice_no: payload.sender_invoice_no,
          invoice_description: payload.invoice_description,
          merchant_id: payload.merchant_id,
          transaction_id: transaction_id,
          payment_method: payload.payment_method || "QPAY",
          customer_phone: payload.customer_phone || "NA",
          timestamp: payload.timestamp || Date.now()
        };
        
        // Add to mock.json dynamic_payments
        mockData.dynamic_payments = mockData.dynamic_payments || {};
        mockData.dynamic_payments[object_id] = paidInvoice;
        
        fs.writeFileSync('./mock.json', JSON.stringify(mockData, null, 2));
        console.log(`💾 Paid invoice ${object_id} stored in mock.json`);
        
      } catch (mockError) {
        console.error('❌ Error storing to mock.json:', mockError.message);
      }
    }
    
    // Update invoice status
    if (invoices.has(object_id)) {
      const invoice = invoices.get(object_id);
      invoice.status = payment_status.toLowerCase();
      invoice.payment_amount = payment_amount;
      invoice.payment_date = payment_date;
      invoice.transaction_id = transaction_id;
      invoice.updated_at = new Date();
      invoices.set(object_id, invoice);
      
      console.log(`✅ Invoice ${object_id} status updated to: ${payment_status}`);
      
      // Stop payment monitoring if payment is complete
      if (payment_status === 'PAID' || payment_status === 'CANCELLED') {
        stopPaymentMonitoring(object_id);
      }
    } else {
      console.log(`⚠️ Invoice ${object_id} not found in local storage`);
    }
    
    // Mark webhook as processed
    processedWebhooks.add(webhookId);
    
    // Send success response to QPay
    res.status(200).json({ 
      status: 'success', 
      message: 'Webhook processed and mock data stored',
      webhook_id: webhookId
    });
    
  } catch (error) {
    console.error('❌ Webhook processing error:', error.message);
    res.status(400).json({ 
      error: 'Invalid webhook payload', 
      message: error.message 
    });
  }
});

// Keep old webhook endpoint for backward compatibility
app.post('/webhook/qpay', (req, res) => {
  console.log('⚠️ Deprecated webhook endpoint used. Please use /qpay/callback instead.');
  
  // Forward to new endpoint
  req.url = '/qpay/callback';
  app._router.handle(req, res);
});

// API endpoint to get specific invoice with expiry info
app.get('/api/invoice/:invoiceId', (req, res) => {
  try {
    const { invoiceId } = req.params;
    
    if (!invoices.has(invoiceId)) {
      return res.status(404).json({
        success: false,
        error: 'Invoice not found'
      });
    }
    
    const invoice = invoices.get(invoiceId);
    const now = new Date();
    const createdAt = new Date(invoice.created_at);
    const timeElapsed = now - createdAt;
    const timeRemaining = Math.max(0, 60000 - timeElapsed); // 1 minute = 60000ms
    const isExpired = timeRemaining === 0;
    const isMonitoring = paymentMonitors.has(invoiceId);
    
    res.json({
      success: true,
      invoice: {
        ...invoice,
        time_elapsed_ms: timeElapsed,
        time_remaining_ms: timeRemaining,
        is_expired: isExpired,
        is_monitoring: isMonitoring,
        expires_at: new Date(createdAt.getTime() + 60000).toISOString()
      }
    });
    
  } catch (error) {
    console.error('Error getting invoice:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to list all invoices
app.get('/api/invoices', (req, res) => {
  const invoiceList = Array.from(invoices.values()).map(invoice => {
    const now = new Date();
    const createdAt = new Date(invoice.created_at);
    const timeElapsed = now - createdAt;
    const timeRemaining = Math.max(0, 60000 - timeElapsed);
    const isExpired = timeRemaining === 0;
    const isMonitoring = paymentMonitors.has(invoice.invoice_id);
    
    return {
      ...invoice,
      time_elapsed_ms: timeElapsed,
      time_remaining_ms: timeRemaining,
      is_expired: isExpired,
      is_monitoring: isMonitoring,
      expires_at: new Date(createdAt.getTime() + 600000).toISOString()
    };
  });
  
  res.json({
    success: true,
    invoices: invoiceList
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Сервер ажиллаж байна: http://localhost:${PORT}`);
  console.log(`📋 Веб хуудсаа нээж нэхэмжлэл үүсгээрэй`);
  console.log(`🔗 QPay холбогдох URL: ${qpay.BASE_URL}`);
});

module.exports = app; 