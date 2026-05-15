const sql = require('mssql');

const serverName = process.env.MSSQL_SERVER || 'SUZVPRINT01\\CUSTOMSSYS';

const poolConfig = {
  server: serverName.split('\\')[0],
  database: process.env.MSSQL_DATABASE || 'csi_datawarehouse',
  user: process.env.MSSQL_USER || 'naipowerbiuser',
  password: process.env.MSSQL_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    instanceName: serverName.includes('\\') ? serverName.split('\\')[1] : undefined,
  },
  pool: { min: 0, max: 5, idleTimeoutMillis: 30000 },
};

let pool = null;

async function getPool() {
  if (pool) return pool;
  pool = await sql.connect(poolConfig);
  return pool;
}

/**
 * 获取所有未完成的出货通知 (Status='O')
 */
async function getPendingShippingNotices() {
  const pool = await getPool();
  const result = await pool.request()
    .query(`
      SELECT 
        PickListId, SiteRef, CustNum, 
        drop_Cust_Name AS cust_name,
        due_date, Status, 
        total_cartons, Ship_Code AS ship_code,
        CreatedBy AS created_by,
        CreateDate AS created_date
      FROM dbo.SLPickLists
      WHERE Status = 'O'
      ORDER BY due_date DESC, PickListId DESC
    `);
  return result.recordset;
}

/**
 * 获取出货通知详情
 */
async function getShippingNoticeById(id) {
  const pool = await getPool();
  const result = await pool.request()
    .input('id', sql.NVarChar, String(id))
    .query(`
      SELECT 
        PickListId, SiteRef, CustNum,
        drop_Cust_Name AS cust_name,
        due_date, Status, total_cartons,
        Ship_Code AS ship_code, Remark,
        CreatedBy AS created_by,
        CreateDate AS created_date
      FROM dbo.SLPickLists
      WHERE PickListId = @id
    `);
  return result.recordset[0] || null;
}

/**
 * 获取出货通知的明细品项
 * 根据 package_number 计算每个品项的计划箱数
 */
async function getShippingNoticeItems(id) {
  const pool = await getPool();
  const result = await pool.request()
    .input('id', sql.Int, parseInt(id))
    .query(`
      SELECT 
        Sequence,
        RefNum,
        RefLineSuf,
        RefRelease,
        item AS item_code,
        description AS item_name,
        QtyToPick AS qty_to_pick,
        um,
        package_number AS planned_boxes,
        package_piece_per_box,
        cust_po_num,
        cust_po_line,
        customer_item,
        package_Type AS package_type,
        drawing_nbr,
        customs_hs_code
      FROM dbo.SLPickListRefs
      WHERE PickListId = @id
      ORDER BY Sequence
    `);
  return result.recordset;
}

module.exports = {
  getPendingShippingNotices,
  getShippingNoticeById,
  getShippingNoticeItems,
};
