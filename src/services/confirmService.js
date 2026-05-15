const db = require('../config/db');

// ---------- QR 码解析 ----------

/**
 * 解析二维码内容
 * 格式: CUST. P/N:G8020-60091;MPN:G8020-60091;DATE CODE:2618;REV:D.00;PO:5004458616;WO:J000032579;QUANTITY:15;V/C:22001370;WEIGHT:;PACKING COUNT:1 OF 2
 * 
 * 单箱: PACKING COUNT: 1 OF
 * 多箱: PACKING COUNT: 1 OF 2
 */
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
      case 'CUST. P/N':
        result.custPn = value;
        break;
      case 'MPN':
        result.mpn = value;
        break;
      case 'DATE CODE':
        result.dateCode = value;
        break;
      case 'REV':
        result.revision = value;
        break;
      case 'PO':
        result.po = value;
        break;
      case 'WO':
        result.wo = value;
        break;
      case 'QUANTITY':
        result.quantity = parseInt(value) || 0;
        break;
      case 'V/C':
        result.vc = value;
        break;
      case 'WEIGHT':
        result.weight = value;
        break;
      case 'PACKING COUNT':
        // "1 OF 2" → boxNum=1, totalBoxes=2
        // "1 OF"   → boxNum=1, totalBoxes=1
        // "OF"     → 纯单箱无箱号，boxNum/totalBoxes 不设置（验证时跳过箱号检查）
        if (/^OF$/i.test(value)) {
          // 纯 "OF"，单箱无箱号信息，不设置 boxNum/totalBoxes
        } else {
          const twoNums = value.match(/^(\d+)\s+OF\s+(\d+)$/i);
          const oneNum = value.match(/^(\d+)\s+OF$/i);
          if (twoNums) {
            result.boxNum = parseInt(twoNums[1]);
            result.totalBoxes = parseInt(twoNums[2]);
          } else if (oneNum) {
            result.boxNum = parseInt(oneNum[1]);
            result.totalBoxes = parseInt(oneNum[1]);
          }
        }
        break;
    }
  }
  
  return result;
}

// ---------- 确认创建 ----------

const insertConfirmation = db.prepare(`
  INSERT INTO shipping_confirmations 
    (pick_list_id, site_ref, cust_num, cust_name, due_date, ship_code, total_cartons, total_items, operator)
  VALUES 
    (@pick_list_id, @site_ref, @cust_num, @cust_name, @due_date, @ship_code, @total_cartons, @total_items, @operator)
`);

const insertItem = db.prepare(`
  INSERT INTO confirmation_items 
    (confirmation_id, pick_list_ref_id, sequence, ref_num, item_code, item_name, qty_to_pick, um, planned_boxes, wo_number, cust_po_num)
  VALUES 
    (@confirmation_id, @pick_list_ref_id, @sequence, @ref_num, @item_code, @item_name, @qty_to_pick, @um, @planned_boxes, @wo_number, @cust_po_num)
`);

/**
 * 开始一个新的出货确认
 */
function startConfirmation(notice, items, operator = 'operator') {
  const txn = db.transaction(() => {
    const res = insertConfirmation.run({
      pick_list_id: String(notice.PickListId),
      site_ref: notice.SiteRef,
      cust_num: notice.CustNum,
      cust_name: notice.cust_name || '',
      due_date: notice.due_date ? notice.due_date.toISOString().split('T')[0] : null,
      ship_code: notice.ship_code,
      total_cartons: parseInt(notice.total_cartons) || 0,
      total_items: items.length,
      operator,
    });

    const confirmationId = res.lastInsertRowid;

    for (const item of items) {
      insertItem.run({
        confirmation_id: confirmationId,
        pick_list_ref_id: item.Sequence,
        sequence: item.Sequence,
        ref_num: item.RefNum,
        item_code: item.item_code,
        item_name: item.item_name,
        qty_to_pick: item.qty_to_pick,
        um: item.um,
        planned_boxes: parseInt(item.planned_boxes) || 0,
        wo_number: item.RefNum || null,
        cust_po_num: item.cust_po_num || null,
      });
    }

    return confirmationId;
  });

  return txn();
}

// ---------- 扫码处理 ----------

const getActiveItem = db.prepare(`
  SELECT * FROM confirmation_items 
  WHERE confirmation_id = @confirmation_id AND status != 'completed'
  ORDER BY sequence ASC
  LIMIT 1
`);

const checkBarcodeDuplicate = db.prepare(`
  SELECT COUNT(*) AS cnt FROM scan_logs 
  WHERE confirmation_id = @confirmation_id AND barcode = @barcode AND scan_result = 'success'
`);

const insertScanLog = db.prepare(`
  INSERT INTO scan_logs 
    (confirmation_id, item_id, barcode, cust_pn, wo_number, box_num, total_boxes, scan_result, error_message, confirm_id)
  VALUES 
    (@confirmation_id, @item_id, @barcode, @cust_pn, @wo_number, @box_num, @total_boxes, @scan_result, @error_message, @confirm_id)
`);

const updateItemScan = db.prepare(`
  UPDATE confirmation_items SET 
    scanned_boxes = scanned_boxes + 1,
    status = CASE WHEN scanned_boxes + 1 >= planned_boxes THEN 'completed' ELSE 'scanning' END,
    started_at = COALESCE(started_at, datetime('now', 'localtime')),
    completed_at = CASE WHEN scanned_boxes + 1 >= planned_boxes THEN datetime('now', 'localtime') ELSE completed_at END
  WHERE id = @id
`);

const updateConfirmationScan = db.prepare(`
  UPDATE shipping_confirmations SET 
    scanned_boxes = scanned_boxes + 1,
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

const markConfirmationPendingSignature = db.prepare(`
  UPDATE shipping_confirmations SET 
    status = 'pending_signature',
    completed_at = datetime('now', 'localtime')
  WHERE id = @id
`);

const saveSignatureStmt = db.prepare(`
  UPDATE shipping_confirmations SET 
    status = 'confirmed',
    signature = @signature,
    signed_by = @signed_by
  WHERE id = @id AND status = 'pending_signature'
`);

const getConfirmationById = db.prepare(`
  SELECT * FROM shipping_confirmations WHERE id = @id
`);

const getItemsByConfirmation = db.prepare(`
  SELECT * FROM confirmation_items WHERE confirmation_id = @id ORDER BY sequence
`);

/**
 * 处理一次扫码
 */
function processScan(confirmationId, barcode) {
  const confirmation = getConfirmationById.get({ id: confirmationId });
  if (!confirmation) {
    return { success: false, error: '确认记录不存在' };
  }
  if (confirmation.status === 'confirmed') {
    return { success: false, error: '此出货通知已完成确认' };
  }

  // 检查重复
  const dup = checkBarcodeDuplicate.get({ confirmation_id: confirmationId, barcode });
  if (dup.cnt > 0) {
    const parsed = parseQRCode(barcode);
    insertScanLog.run({
      confirmation_id: confirmationId,
      item_id: null,
      barcode,
      cust_pn: parsed.custPn || null,
      wo_number: parsed.wo || null,
      box_num: parsed.boxNum || null,
      total_boxes: parsed.totalBoxes || null,
      scan_result: 'failed',
      error_message: '条码重复扫描',
      confirm_id: null,
    });
    return { success: false, error: '条码重复扫描', duplicate: true };
  }

  const currentItem = getActiveItem.get({ confirmation_id: confirmationId });
  if (!currentItem) {
    return { success: false, error: '没有待确认的品项' };
  }

  // 解析二维码
  const qr = parseQRCode(barcode);

  // 验证二维码内容
  const validationErrors = validateQRCode(qr, currentItem);
  if (validationErrors.length > 0) {
    insertScanLog.run({
      confirmation_id: confirmationId,
      item_id: currentItem.id,
      barcode,
      cust_pn: qr.custPn || null,
      wo_number: qr.wo || null,
      box_num: qr.boxNum || null,
      total_boxes: qr.totalBoxes || null,
      scan_result: 'failed',
      error_message: validationErrors.join(' | '),
      confirm_id: null,
    });
    return { 
      success: false, 
      error: validationErrors.join(' | '),
      qrInfo: qr,
      currentItem: {
        item_code: currentItem.item_code,
        item_name: currentItem.item_name,
        wo_number: currentItem.wo_number,
      }
    };
  }

  // 验证通过，记录扫码
  const confirmId = `CNF-${Date.now().toString(36).toUpperCase()}`;
  insertScanLog.run({
    confirmation_id: confirmationId,
    item_id: currentItem.id,
    barcode,
    cust_pn: qr.custPn || null,
    wo_number: qr.wo || null,
    box_num: qr.boxNum || null,
    total_boxes: qr.totalBoxes || null,
    scan_result: 'success',
    error_message: null,
    confirm_id: confirmId,
  });

  // 更新品项扫描数
  updateItemScan.run({ id: currentItem.id });

  // 更新主表扫描数
  updateConfirmationScan.run({ id: confirmationId });

  // 计算进度
  const refreshedItem = db.prepare('SELECT * FROM confirmation_items WHERE id = ?').get(currentItem.id);
  const progress = checkAllCompleted.get({ confirmation_id: confirmationId });
  const updatedConfirmation = getConfirmationById.get({ id: confirmationId });

  let allDone = false;
  if (progress.completed >= progress.total) {
    markConfirmationPendingSignature.run({ id: confirmationId });
    allDone = true;
  }

  return {
    success: true,
    confirm_id: confirmId,
    barcode,
    qrInfo: {
      custPn: qr.custPn,
      wo: qr.wo,
      dateCode: qr.dateCode,
      quantity: qr.quantity,
      boxNum: qr.boxNum,
      totalBoxes: qr.totalBoxes,
    },
    item: refreshedItem,
    progress: {
      currentScanned: refreshedItem.scanned_boxes,
      currentPlanned: refreshedItem.planned_boxes,
      totalScanned: updatedConfirmation.scanned_boxes,
      totalPlanned: updatedConfirmation.total_cartons,
      allCompleted: allDone,
    },
    allCompleted: allDone,
  };
}

/**
 * 验证二维码信息是否与当前品项匹配
 */
function validateQRCode(qr, currentItem) {
  const errors = [];
  
  // 验证品号（CUST. P/N）
  if (qr.custPn && qr.custPn !== currentItem.item_code) {
    errors.push(`品号不匹配：${qr.custPn} (期望 ${currentItem.item_code})`);
  }
  
  // 验证 WO 工单号
  if (qr.wo && currentItem.wo_number && qr.wo !== currentItem.wo_number) {
    errors.push(`工单号不匹配：${qr.wo} (期望 ${currentItem.wo_number})`);
  }
  
  // 验证箱号顺序（只在有箱号信息时验证）
  // PACKING COUNT: OF → boxNum=undefined, 跳过箱号验证
  if (qr.boxNum && qr.boxNum > 0) {
    const expectedNextBox = currentItem.scanned_boxes + 1;
    if (qr.boxNum !== expectedNextBox) {
      errors.push(`箱号不匹配：扫到第 ${qr.boxNum} 箱，期望第 ${expectedNextBox} 箱`);
    }
  }
  
  // 验证总箱数（只在有总箱数信息时验证）
  if (qr.totalBoxes && qr.totalBoxes > 0 && qr.totalBoxes !== currentItem.planned_boxes) {
    errors.push(`总箱数不符：条码显示 ${qr.totalBoxes} 箱，计划 ${currentItem.planned_boxes} 箱`);
  }
  
  return errors;
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

/**
 * 保存签名并标记确认为已完成
 */
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
};
