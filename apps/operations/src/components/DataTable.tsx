// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维紧凑数据表
//
//   文件:       DataTable.tsx
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'

export function DataTable<T>({
  data,
  columns,
  empty = '暂无数据',
  getRowId,
}: {
  data: T[]
  columns: ColumnDef<T>[]
  empty?: string
  getRowId?: (row: T) => string
}) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    ...(getRowId ? { getRowId } : {}),
  })
  return (
    <div className="ops-table-wrap">
      <table className="ops-table">
        <thead>
          {table.getHeaderGroups().map(group => (
            <tr key={group.id}>
              {group.headers.map(header => (
                <th key={header.id}>
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr key={row.id}>
              {row.getVisibleCells().map(cell => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
          {!data.length && <tr><td className="ops-table__empty" colSpan={columns.length}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
