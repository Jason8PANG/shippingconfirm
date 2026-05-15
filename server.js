require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const expressLayouts = require('express-ejs-layouts');

const warehouseQuery = require('./src/services/warehouseQuery');
const confirmService = require('./src/services/confirmService');
const db = require('./src/config/db');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// ---- 基础配置 ----
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));
app.use(expressLayouts);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'src', 'public')));

// ---- Socket.IO ----
io.on('connection', (socket) => {
  console.log(`[Socket] 客户端连接: ${socket.id}`);

  socket.on('scan-barcode', async (data) => {
    const { confirmationId, barcode } = data;
    if (!confirmationId || !barcode) return;

    const result = confirmService.processScan(confirmationId, barcode.trim());

    // 广播扫码结果给房间内所有客户端
    io.to(String(confirmationId)).emit('scan-result', result);

    if (result.success) {
      // 广播最新进度
      const confirmation = confirmService.getConfirmationById.get({ id: confirmationId });
      const items = confirmService.getItemsByConfirmationId.all({ id: confirmationId });
      io.to(String(confirmationId)).emit('progress-update', { confirmation, items });
    }
  });

  socket.on('join-confirmation', (confirmationId) => {
    socket.join(String(confirmationId));
    console.log(`[Socket] ${socket.id} 加入房间: ${confirmationId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] 客户端断开: ${socket.id}`);
  });
});

// ---- 路由 ----

// 首页 — 扫码确认
app.get('/', (req, res) => {
  const { error, success } = req.query;
  res.render('scan', { error, success });
});

// 查询出货通知 — 列表
app.get('/api/notices', async (req, res) => {
  try {
    const notices = await warehouseQuery.getPendingShippingNotices();
    res.json({ success: true, data: notices });
  } catch (err) {
    console.error('查询出货通知失败:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// 查询出货通知 — 详情（含品项）
app.get('/api/notices/:id', async (req, res) => {
  try {
    const notice = await warehouseQuery.getShippingNoticeById(req.params.id);
    const items = await warehouseQuery.getShippingNoticeItems(req.params.id);
    res.json({ success: true, data: { notice, items } });
  } catch (err) {
    console.error('查询出货通知详情失败:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// 开始出货确认
app.post('/api/confirmations/start', async (req, res) => {
  try {
    const { id } = req.body;
    const operator = req.body.operator || 'operator';

    // 先检查出货通知是否存在
    const notice = await warehouseQuery.getShippingNoticeById(id);
    if (!notice) {
      return res.json({ success: false, error: 'not_found', message: 'Shipping Notice not found in warehouse system' });
    }

    // 检查本地是否已有确认记录
    const existing = confirmService.getConfirmationByPickListId.get({ pick_list_id: String(id) });
    if (existing) {
      if (existing.status === 'confirmed') {
        // 已确认完成，不允许重复
        return res.json({ success: false, error: 'already_confirmed', message: 'This Shipping Notice has already been confirmed', confirmation: existing });
      } else if (existing.status === 'cancelled') {
        // 已取消，允许重新确认（删除旧记录）
        confirmService.deleteConfirmationById(existing.id);
      } else {
        // 进行中/待确认
        return res.json({ success: false, error: 'in_progress', message: 'This Shipping Notice is already being confirmed', confirmationId: existing.id, status: existing.status });
      }
    }

    const items = await warehouseQuery.getShippingNoticeItems(id);
    if (!items.length) {
      return res.json({ success: false, error: 'no_items', message: 'No items to confirm in this Shipping Notice' });
    }

    const confirmationId = confirmService.startConfirmation(notice, items, operator);

    res.json({ success: true, confirmationId, notice, items });
  } catch (err) {
    console.error('开始出货确认失败:', err.message);
    res.json({ success: false, error: 'server_error', message: err.message });
  }
});

// 获取确认详情
app.get('/api/confirmations/:id', (req, res) => {
  try {
    const confirmation = confirmService.getConfirmationById.get({ id: req.params.id });
    const items = confirmService.getItemsByConfirmationId.all({ id: req.params.id });
    if (!confirmation) {
      return res.json({ success: false, error: '确认记录不存在' });
    }
    res.json({ success: true, data: { confirmation, items } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 扫码接口（HTTP fallback，实际使用以 Socket.IO 为主）
app.post('/api/scan', (req, res) => {
  try {
    const { confirmationId, barcode } = req.body;
    if (!confirmationId || !barcode) {
      return res.json({ success: false, error: '缺少参数' });
    }
    const result = confirmService.processScan(confirmationId, barcode.trim());
    res.json(result);
  } catch (err) {
    console.error('扫码处理失败:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// 历史记录查询（支持日期、客户、PickListId、站点过滤）
app.get('/api/history', (req, res) => {
  try {
    const { startDate, endDate, customer, pickListId, siteRef } = req.query;
    let confirmations;
    if (pickListId) {
      // 优先按 PickListId 精确查找
      confirmations = confirmService.getConfirmationByPickListIdLike.all({ pick_list_id: '%' + pickListId + '%' });
    } else if (startDate && endDate) {
      confirmations = confirmService.getConfirmationsByDateRange.all({ startDate, endDate });
    } else {
      confirmations = confirmService.getAllConfirmations.all();
    }

    // 客户名称过滤
    if (customer) {
      const kw = customer.toLowerCase();
      confirmations = confirmations.filter(c => (c.cust_name || '').toLowerCase().includes(kw));
    }

    // 站点过滤
    if (siteRef) {
      confirmations = confirmations.filter(c => c.site_ref === siteRef);
    }

    res.json({ success: true, data: confirmations });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/history/:id', (req, res) => {
  try {
    const confirmation = confirmService.getConfirmationById.get({ id: req.params.id });
    const items = confirmService.getItemsByConfirmationId.all({ id: req.params.id });
    const logs = confirmService.getScanLogsByConfirmationId.all({ id: req.params.id });
    if (!confirmation) {
      return res.json({ success: false, error: '记录不存在' });
    }
    res.json({ success: true, data: { confirmation, items, logs } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 历史记录页面
app.get('/history', (req, res) => {
  res.render('history');
});

// 签名保存
app.post('/api/confirmations/:id/sign', (req, res) => {
  try {
    const { id } = req.params;
    const { signature, signedBy } = req.body;
    if (!signature) {
      return res.json({ success: false, error: '签名不能为空' });
    }
    if (!signedBy || !signedBy.trim()) {
      return res.json({ success: false, error: '签名者姓名不能为空' });
    }
    const result = confirmService.saveSignature(id, signature, signedBy.trim());
    res.json(result);
  } catch (err) {
    console.error('签名保存失败:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ---- 启动 ----
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 出货确认系统已启动: http://localhost:${PORT}`);
});
