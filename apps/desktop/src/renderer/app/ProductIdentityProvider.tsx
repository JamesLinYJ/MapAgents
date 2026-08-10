// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机产品显示身份提供器
//
//   文件:       ProductIdentityProvider.tsx
// --------------------------------------------------------------------------

import { useMemo, type ReactNode } from 'react'

import { ProductIdentityContext } from './ProductIdentityContext'

export function ProductIdentityProvider({
  productName,
  onOpenSettings,
  children,
}: {
  productName: string
  onOpenSettings: () => void
  children: ReactNode
}) {
  const value = useMemo(() => ({
    productName,
    openProductSettings: onOpenSettings,
  }), [onOpenSettings, productName])
  return <ProductIdentityContext.Provider value={value}>{children}</ProductIdentityContext.Provider>
}
