const db = require('../config/db');

// ---------- QR 码解析（保留供旧数据兼容，新流程不再使用） ----------

function parseQRCode(raw) {
  const result = { raw };
  if (!raw || typeof raw !== 'string') return result;
  const pairs = raw.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    const key = pair.substring(0, idx).trim().toUpperCase();
    const value = pair.substring(idx + 1).trim();
    switch (key) {
      case 'CUST. P/N': result.custPn = value; break;
      case 'WO': result.wo = value; break;
      case 'QUANTITY': result.quantity = parseInt(value) || 0; break;
      case 'PACKING COUNT':
        if (!/^OF$/i.test(value)) {
          const m = value.match(/^(\d+)\s+OF\s+(\d+)$/i);
          if (m) { result.boxNum = parseInt(m[1]); result.totalBoxes = parseInt(m[2]); }
          else { const m2 = value.match(/^(\d+)\s+OF$/i); if (m2) { result.boxNum = parseInt(m2[1]); result.totalBoxes = parseInt(m2[1]); } }
        }
        break;
    }
  }
  return result;
}

// ---------- 确认创建 ----------

const insertConfirmation = db.prepare(`
  INSERT INTO shipping_confirmations 
    (pick_list_id, site_ref, cust_num, cust_name, drop_cust_name, due_date, ship_code, total_cartons, total_items, operator, total_ship_qty)
  VALUES 
    (@pick_list_id, @site_ref, @cust_num, @cust_name, @drop_cust_name, @due_date, @ship_code, @total_cartons, @total_items, @operator, @total_ship_qty)
`);

const insertItem = db.prepare(`
  INSERT INTO confirmation_items 
    (confirmation_id, pick_list_ref_id, sequence, ref_num, item_code, item_name, qty_to_pick, um, planned_boxes, wo_number, cust_po_num, location)
  VALUES 
    (@confirmation_id, @pick_list_ref_id, @sequence, @ref_num, @item_code, @item_name, @qty_to_pick, @um, @planned_boxes, @wo_number, @cust_po_num, @location)
`);

/**
 * 开始一个新的出货确认
 */
function startConfirmation(notice, items, operator = 'operator') {
  const totalShipQty = items.reduce((sum, item) => sum + (parseFloat(item.qty_to_pick) || 0), 0);

  const txn = db.transaction(() => {
    const res = insertConfirmation.run({
      pick_list_id: String(notice.PickListId),
      site_ref: notice.SiteRef,
      cust_num: notice.CustNum,
      cust_name: notice.cust_name || '',
      drop_cust_name: notice.drop_cust_name || '',
      due_date: notice.due_date ? notice.due_date.toISOString().split('T')[0] : null,
      ship_code: notice.ship_code,
      total_cartons: parseInt(notice.total_cartons) || 0,
      total_items: items.length,
      operator,
      total_ship_qty: totalShipQty,
    });

    const confirmationId = res.lastInsertRowid;

    for (const item of items) {
      insertItem.run({
        confirmation_id: confirmationId,
        pick_list_ref_id: item.sequence,
        sequence: item.sequence,
        ref_num: item.ref_num,
        item_code: item.item_code,
        item_name: item.item_name,
        qty_to_pick: item.qty_to_pick,
        um: item.um,
        planned_boxes: parseInt(item.planned_boxes) || 0,
        wo_number: item.wo_number || null,
        cust_po_num: item.cust_po_num || null,
        location: item.location || null,
      });
    }

    return confirmationId;
  });

  return txn();
}

// ---------- 扫码处理（v2: 工单+数量 模式） ----------

const getItemsByWo = db.prepare(`
  SELECT * FROM confirmation_items 
  WHERE confirmation_id = @confirmation_id AND wo_number = @wo_number
  ORDER BY sequence ASC
`);

const getAllItemsByConfirmation = db.prepare(`
  SELECT * FROM confirmation_items 
  WHERE confirmation_id = @confirmation_id
  ORDER BY sequence ASC
`);

const insertScanLog = db.prepare(`
  INSERT INTO scan_logs 
    (confirmation_id, item_id, barcode, wo_number, scanned_qty, scan_result, error_message, confirm_id)
  VALUES 
    (@confirmation_id, @item_id, @barcode, @wo_number, @scanned_qty, @scan_result, @error_message, @confirm_id)
`);

const updateItemScannedQty = db.prepare(`
  UPDATE confirmation_items SET 
    scanned_qty = @scanned_qty,
    scanned_boxes = @scanned_boxes,
    status = CASE 
      WHEN scanned_qty >= qty_to_pick THEN 'completed' 
      WHEN scanned_qty > 0 THEN 'scanning' 
      ELSE 'pending' 
    END,
    started_at = COALESCE(started_at, datetime('now', 'localtime')),
    completed_at = CASE WHEN scanned_qty >= qty_to_pick THEN datetime('now', 'localtime') ELSE completed_at END
  WHERE id = @id
`);

const updateConfirmationTotals = db.prepare(`
  UPDATE shipping_confirmations SET 
    scanned_boxes = @scanned_boxes,
    total_scanned_qty = @total_scanned_qty,
    status = 'in_progress'
  WHERE id = @id
`);

const checkAllCompleted = db.prepare(`
  SELECT 
    COUNT(*) AS total,
    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
  FROM confirmation_items 
  WHERE confirmation_id = @confirmation_id
`);

const getConfirmationById = db.prepare(`
  SELECT * FROM shipping_confirmations WHERE id = @id
`);

const markConfirmationPendingSignature = db.prepare(`
  UPDATE shipping_confirmations SET 
    status = 'pending_signature',
    completed_at = datetime('now', 'localtime')
  WHERE id = @id
`);

/**
 * 处理一次扫描（v2: 工单号 + 数量）
 * 
 * 流程：
 * 1. 查找该确认记录中所有匹配 WO 的品项
 * 2. 将扫描数量按顺序分摊到各品项
 * 3. 更新各品项的 scanned_qty 和状态
 * 4. 计算汇总进度
 * 5. 返回结果
 */
function processScan(confirmationId, woNumber, quantity) {
  const confirmation = getConfirmationById.get({ id: confirmationId });
  if (!confirmation) {
    return { success: false, error: '确认记录不存在' };
  }
  if (confirmation.status === 'confirmed') {
    return { success: false, error: '此出货通知已完成确认' };
  }

  // 数量校验
  const qty = parseFloat(quantity);
  if (!qty || qty <= 0) {
    return { success: false, error: '数量必须大于0' };
  }

  if (!woNumber || !woNumber.trim()) {
    return { success: false, error: '工单号不能为空' };
  }

  const wo = woNumber.trim();

  // 查找匹配该 WO 的所有品项
  const matchedItems = getItemsByWo.all({ confirmation_id: confirmationId, wo_number: wo });
  
  if (matchedItems.length === 0) {
    // WO 不在出货清单中
    const confirmId = `CNF-${Date.now().toString(36).toUpperCase()}`;
    insertScanLog.run({
      confirmation_id: confirmationId,
      item_id: null,
      barcode: wo,
      wo_number: wo,
      scanned_qty: qty,
      scan_result: 'failed',
      error_message: '工单号不在出货清单中',
      confirm_id: null,
    });
    return { 
      success: false, 
      error: '工单号不在出货清单中',
      wo: wo,
    };
  }

  // 计算该 WO 已扫描总量和总出货量
  const woTotalShipQty = matchedItems.reduce((sum, item) => sum + (parseFloat(item.qty_to_pick) || 0), 0);
  const woTotalScannedQty = matchedItems.reduce((sum, item) => sum + (parseFloat(item.scanned_qty) || 0), 0);
  const woRemainingQty = woTotalShipQty - woTotalScannedQty;

  // 超量警告但仍然记录
  const overQty = qty > woRemainingQty;

  // --- 数量分摊：按 sequence 顺序，先填满前面的行 ---
  let remaining = qty;
  const updates = [];

  for (const item of matchedItems) {
    if (remaining <= 0) {
      // 没有剩余数量需要分摊了，但不影响该行的 scanned_qty
      updates.push({ id: item.id, scanned_qty: item.scanned_qty, allocated: 0 });
      continue;
    }
    const itemQty = parseFloat(item.qty_to_pick) || 0;
    const itemScanned = parseFloat(item.scanned_qty) || 0;
    const itemRemaining = itemQty - itemScanned;

    if (itemRemaining <= 0) {
      // 该行已满，跳过
      updates.push({ id: item.id, scanned_qty: item.scanned_qty, allocated: 0 });
      continue;
    }

    const allocate = Math.min(itemRemaining, remaining);
    updates.push({ 
      id: item.id, 
      scanned_qty: itemScanned + allocate, 
      allocated: allocate 
    });
    remaining -= allocate;
  }

  // 如果还有多余数量，加到最后一行（超量记录）
  if (remaining > 0 && updates.length > 0) {
    const lastIdx = updates.length - 1;
    updates[lastIdx].scanned_qty += remaining;
    updates[lastIdx].allocated += remaining;
    remaining = 0;
  }

  // --- 写入数据库 ---
  const confirmId = `CNF-${Date.now().toString(36).toUpperCase()}`;
  
  // 事务：更新所有品项 + 记录扫描日志 + 更新主表
  const txn = db.transaction(() => {
    // 记录扫描日志（记到第一个匹配的品项上）
    insertScanLog.run({
      confirmation_id: confirmationId,
      item_id: matchedItems[0].id,
      barcode: wo,
      wo_number: wo,
      scanned_qty: qty,
      scan_result: 'success',
      error_message: overQty ? `超量：WO总需${woTotalShipQty}，已扫${woTotalScannedQty}+本次${qty}` : null,
      confirm_id: confirmId,
    });

    // 计算该 WO 的已核对箱数（成功扫描次数）
    const woScanCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM scan_logs 
      WHERE confirmation_id = ? AND wo_number = ? AND scan_result = 'success'
    `).get(confirmationId, wo);

    // 更新各品项
    for (const upd of updates) {
      updateItemScannedQty.run({
        id: upd.id,
        scanned_qty: upd.scanned_qty,
        scanned_boxes: woScanCount.cnt,
      });
    }

    // 计算全表汇总
    const allItems = getAllItemsByConfirmation.all({ confirmation_id: confirmationId });
    const totalScannedBoxes = db.prepare(`
      SELECT COUNT(*) AS cnt FROM scan_logs 
      WHERE confirmation_id = ? AND scan_result = 'success'
    `).get(confirmationId);

    const totalScannedQty = allItems.reduce((sum, item) => sum + (parseFloat(item.scanned_qty) || 0), 0);

    updateConfirmationTotals.run({
      id: confirmationId,
      scanned_boxes: totalScannedBoxes.cnt,
      total_scanned_qty: totalScannedQty,
    });

    return { allItems, totalScannedBoxes: totalScannedBoxes.cnt, totalScannedQty };
  });

  const result = txn();

  // 计算进度
  const progress = checkAllCompleted.get({ confirmation_id: confirmationId });
  const updatedConfirmation = getConfirmationById.get({ id: confirmationId });

  // 判定：所有行都已完成，或者所有 WO 总量满足
  let allDone = false;
  
  // 方法1：逐行检查（每行 scanned_qty >= qty_to_pick）
  if (progress.completed >= progress.total) {
    allDone = true;
  }
  
  // 方法2：按 WO 分组检查（如果 WO 总扫描 >= WO 总出货，该 WO 下所有行算完成）
  if (!allDone) {
    const allItems = result.allItems;
    // 按 WO 分组
    const woGroups = {};
    for (const item of allItems) {
      const woKey = item.wo_number || `__no_wo_${item.id}`;
      if (!woGroups[woKey]) woGroups[woKey] = [];
      woGroups[woKey].push(item);
    }
    
    let allWoDone = true;
    for (const [woKey, group] of Object.entries(woGroups)) {
      const groupTotalShip = group.reduce((s, i) => s + (parseFloat(i.qty_to_pick) || 0), 0);
      const groupTotalScanned = group.reduce((s, i) => s + (parseFloat(i.scanned_qty) || 0), 0);
      if (groupTotalScanned < groupTotalShip) {
        allWoDone = false;
        break;
      }
    }
    
    if (allWoDone && Object.keys(woGroups).length > 0) {
      allDone = true;
    }
  }

  // 只有数量完全匹配时才允许完成（不存在超量或不足）
  let qtyMismatch = false;
  if (allDone) {
    const allItems = result.allItems;
    const totalShip = allItems.reduce((s, i) => s + (parseFloat(i.qty_to_pick) || 0), 0);
    const totalScanned = allItems.reduce((s, i) => s + (parseFloat(i.scanned_qty) || 0), 0);
    // 允许浮点误差
    if (Math.abs(totalScanned - totalShip) > 0.001) {
      qtyMismatch = true;
      allDone = false; // 数量不匹配，不允许完成
    }
  }

  if (allDone) {
    markConfirmationPendingSignature.run({ id: confirmationId });
  }

  // 构建返回结果
  const refreshedItems = getAllItemsByConfirmation.all({ confirmation_id: confirmationId });

  // 计算汇总统计
  const summary = buildSummary(refreshedItems);

  return {
    success: true,
    confirm_id: confirmId,
    wo: wo,
    scanned_qty: qty,
    over_qty: overQty,
    allocated: updates.map(u => u.allocated),
    items: refreshedItems,
    summary,
    progress: {
      completedRows: progress.completed,
      totalRows: progress.total,
      allCompleted: allDone,
      qtyMismatch,
    },
    confirmation: getConfirmationById.get({ id: confirmationId }),
    allCompleted: allDone,
  };
}

/**
 * 构建汇总统计
 */
function buildSummary(items) {
  let totalShipQty = 0;
  let totalScannedQty = 0;
  let verifiedRows = 0;
  let totalRows = items.length;
  let totalScannedBoxes = 0;

  // 按 WO 分组
  const woGroups = {};
  for (const item of items) {
    const woKey = item.wo_number || `__no_wo_${item.id}`;
    if (!woGroups[woKey]) woGroups[woKey] = [];
    woGroups[woKey].push(item);

    totalShipQty += parseFloat(item.qty_to_pick) || 0;
    totalScannedQty += parseFloat(item.scanned_qty) || 0;
    totalScannedBoxes += parseInt(item.scanned_boxes) || 0;
  }

  // 按WO判定已核对行数
  for (const [woKey, group] of Object.entries(woGroups)) {
    const groupTotalShip = group.reduce((s, i) => s + (parseFloat(i.qty_to_pick) || 0), 0);
    const groupTotalScanned = group.reduce((s, i) => s + (parseFloat(i.scanned_qty) || 0), 0);
    
    if (groupTotalScanned >= groupTotalShip) {
      // WO 总量满足，该 WO 下所有行算已核对
      verifiedRows += group.length;
    } else {
      // WO 总量不足，逐行检查
      for (const item of group) {
        if ((parseFloat(item.scanned_qty) || 0) >= (parseFloat(item.qty_to_pick) || 0)) {
          verifiedRows++;
        }
      }
    }
  }

  return {
    totalShipQty,
    totalScannedQty,
    totalUnverifiedQty: totalShipQty - totalScannedQty,
    verifiedRows,
    totalRows,
    totalScannedBoxes,
  };
}

// ---------- 查询 ----------

const getAllConfirmations = db.prepare(`
  SELECT * FROM shipping_confirmations 
  ORDER BY created_at DESC
`);

const getConfirmationsByDateRange = db.prepare(`
  SELECT * FROM shipping_confirmations 
  WHERE date(created_at) BETWEEN date(@startDate) AND date(@endDate)
  ORDER BY created_at DESC
`);

const getConfirmationByPickListId = db.prepare(`
  SELECT * FROM shipping_confirmations WHERE pick_list_id = @pick_list_id
`);

const getConfirmationByPickListIdLike = db.prepare(`
  SELECT * FROM shipping_confirmations WHERE pick_list_id LIKE @pick_list_id
  ORDER BY created_at DESC
`);

const deleteConfirmationById = db.prepare(`
  DELETE FROM shipping_confirmations WHERE id = @id
`);

const getItemsByConfirmationId = db.prepare(`
  SELECT * FROM confirmation_items WHERE confirmation_id = @id ORDER BY sequence
`);

const getScanLogsByConfirmationId = db.prepare(`
  SELECT * FROM scan_logs WHERE confirmation_id = @id ORDER BY scanned_at DESC
`);

const getScanLogsByItemId = db.prepare(`
  SELECT * FROM scan_logs WHERE item_id = @item_id ORDER BY scanned_at DESC
`);

// ---------- 签名保存 ----------

const saveSignatureStmt = db.prepare(`
  UPDATE shipping_confirmations SET 
    status = 'confirmed',
    signature = @signature,
    signed_by = @signed_by
  WHERE id = @id AND status = 'pending_signature'
`);

function saveSignature(confirmationId, signatureBase64, signedBy) {
  const result = saveSignatureStmt.run({ id: confirmationId, signature: signatureBase64, signed_by: signedBy });
  if (result.changes === 0) {
    return { success: false, error: '签名保存失败：确认记录状态不正确' };
  }
  return { success: true };
}

module.exports = {
  parseQRCode,
  startConfirmation,
  processScan,
  getAllConfirmations,
  getConfirmationsByDateRange,
  getConfirmationByPickListId,
  getConfirmationByPickListIdLike,
  deleteConfirmationById,
  getConfirmationById,
  getItemsByConfirmationId,
  getScanLogsByConfirmationId,
  getScanLogsByItemId,
  saveSignature,
  buildSummary,
};
