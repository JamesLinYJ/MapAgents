// +-------------------------------------------------------------------------
//
//   地理智能平台 - 本机产品显示身份上下文
//
//   文件:       ProductIdentityContext.ts
// --------------------------------------------------------------------------

import { createContext, useContext } from 'react'
import { PRODUCT_CODENAME } from '@geo-agent-platform/shared-types/product-identity'

export interface ProductIdentityContextValue {
  productName: string
  openProductSettings: () => void
}

export const ProductIdentityContext = createContext<ProductIdentityContextValue>({
  productName: PRODUCT_CODENAME,
  openProductSettings: () => undefined,
})

export function useProductIdentity(): ProductIdentityContextValue {
  return useContext(ProductIdentityContext)
}
