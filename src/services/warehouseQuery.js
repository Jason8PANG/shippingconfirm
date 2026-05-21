const sql = require('mssql');

const serverName = process.env.MSSQL_SERVER || 'SUZVPRINT01\\CUSTOMSSYS';
const serverHost = serverName.split('\\')[0];
const instanceName = serverName.includes('\\') ? serverName.split('\\')[1] : undefined;

const poolConfig = {
  server: process.env.MSSQL_HOST || serverHost,
  database: process.env.MSSQL_DATABASE || 'csi_datawarehouse',
  user: process.env.MSSQL_USER || 'naipowerbiuser',
  password: process.env.MSSQL_PASSWORD,
  port: process.env.MSSQL_PORT ? parseInt(process.env.MSSQL_PORT) : undefined,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    // 有 MSSQL_HOST 时直接用 IP+端口连接，不需要实例名发现
    instanceName: process.env.MSSQL_HOST ? undefined : instanceName,
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
        drop_Cust_Name AS drop_cust_name,
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
        drop_Cust_Name AS drop_cust_name,
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
 * Location 从 SLPickListLocs 表获取（同一 Sequence 多行用逗号拼接）
 */
async function getShippingNoticeItems(id) {
  const pool = await getPool();
  const result = await pool.request()
    .input('id', sql.Int, parseInt(id))
    .query(`
      SELECT 
        r.Sequence AS sequence,
        r.RefNum AS ref_num,
        r.RefLineSuf AS ref_line_suf,
        r.RefRelease AS ref_release,
        r.Job_Order AS wo_number,
        ISNULL(l.locations, '') AS location,
        r.item AS item_code,
        r.description AS item_name,
        r.QtyToPick AS qty_to_pick,
        r.um,
        r.package_number AS planned_boxes,
        r.package_piece_per_box,
        r.cust_po_num,
        r.cust_po_line,
        r.customer_item,
        r.package_Type AS package_type,
        r.drawing_nbr,
        r.customs_hs_code
      FROM dbo.SLPickListRefs r
      OUTER APPLY (
        SELECT STRING_AGG(LTRIM(RTRIM(l.Loc)), ', ') WITHIN GROUP (ORDER BY l.Loc) AS locations
        FROM dbo.SLPickListLocs l
        WHERE l.PickListId = r.PickListId AND l.Sequence = r.Sequence
      ) l
      WHERE r.PickListId = @id
      ORDER BY r.Sequence
    `);
  return result.recordset;
}

module.exports = {
  getPendingShippingNotices,
  getShippingNoticeById,
  getShippingNoticeItems,
};
